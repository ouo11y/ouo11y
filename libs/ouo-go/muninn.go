package ouogo

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Muninn reads the replay store's API (docs/specs/muninn.md section 7).
type Muninn struct {
	URL       string // base URL, e.g. http://muninn:3400
	Tenant    string // X-Scope-OrgID; "anonymous" when Muninn runs single-tenant
	ReadToken string // bearer for reads, when Muninn has one configured
	// HTTP must not undo Content-Encoding: the default client used when this is nil has
	// DisableCompression set, so a gzip chunk arrives as stored.
	HTTP *http.Client
}

var muninnHTTP = &http.Client{
	Timeout:   30 * time.Second,
	Transport: &http.Transport{DisableCompression: true, Proxy: http.ProxyFromEnvironment},
}

// ReplaySummary is one entry of a session's replay list (Muninn spec 7.1).
type ReplaySummary struct {
	ReplayID    string   `json:"replay_id"`
	State       string   `json:"state"`
	StartTime   int64    `json:"start_time"`
	EndTime     int64    `json:"end_time"`
	ChunkCount  int      `json:"chunk_count"`
	ByteSize    int64    `json:"byte_size"`
	Formats     []string `json:"formats"`
	StreamCount int      `json:"stream_count"`
}

// Manifest is one replay (Muninn spec 7.2). Chunk paths are left out: they are Muninn's
// own URLs, and a caller serves chunks under paths of its own, built from the ids.
type Manifest struct {
	SessionID  string   `json:"session_id"`
	ReplayID   string   `json:"replay_id"`
	Project    string   `json:"project"`
	State      string   `json:"state"`
	StartTime  int64    `json:"start_time"`
	EndTime    int64    `json:"end_time"`
	ChunkCount int      `json:"chunk_count"`
	ByteSize   int64    `json:"byte_size"`
	Streams    []Stream `json:"streams"`
}

// Stream is one stream of a manifest.
type Stream struct {
	StreamID  string          `json:"stream_id"`
	State     string          `json:"state"`
	StartTime int64           `json:"start_time"`
	EndTime   int64           `json:"end_time"`
	End       json.RawMessage `json:"end"`
	Missing   [][2]int64      `json:"missing"`
	Chunks    []Chunk         `json:"chunks"`
}

// Chunk is one chunk's entry in a manifest.
type Chunk struct {
	Sequence     int64  `json:"sequence"`
	SegmentIndex int64  `json:"segment_index"`
	Keyframe     bool   `json:"keyframe"`
	StartTime    int64  `json:"start_time"`
	EndTime      int64  `json:"end_time"`
	Format       string `json:"format"`
	Encoding     string `json:"encoding"`
	ByteSize     int64  `json:"byte_size"`
	SHA256       string `json:"sha256"`
	ReceivedAt   int64  `json:"received_at"`
	// Attributes are every stored chunk attribute without a field of its own (MUN-6). An
	// SDK or a bridge may have put identity here: see redact.Manifest.
	Attributes map[string]any `json:"attributes"`
}

// ChunkBytes is a chunk's body, decompressed when it was stored gzip.
type ChunkBytes struct {
	Format string
	Body   []byte
}

// maxDecompressed bounds a decompressed chunk (stored chunks are at most 1 MiB).
const maxDecompressed = 64 << 20

func (m *Muninn) do(ctx context.Context, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.URL+path, nil)
	if err != nil {
		return nil, err
	}
	tenant := m.Tenant
	if tenant == "" {
		tenant = "anonymous"
	}
	req.Header.Set("X-Scope-OrgID", tenant)
	if m.ReadToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.ReadToken)
	}
	// Explicit, so no transport adds and then undoes it (kb muninn/implementation/gzip-on-the-read-path.md).
	req.Header.Set("Accept-Encoding", "gzip")
	c := m.HTTP
	if c == nil {
		c = muninnHTTP
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, &BackendError{Backend: "muninn", Err: err}
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		resp.Body.Close()
		return nil, &BackendError{Backend: "muninn", Err: fmt.Errorf("%s: %s", resp.Status, b)}
	}
	return resp, nil
}

// getJSON decodes a JSON answer, which Muninn may gzip because the request accepts it.
func (m *Muninn) getJSON(ctx context.Context, path string, v any) error {
	resp, err := m.do(ctx, path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := decoded(resp)
	if err != nil {
		return &BackendError{Backend: "muninn", Err: err}
	}
	if err := json.Unmarshal(body, v); err != nil {
		return &BackendError{Backend: "muninn", Err: fmt.Errorf("decode: %w", err)}
	}
	return nil
}

func decoded(resp *http.Response) ([]byte, error) {
	var r io.Reader = resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		r = zr
	}
	b, err := io.ReadAll(io.LimitReader(r, maxDecompressed+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxDecompressed {
		return nil, errors.New("answer larger than 64 MiB decompressed")
	}
	return b, nil
}

func replaysPath(project, session string) string {
	return "/api/v1/projects/" + project + "/sessions/" + session + "/replays"
}

// ListReplays lists one session's replays (Muninn spec 7.1), never nil.
func (m *Muninn) ListReplays(ctx context.Context, project, session string) ([]ReplaySummary, error) {
	if err := checkProject(project); err != nil {
		return nil, err
	}
	if err := checkID("session", session); err != nil {
		return nil, err
	}
	var a struct {
		Replays []ReplaySummary `json:"replays"`
	}
	if err := m.getJSON(ctx, replaysPath(project, session), &a); err != nil {
		return nil, err
	}
	if a.Replays == nil {
		a.Replays = []ReplaySummary{}
	}
	return a.Replays, nil
}

// Manifest returns one replay's manifest (Muninn spec 7.2). ErrNotFound for an unknown replay.
func (m *Muninn) Manifest(ctx context.Context, project, session, replay string) (*Manifest, error) {
	if err := checkReplayIDs(project, session, replay); err != nil {
		return nil, err
	}
	var a Manifest
	if err := m.getJSON(ctx, replaysPath(project, session)+"/"+replay, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// Chunk returns one chunk's bytes, decompressed (Muninn spec 7.3).
func (m *Muninn) Chunk(ctx context.Context, project, session, replay, stream string, seq int64) (*ChunkBytes, error) {
	if err := checkReplayIDs(project, session, replay); err != nil {
		return nil, err
	}
	if err := checkID("stream", stream); err != nil {
		return nil, err
	}
	if seq < 0 || seq > 999_999_999 {
		return nil, &BadRequestError{Msg: "sequence out of range"}
	}
	path := replaysPath(project, session) + "/" + replay + "/streams/" + stream + "/chunks/" + strconv.FormatInt(seq, 10)
	resp, err := m.do(ctx, path)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := decoded(resp)
	if err != nil {
		return nil, &BackendError{Backend: "muninn", Err: err}
	}
	return &ChunkBytes{Format: resp.Header.Get("X-Ouo-Replay-Format"), Body: body}, nil
}
