package debugfiles

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// DefaultMaxBytes limits one decompressed source map on the read side.
const DefaultMaxBytes = 64 << 20

// tenantOf is the Loki-style tenant of a request ("anonymous" without the header).
func tenantOf(r *http.Request) string {
	if t := r.Header.Get("X-Scope-OrgID"); t != "" {
		return t
	}
	return "anonymous"
}

// Handler is the store's REST API, the shape proposed for Muninn:
//
//	PUT /api/v1/projects/{project}/debug-files/{kind}/{id}[?release=&file=]   201, 200 (same bytes), 409
//	GET /api/v1/projects/{project}/debug-files/{kind}/{id}                    the body as stored
//	GET /api/v1/projects/{project}/debug-files/{kind}?release=&file=          {"debug_ids": [...]}
//
// maxBody limits an upload (compressed bytes).
func Handler(s *FS, maxBody int64) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /api/v1/projects/{project}/debug-files/{kind}/{id}", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
			return
		}
		k := Key{Tenant: tenantOf(r), Project: r.PathValue("project"), Kind: r.PathValue("kind"), DebugID: r.PathValue("id")}
		m, created, err := s.Put(r.Context(), k, r.URL.Query().Get("release"), r.URL.Query().Get("file"), body)
		switch {
		case errors.Is(err, ErrInvalid):
			http.Error(w, err.Error(), http.StatusBadRequest)
		case errors.Is(err, ErrConflict):
			http.Error(w, err.Error(), http.StatusConflict)
		case err != nil:
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
		default:
			w.Header().Set("Content-Type", "application/json")
			if created {
				w.WriteHeader(http.StatusCreated)
			}
			json.NewEncoder(w).Encode(m)
		}
	})
	mux.HandleFunc("GET /api/v1/projects/{project}/debug-files/{kind}/{id}", func(w http.ResponseWriter, r *http.Request) {
		k := Key{Tenant: tenantOf(r), Project: r.PathValue("project"), Kind: r.PathValue("kind"), DebugID: r.PathValue("id")}
		b, err := s.Get(r.Context(), k)
		if errors.Is(err, ErrNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(b)
	})
	mux.HandleFunc("GET /api/v1/projects/{project}/debug-files/{kind}", func(w http.ResponseWriter, r *http.Request) {
		ids, err := s.Candidates(r.Context(), tenantOf(r), r.PathValue("project"), r.URL.Query().Get("release"), r.URL.Query().Get("file"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		if ids == nil {
			ids = []string{}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string][]string{"debug_ids": ids})
	})
	return mux
}

// EdgeHandler stands in for the Collector's upload route. It accepts the
// request `ouo-sourcemaps upload` sends today (PUT /v1/sourcemaps with the
// project's upload token, gzip body, ?file=&debug_id=&release=), finds the
// project of the token, and passes the body on to the store unread. An
// upload without a debug id gets the content id of its bytes.
func EdgeHandler(store *Client, uploadTokens map[string]string, maxBody int64) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("PUT /v1/sourcemaps", func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		project := ""
		for t, p := range uploadTokens {
			if subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1 {
				project = p
			}
		}
		if project == "" {
			http.Error(w, "unknown upload token", http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
			return
		}
		q := r.URL.Query()
		id := q.Get("debug_id")
		if id == "" {
			id = ContentDebugID(body)
		}
		status, resp, err := store.Put(r.Context(), project, KindSourceMap, id, q.Get("release"), q.Get("file"), body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		// The store's answer is the CLI's answer: CI fails when the file was not stored.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write(resp)
	})
	return mux
}

// Client reads and writes debug files over the REST API. It is what ouo-go
// holds: Map and Candidates make it a symbolicate.Source.
type Client struct {
	BaseURL  string
	Tenant   string
	HTTP     *http.Client
	MaxBytes int64 // decompressed limit of one map (0: DefaultMaxBytes)
}

func (c *Client) do(ctx context.Context, method, p string, q url.Values, body []byte) (*http.Response, error) {
	u := strings.TrimRight(c.BaseURL, "/") + p
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if c.Tenant != "" {
		req.Header.Set("X-Scope-OrgID", c.Tenant)
	}
	h := c.HTTP
	if h == nil {
		h = http.DefaultClient
	}
	return h.Do(req)
}

func filePath(project, kind, id string) string {
	p := "/api/v1/projects/" + url.PathEscape(project) + "/debug-files/" + url.PathEscape(kind)
	if id != "" {
		p += "/" + url.PathEscape(id)
	}
	return p
}

// Put uploads one file and returns the store's status and response body.
func (c *Client) Put(ctx context.Context, project, kind, id, release, file string, body []byte) (int, []byte, error) {
	q := url.Values{}
	if release != "" {
		q.Set("release", release)
	}
	if file != "" {
		q.Set("file", file)
	}
	res, err := c.do(ctx, http.MethodPut, filePath(project, kind, id), q, body)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, b, nil
}

// Map returns the decompressed source map of a debug id, or ErrNotFound.
func (c *Client) Map(ctx context.Context, project, debugID string) ([]byte, error) {
	res, err := c.do(ctx, http.MethodGet, filePath(project, KindSourceMap, debugID), nil, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusBadRequest {
		return nil, ErrNotFound
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("debug file store: %s", res.Status)
	}
	zr, err := gzip.NewReader(res.Body)
	if err != nil {
		return nil, err
	}
	max := c.MaxBytes
	if max <= 0 {
		max = DefaultMaxBytes
	}
	b, err := io.ReadAll(io.LimitReader(zr, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("source map above %d bytes", max)
	}
	return b, nil
}

// Candidates returns the debug ids uploaded for a release and URL path.
func (c *Client) Candidates(ctx context.Context, project, release, urlPath string) ([]string, error) {
	res, err := c.do(ctx, http.MethodGet, filePath(project, KindSourceMap, ""), url.Values{"release": {release}, "file": {urlPath}}, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("debug file store: %s", res.Status)
	}
	var out struct {
		DebugIDs []string `json:"debug_ids"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.DebugIDs, nil
}
