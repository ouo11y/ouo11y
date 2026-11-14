package muninn

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
)

// Debug files, docs/specs/muninn.md section 13 (ADR-0026).

var (
	reDebugID = regexp.MustCompile(`^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$`)
	kinds     = map[string]bool{"sourcemap": true, "dsym": true, "proguard": true}
)

// uploadTimeout replaces the server's 60 s read and write timeouts for one
// upload: a dSYM slice near its limit takes minutes from CI.
const uploadTimeout = 10 * time.Minute

// maxUploads bounds the debug-file uploads one Muninn holds in memory at once (DBG-5):
// a dSYM is up to 512 MiB decompressed plus its gzip copy, and Muninn also takes replays.
const maxUploads = 4

// maxReleaseBytes bounds the release and file query values.
const maxReleaseBytes = 1024

// debugMeta is the meta object of section 13.1.
type debugMeta struct {
	Kind       string `json:"kind"`
	DebugID    string `json:"debug_id"`
	SHA256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	Release    string `json:"release,omitempty"`
	File       string `json:"file,omitempty"`
	UploadedAt int64  `json:"uploaded_at"`
}

// normalizeDebugID lowercases a UUID and puts the dashes back.
func normalizeDebugID(id string) (string, bool) {
	if !reDebugID.MatchString(id) {
		return "", false
	}
	h := strings.ToLower(strings.ReplaceAll(id, "-", ""))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], true
}

// urlPath normalises a script URL to the lookup path of section 13.1.
func urlPath(raw string) string {
	p := raw
	if u, err := url.Parse(raw); err == nil && (u.Scheme != "" || u.Host != "") {
		p = u.Path
	} else {
		p, _, _ = strings.Cut(p, "?")
		p, _, _ = strings.Cut(p, "#")
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return path.Clean(p)
}

func hashHex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func (k keys) debugProject(t, p string) string    { return k.debug + t + "/" + p + "/" }
func (k keys) debugKind(t, p, kind string) string { return k.debugProject(t, p) + kind + "/" }
func (k keys) debugFile(t, p, kind, id string) string {
	return k.debugKind(t, p, kind) + id
}
func (k keys) debugPointers(t, p, release, file, kind string) string {
	return k.debugProject(t, p) + "release/" + hashHex(release) + "/" + hashHex(urlPath(file)) + "/" + kind + "/"
}

// uploadTenant returns the tenant of the upload token the request carries for
// project (DBG-1, DBG-2). Every token is compared, so timing says nothing.
func (s *Server) uploadTenant(r *http.Request, project string) (string, bool) {
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || got == "" {
		return "", false
	}
	tenant, found := "", false
	for _, t := range s.cfg.DebugFiles.UploadTokens {
		if subtle.ConstantTimeCompare([]byte(got), []byte(t.Token)) == 1 && t.Project == project {
			tenant, found = t.Tenant, true
		}
	}
	if !s.cfg.MultitenancyEnabled {
		tenant = "anonymous"
	}
	return tenant, found
}

// counted wraps a handler with the read-request metrics and the 503 on panic.
func (s *Server) counted(route string, h http.HandlerFunc) http.Handler {
	return recoverWith(http.StatusServiceUnavailable, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cw := &countingWriter{ResponseWriter: w}
		defer func() {
			attrs := metric.WithAttributes(attribute.String("route", route), attribute.Int("http.response.status_code", cw.status))
			s.m.readRequests.Add(r.Context(), 1, attrs)
			s.m.readBytes.Add(r.Context(), cw.n, attrs)
		}()
		h(cw, r)
	}))
}

// private checks the read (or admin) token and the tenant of a private route (section 7).
func (s *Server) private(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !s.readOK(r) {
		writeError(w, r, http.StatusUnauthorized, "unauthorized")
		return "", false
	}
	return s.tenantOf(w, r)
}

// admin checks the admin token and the tenant of an admin route (MUN-45, section 14).
func (s *Server) admin(w http.ResponseWriter, r *http.Request) (string, bool) {
	if !adminOK(r, s.cfg.Auth.AdminToken) {
		writeError(w, r, http.StatusUnauthorized, "unauthorized")
		return "", false
	}
	return s.tenantOf(w, r)
}

func (s *Server) tenantOf(w http.ResponseWriter, r *http.Request) (string, bool) {
	tenant, code := s.tenant(r)
	if code != 0 {
		writeError(w, r, code, "bad or missing X-Scope-OrgID")
		return "", false
	}
	return tenant, true
}

type debugReq struct {
	tenant, project, kind, id string
}

// debugPath validates {project}, {kind} and {id} (when present).
func debugPath(w http.ResponseWriter, r *http.Request) (debugReq, bool) {
	d := debugReq{project: r.PathValue("project"), kind: r.PathValue("kind")}
	if !reProject.MatchString(d.project) || !kinds[d.kind] {
		writeError(w, r, http.StatusBadRequest, "malformed project or kind")
		return d, false
	}
	if raw := r.PathValue("id"); raw != "" {
		id, ok := normalizeDebugID(raw)
		if !ok {
			writeError(w, r, http.StatusBadRequest, "debug id is not a UUID")
			return d, false
		}
		d.id = id
	}
	return d, true
}

// PUT /api/v1/projects/{project}/debug-files/{kind}/{id}[?release=&file=] (section 13.2).
func (s *Server) putDebugFile(w http.ResponseWriter, r *http.Request) {
	d, ok := debugPath(w, r)
	if !ok {
		return
	}
	tenant, ok := s.uploadTenant(r, d.project)
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "unauthorized")
		return
	}
	d.tenant = tenant
	select {
	case s.uploads <- struct{}{}:
		defer func() { <-s.uploads }()
	default:
		w.Header().Set("Retry-After", "10")
		writeError(w, r, http.StatusServiceUnavailable, fmt.Sprintf("%d uploads in progress, retry later", maxUploads))
		return
	}
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(uploadTimeout))
	_ = rc.SetWriteDeadline(time.Now().Add(uploadTimeout))
	q := r.URL.Query()
	release, file := q.Get("release"), q.Get("file")
	if len(release) > maxReleaseBytes || len(file) > maxReleaseBytes || (file != "" && release == "") {
		writeError(w, r, http.StatusBadRequest, "release and file are at most 1024 bytes, and file needs a release")
		return
	}
	content, status, msg := readDebugBody(r, s.cfg.DebugFiles.MaxBytesFor(d.kind))
	if status != 0 {
		writeError(w, r, status, msg)
		return
	}
	sum := sha256.Sum256(content)
	meta := debugMeta{Kind: d.kind, DebugID: d.id, SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(content)),
		Release: release, UploadedAt: s.now().UnixMilli()}
	if file != "" {
		meta.File = urlPath(file)
	}
	stored, created, err := s.storeDebugFile(r.Context(), d, content, meta)
	switch {
	case errors.Is(err, errConflict):
		writeError(w, r, http.StatusConflict, "debug id "+d.id+" already holds a "+d.kind+" with other content")
		return
	case err != nil:
		w.Header().Set("Retry-After", "5")
		storeFailure(w, r, err)
		return
	}
	if release != "" && file != "" {
		pk := s.keys.debugPointers(d.tenant, d.project, release, file, d.kind) + d.id
		if err := s.store.Create(r.Context(), pk, nil, s.debugTags(d.project)); err != nil && !errors.Is(err, store.ErrExists) {
			w.Header().Set("Retry-After", "5")
			storeFailure(w, r, err)
			return
		}
	}
	if !created {
		// DBG-20: a re-upload restarts the retention; the file itself stays write-once.
		seen, _ := json.Marshal(map[string]int64{"uploaded_at": s.now().UnixMilli()})
		if err := s.store.Put(r.Context(), s.keys.debugFile(d.tenant, d.project, d.kind, d.id)+".seen", seen); err != nil {
			w.Header().Set("Retry-After", "5")
			storeFailure(w, r, err)
			return
		}
	}
	code := http.StatusOK
	if created {
		code = http.StatusCreated
		slog.InfoContext(r.Context(), "debug file stored", "tenant", d.tenant, "ouo.project.id", d.project,
			"kind", d.kind, "debug_id", d.id, "bytes", meta.Bytes)
	}
	writeJSON(w, r, code, stored)
}

var errConflict = errors.New("other content under the same key")

// debugBody reports whether key, relative to a project's debug-file prefix, is a file
// body (<kind>/<id>), not its meta, its .seen or a pointer; it returns kind/id.
func debugBody(rel string) (string, bool) {
	kind, id, ok := strings.Cut(rel, "/")
	if !ok || !kinds[kind] || strings.ContainsAny(id, "/.") {
		return "", false
	}
	return rel, true
}

// readDebugBody reads and, for Content-Encoding gzip, decompresses the body up to
// limit bytes (DBG-3). status is 0 on success.
func readDebugBody(r *http.Request, limit int64) ([]byte, int, string) {
	// A compressed body of incompressible data is a little larger than its content.
	body := http.MaxBytesReader(nil, r.Body, limit+limit/64+(1<<16))
	var src io.Reader = body
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding"))) {
	case "", "identity":
	case "gzip":
		zr, err := gzip.NewReader(body)
		if err != nil {
			return nil, http.StatusBadRequest, "body is not gzip"
		}
		src = zr
	default:
		return nil, http.StatusUnsupportedMediaType, "Content-Encoding must be gzip or none"
	}
	b, err := io.ReadAll(io.LimitReader(src, limit+1))
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge) || int64(len(b)) > limit:
		return nil, http.StatusRequestEntityTooLarge, fmt.Sprintf("file is larger than %d bytes", limit)
	case err != nil:
		return nil, http.StatusBadRequest, "body could not be read: " + err.Error()
	case len(b) == 0:
		return nil, http.StatusBadRequest, "empty body"
	}
	return b, 0, ""
}

// storeDebugFile writes the file, then its meta (DBG-4). For a key that exists it
// compares the content: equal gives the stored meta, other content errConflict.
// A meta missing after a crash between the two writes is written again.
func (s *Server) storeDebugFile(ctx context.Context, d debugReq, content []byte, meta debugMeta) (debugMeta, bool, error) {
	fk := s.keys.debugFile(d.tenant, d.project, d.kind, d.id)
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(content)
	_ = zw.Close()
	tags := s.debugTags(d.project)
	err := s.store.Create(ctx, fk, gz.Bytes(), tags)
	created := err == nil
	if err != nil && !errors.Is(err, store.ErrExists) {
		return meta, false, err
	}
	if !created {
		old, err := s.store.Get(ctx, fk)
		if err != nil {
			return meta, false, err
		}
		plain, err := gunzip(old)
		if err != nil {
			return meta, false, fmt.Errorf("stored %s: %w", fk, err)
		}
		if !bytes.Equal(plain, content) {
			return meta, false, errConflict
		}
	}
	mb, _ := json.Marshal(meta)
	if err := s.store.Create(ctx, fk+".json", mb, tags); err != nil && !errors.Is(err, store.ErrExists) {
		return meta, false, err
	}
	if !created {
		if b, err := s.store.Get(ctx, fk+".json"); err == nil {
			var m debugMeta
			if json.Unmarshal(b, &m) == nil {
				meta = m
			}
		}
	}
	return meta, created, nil
}

func gunzip(b []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(zr)
}

// debugTags: ouo-retention=<days>d or keep (DBG-20).
func (s *Server) debugTags(project string) map[string]string {
	ret := s.cfg.DebugFiles.RetentionFor(project)
	if ret <= 0 {
		return map[string]string{"ouo-retention": "keep"}
	}
	return map[string]string{"ouo-retention": fmt.Sprintf("%dd", int(math.Ceil(ret.Hours()/24)))}
}

// debugRead wraps the private debug-file reads (DBG-10).
func (s *Server) debugRead(h func(http.ResponseWriter, *http.Request, debugReq)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant, ok := s.private(w, r)
		if !ok {
			return
		}
		d, ok := debugPath(w, r)
		if !ok {
			return
		}
		d.tenant = tenant
		h(w, r, d)
	}
}

// GET .../debug-files/{kind}/{id}.
func (s *Server) getDebugFile(w http.ResponseWriter, r *http.Request, d debugReq) {
	b, err := s.store.Get(r.Context(), s.keys.debugFile(d.tenant, d.project, d.kind, d.id))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "debug file not found")
		return
	}
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Add("Vary", "Accept-Encoding")
	if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
	} else if b, err = gunzip(b); err != nil {
		storeFailure(w, r, err)
		return
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

// GET .../debug-files/{kind}/{id}/meta.
func (s *Server) getDebugMeta(w http.ResponseWriter, r *http.Request, d debugReq) {
	b, err := s.store.Get(r.Context(), s.keys.debugFile(d.tenant, d.project, d.kind, d.id)+".json")
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "debug file not found")
		return
	}
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, json.RawMessage(b))
}

// GET .../debug-files/{kind}[?release=&file=] (DBG-11).
func (s *Server) listDebugFiles(w http.ResponseWriter, r *http.Request, d debugReq) {
	q := r.URL.Query()
	release, file := q.Get("release"), q.Get("file")
	if (release == "") != (file == "") {
		writeError(w, r, http.StatusBadRequest, "release and file go together")
		return
	}
	if release != "" {
		objs, err := s.store.List(r.Context(), s.keys.debugPointers(d.tenant, d.project, release, file, d.kind))
		if err != nil {
			storeFailure(w, r, err)
			return
		}
		ids := []string{}
		for _, o := range objs {
			ids = append(ids, path.Base(o.Key))
		}
		slices.Sort(ids)
		writeJSON(w, r, http.StatusOK, map[string]any{"debug_ids": slices.Compact(ids)})
		return
	}
	prefix := s.keys.debugKind(d.tenant, d.project, d.kind)
	objs, err := s.store.List(r.Context(), prefix)
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	type entry struct {
		DebugID    string `json:"debug_id"`
		Bytes      int64  `json:"bytes"`
		UploadedAt int64  `json:"uploaded_at"`
	}
	out := []entry{}
	for _, o := range objs {
		id := strings.TrimPrefix(o.Key, prefix)
		if strings.Contains(id, "/") || strings.Contains(id, ".") {
			continue // meta (.json) or last re-upload (.seen)
		}
		out = append(out, entry{DebugID: id, Bytes: o.Size, UploadedAt: o.Modified.UnixMilli()})
	}
	slices.SortFunc(out, func(a, b entry) int { return strings.Compare(a.DebugID, b.DebugID) })
	writeJSON(w, r, http.StatusOK, map[string]any{"debug_files": out})
}

// sweepDebugFiles deletes files older than their project's retention, with their
// meta and pointers (DBG-20). Pointers are found by the id they name.
func (s *Server) sweepDebugFiles(ctx context.Context, now time.Time) error {
	objs, err := s.store.List(ctx, s.keys.debug)
	if err != nil {
		return err
	}
	type file struct {
		tenant, project string
		uploaded, seen  time.Time // body written; last re-upload (.seen)
		keys            []string
	}
	files := map[string]*file{} // tenant/project/kind/id
	for _, o := range objs {
		parts := strings.Split(strings.TrimPrefix(o.Key, s.keys.debug), "/")
		var id string
		switch {
		case len(parts) == 4 && kinds[parts[2]]: // t/p/kind/id[.json|.seen]
			base, _, _ := strings.Cut(parts[3], ".")
			id = strings.Join(parts[:3], "/") + "/" + base
		case len(parts) == 7 && parts[2] == "release": // t/p/release/h/h/kind/id
			id = strings.Join(parts[:2], "/") + "/" + parts[5] + "/" + parts[6]
		default:
			continue
		}
		f := files[id]
		if f == nil {
			f = &file{tenant: parts[0], project: parts[1]}
			files[id] = f
		}
		f.keys = append(f.keys, o.Key)
		switch {
		case len(parts) == 4 && strings.HasSuffix(parts[3], ".seen"):
			f.seen = o.Modified
		case len(parts) == 4 && !strings.Contains(parts[3], "."):
			f.uploaded = o.Modified
		}
	}
	var errs []error
	for _, f := range files {
		ret := s.cfg.DebugFiles.RetentionFor(f.project)
		last := f.uploaded
		if f.seen.After(last) {
			last = f.seen
		}
		if ret <= 0 || f.uploaded.IsZero() || now.Sub(last) < ret {
			continue // a pointer or meta without its file is left to the file's own upload
		}
		for _, k := range f.keys {
			errs = append(errs, s.store.Delete(ctx, k))
		}
		s.m.swept.Add(ctx, 1, metric.WithAttributes(attribute.String("ouo.project.id", f.project), attribute.String("reason", "debug_file_retention")))
	}
	return errors.Join(errs...)
}
