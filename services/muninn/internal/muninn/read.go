package muninn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
)

// mediaTypes is the media type per format id for GET .../chunks/{seq} (section 7.3).
// The registry belongs to the SDK spec section 11.6 (Q10), which has no media types
// yet; anything not listed is application/octet-stream.
var mediaTypes = map[string]string{
	"rrweb/2": "application/x-ndjson", // newline-delimited rrweb events (Q10 recommendation)
}

type readCtx struct {
	tenant, project, session string
}

// api wraps a read or delete route: token, tenant, path identifiers, metrics.
func (s *Server) api(route string, h func(http.ResponseWriter, *http.Request, readCtx)) http.Handler {
	return recoverWith(http.StatusServiceUnavailable, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cw := &countingWriter{ResponseWriter: w}
		defer func() {
			attrs := metric.WithAttributes(attribute.String("route", route), attribute.Int("http.response.status_code", cw.status))
			s.m.readRequests.Add(r.Context(), 1, attrs)
			s.m.readBytes.Add(r.Context(), cw.n, attrs)
		}()
		if !bearerOK(r, s.cfg.Auth.ReadToken) {
			writeError(cw, r, http.StatusUnauthorized, "unauthorized")
			return
		}
		tenant, code := s.tenant(r)
		if code != 0 {
			writeError(cw, r, code, "bad or missing X-Scope-OrgID")
			return
		}
		rc := readCtx{tenant: tenant, project: r.PathValue("project"), session: r.PathValue("session")}
		if !reProject.MatchString(rc.project) || !reHex32.MatchString(rc.session) {
			writeError(cw, r, http.StatusBadRequest, "malformed project or session id")
			return
		}
		for _, p := range []string{"replay", "stream"} {
			if v := r.PathValue(p); v != "" && !reHex32.MatchString(v) {
				writeError(cw, r, http.StatusBadRequest, "malformed "+p+" id")
				return
			}
		}
		h(cw, r, rc)
	}))
}

func storeFailure(w http.ResponseWriter, r *http.Request, err error) {
	slog.WarnContext(r.Context(), "store failure", "err", err)
	writeError(w, r, http.StatusServiceUnavailable, "store unavailable")
}

// header returns a chunk's header, from the cache or a ranged read.
func (s *Server) header(ctx context.Context, key string) (header, error) {
	s.mu.Lock()
	h, ok := s.headers[key]
	s.mu.Unlock()
	if ok {
		return h, nil
	}
	const guess = 32 << 10
	b, err := s.store.GetRange(ctx, key, 0, guess)
	if err != nil {
		return h, err
	}
	n, err := headerLen(b)
	if err != nil {
		return h, fmt.Errorf("%s: %w", key, err) // wraps errCorrupt
	}
	if n > len(b) {
		if b, err = s.store.GetRange(ctx, key, 0, int64(n)); err != nil {
			return h, err
		}
	}
	if h, _, err = decodeChunk(b[:min(n, len(b))]); err != nil {
		return h, fmt.Errorf("%s: %w", key, err)
	}
	s.mu.Lock()
	if len(s.headers) > 200_000 { // crude bound; headers are cheap to read again
		clear(s.headers)
	}
	s.headers[key] = h
	s.mu.Unlock()
	return h, nil
}

// --- manifest (section 7.2) ---------------------------------------------------------

type endInfo struct {
	EndState     string `json:"end_state"`
	EndReason    string `json:"end_reason"`
	LastSequence *int64 `json:"last_sequence,omitempty"`
	TimeUnixNano string `json:"time_unix_nano"`
}

type chunkInfo struct {
	Sequence     int64          `json:"sequence"`
	SegmentIndex int64          `json:"segment_index"`
	Keyframe     bool           `json:"keyframe"`
	StartTime    int64          `json:"start_time"`
	EndTime      int64          `json:"end_time"`
	Format       string         `json:"format"`
	Encoding     string         `json:"encoding"`
	ByteSize     int64          `json:"byte_size"`
	SHA256       string         `json:"sha256"`
	ReceivedAt   int64          `json:"received_at"`
	Attributes   map[string]any `json:"attributes"`
	Path         string         `json:"path"`
}

type streamInfo struct {
	StreamID  string      `json:"stream_id"`
	State     string      `json:"state"`
	StartTime *int64      `json:"start_time"`
	EndTime   *int64      `json:"end_time"`
	End       *endInfo    `json:"end"`
	Missing   [][2]int64  `json:"missing"`
	Chunks    []chunkInfo `json:"chunks"`
}

type replayInfo struct {
	SessionID  string       `json:"session_id"`
	ReplayID   string       `json:"replay_id"`
	Project    string       `json:"project"`
	State      string       `json:"state"`
	StartTime  *int64       `json:"start_time"`
	EndTime    *int64       `json:"end_time"`
	ChunkCount int          `json:"chunk_count"`
	ByteSize   int64        `json:"byte_size"`
	Streams    []streamInfo `json:"streams"`
}

var errDeleted = errors.New("replay deleted")

// buildReplay computes a replay's manifest from the objects listed under its prefix.
// It returns errDeleted for a tombstoned replay and nil, nil when nothing is held.
func (s *Server) buildReplay(ctx context.Context, rc readCtx, replay string, objs []store.Object) (*replayInfo, error) {
	prefix := s.keys.replay(rc.tenant, rc.project, rc.session, replay)
	streams := map[string]*streamInfo{}
	maxRecv := map[string]int64{}
	stream := func(id string) *streamInfo {
		st := streams[id]
		if st == nil {
			st = &streamInfo{StreamID: id, Missing: [][2]int64{}, Chunks: []chunkInfo{}}
			streams[id] = st
		}
		return st
	}
	for _, o := range objs {
		rest := strings.TrimPrefix(o.Key, prefix)
		if rest == "deleted.json" {
			return nil, errDeleted
		}
		parts := strings.Split(rest, "/")
		if len(parts) < 2 || !reHex32.MatchString(parts[0]) {
			continue
		}
		switch {
		case len(parts) == 2 && parts[1] == "ended.json":
			b, err := s.store.Get(ctx, o.Key)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return nil, err
			}
			var h header
			d := json.NewDecoder(strings.NewReader(string(b)))
			d.UseNumber()
			if err := d.Decode(&h); err != nil {
				slog.WarnContext(ctx, "skipping unreadable object", "key", o.Key, "err", err)
				continue // one bad object must not hide the rest of the session
			}
			e := &endInfo{EndState: attrString(h.Attributes, "ouo.replay.end_state"), EndReason: attrString(h.Attributes, "ouo.replay.end_reason"), TimeUnixNano: h.TimeUnixNano}
			if n, ok := attrInt(h.Attributes, "ouo.replay.last_sequence"); ok {
				e.LastSequence = &n
			}
			stream(parts[0]).End = e
		case len(parts) == 3 && parts[1] == "c":
			seq, ok := parseSeq(parts[2])
			if !ok {
				continue
			}
			h, err := s.header(ctx, o.Key)
			if errors.Is(err, store.ErrNotFound) {
				continue // deleted between list and read
			}
			if errors.Is(err, errCorrupt) {
				slog.WarnContext(ctx, "skipping unreadable object", "key", o.Key, "err", err)
				continue
			}
			if err != nil {
				return nil, err
			}
			c := chunkInfo{Sequence: seq, Attributes: map[string]any{}, ReceivedAt: h.ReceivedAt,
				Format: attrString(h.Attributes, "ouo.replay.format"), Encoding: attrString(h.Attributes, "ouo.replay.encoding"),
				SHA256: attrString(h.Attributes, "ouo.replay.sha256"), Keyframe: attrBool(h.Attributes, "ouo.replay.keyframe"),
				Path: fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays/%s/streams/%s/chunks/%d", rc.project, rc.session, replay, parts[0], seq)}
			c.SegmentIndex, _ = attrInt(h.Attributes, "ouo.replay.segment.index")
			c.StartTime, _ = attrInt(h.Attributes, "ouo.replay.start_time")
			c.EndTime, _ = attrInt(h.Attributes, "ouo.replay.end_time")
			c.ByteSize, _ = attrInt(h.Attributes, "ouo.replay.byte_size")
			for k, v := range h.Attributes {
				if !chunkFields[k] {
					c.Attributes[k] = v
				}
			}
			st := stream(parts[0])
			st.Chunks = append(st.Chunks, c)
			maxRecv[parts[0]] = max(maxRecv[parts[0]], h.ReceivedAt)
		}
	}
	if len(streams) == 0 {
		return nil, nil
	}

	ri := &replayInfo{SessionID: rc.session, ReplayID: replay, Project: rc.project, Streams: []streamInfo{}}
	idle := s.now().Add(-s.cfg.StreamIdleTimeout).UnixMilli()
	anyOpen, allComplete := false, true
	for _, st := range streams {
		slices.SortFunc(st.Chunks, func(a, b chunkInfo) int { return int(a.Sequence - b.Sequence) })
		top := int64(-1)
		for _, c := range st.Chunks {
			st.StartTime = minPtr(st.StartTime, c.StartTime)
			st.EndTime = maxPtr(st.EndTime, c.EndTime)
			ri.ChunkCount++
			ri.ByteSize += c.ByteSize
			top = c.Sequence
		}
		if st.End != nil && st.End.LastSequence != nil {
			top = max(top, *st.End.LastSequence)
		}
		next := int64(0)
		for _, c := range st.Chunks {
			if c.Sequence > next {
				st.Missing = append(st.Missing, [2]int64{next, c.Sequence - 1})
			}
			next = c.Sequence + 1
		}
		if next <= top {
			st.Missing = append(st.Missing, [2]int64{next, top})
		}
		// MUN-30 to MUN-32.
		switch {
		case st.End != nil && st.End.EndState == "complete" && st.End.LastSequence != nil && len(st.Missing) == 0:
			st.State = "complete"
		case st.End == nil && len(st.Chunks) > 0 && maxRecv[st.StreamID] >= idle:
			st.State = "open"
		default:
			st.State = "partial"
		}
		anyOpen = anyOpen || st.State == "open"
		allComplete = allComplete && st.State == "complete"
		if st.StartTime != nil {
			ri.StartTime = minPtr(ri.StartTime, *st.StartTime)
			ri.EndTime = maxPtr(ri.EndTime, *st.EndTime)
		}
		ri.Streams = append(ri.Streams, *st)
	}
	// MUN-33.
	switch {
	case anyOpen:
		ri.State = "open"
	case allComplete:
		ri.State = "complete"
	default:
		ri.State = "partial"
	}
	slices.SortFunc(ri.Streams, func(a, b streamInfo) int { return cmpPtr(a.StartTime, b.StartTime) })
	return ri, nil
}

func minPtr(p *int64, v int64) *int64 {
	if p == nil || v < *p {
		return &v
	}
	return p
}
func maxPtr(p *int64, v int64) *int64 {
	if p == nil || v > *p {
		return &v
	}
	return p
}
func cmpPtr(a, b *int64) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	}
	return int(*a - *b)
}

// replays groups a session listing by replay id.
func (s *Server) replays(ctx context.Context, rc readCtx) (map[string][]store.Object, error) {
	prefix := s.keys.session(rc.tenant, rc.project, rc.session)
	objs, err := s.store.List(ctx, prefix)
	if err != nil {
		return nil, err
	}
	out := map[string][]store.Object{}
	for _, o := range objs {
		id, _, _ := strings.Cut(strings.TrimPrefix(o.Key, prefix), "/")
		if reHex32.MatchString(id) {
			out[id] = append(out[id], o)
		}
	}
	return out, nil
}

type replaySummary struct {
	ReplayID    string   `json:"replay_id"`
	State       string   `json:"state"`
	StartTime   *int64   `json:"start_time"`
	EndTime     *int64   `json:"end_time"`
	ChunkCount  int      `json:"chunk_count"`
	ByteSize    int64    `json:"byte_size"`
	Formats     []string `json:"formats"`
	StreamCount int      `json:"stream_count"`
}

// GET .../sessions/{session}/replays (section 7.1).
func (s *Server) listReplays(w http.ResponseWriter, r *http.Request, rc readCtx) {
	groups, err := s.replays(r.Context(), rc)
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	out := []replaySummary{}
	for id, objs := range groups {
		ri, err := s.buildReplay(r.Context(), rc, id, objs)
		if errors.Is(err, errDeleted) || (err == nil && ri == nil) {
			continue
		}
		if err != nil {
			storeFailure(w, r, err)
			return
		}
		sum := replaySummary{ReplayID: id, State: ri.State, StartTime: ri.StartTime, EndTime: ri.EndTime,
			ChunkCount: ri.ChunkCount, ByteSize: ri.ByteSize, Formats: []string{}, StreamCount: len(ri.Streams)}
		for _, st := range ri.Streams {
			for _, c := range st.Chunks {
				if !slices.Contains(sum.Formats, c.Format) {
					sum.Formats = append(sum.Formats, c.Format)
				}
			}
		}
		slices.Sort(sum.Formats)
		out = append(out, sum)
	}
	slices.SortFunc(out, func(a, b replaySummary) int {
		if c := cmpPtr(a.StartTime, b.StartTime); c != 0 {
			return c
		}
		return strings.Compare(a.ReplayID, b.ReplayID)
	})
	writeJSON(w, r, http.StatusOK, map[string]any{"session_id": rc.session, "replays": out})
}

// GET .../replays/{replay} (section 7.2).
func (s *Server) getReplay(w http.ResponseWriter, r *http.Request, rc readCtx) {
	replay := r.PathValue("replay")
	objs, err := s.store.List(r.Context(), s.keys.replay(rc.tenant, rc.project, rc.session, replay))
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	ri, err := s.buildReplay(r.Context(), rc, replay, objs)
	if errors.Is(err, errDeleted) || (err == nil && ri == nil) {
		writeError(w, r, http.StatusNotFound, "replay not found")
		return
	}
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	writeJSON(w, r, http.StatusOK, ri)
}

// GET .../streams/{stream}/chunks/{seq} (section 7.3). The body goes out as stored,
// never decompressed (MUN-34).
func (s *Server) getChunk(w http.ResponseWriter, r *http.Request, rc readCtx) {
	replay, stream := r.PathValue("replay"), r.PathValue("stream")
	seq, ok := parseSeq(r.PathValue("seq"))
	if !ok {
		writeError(w, r, http.StatusBadRequest, "malformed sequence")
		return
	}
	ctx := r.Context()
	if _, err := s.store.GetRange(ctx, s.keys.tombstone(rc.tenant, rc.project, rc.session, replay), 0, 1); err == nil {
		writeError(w, r, http.StatusNotFound, "chunk not found") // MUN-43
		return
	} else if !errors.Is(err, store.ErrNotFound) {
		storeFailure(w, r, err)
		return
	}
	b, err := s.store.Get(ctx, s.keys.chunk(rc.tenant, rc.project, rc.session, replay, stream, seq))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, r, http.StatusNotFound, "chunk not found")
		return
	}
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	h, body, err := decodeChunk(b)
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	format := attrString(h.Attributes, "ouo.replay.format")
	ct := mediaTypes[format]
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	if attrString(h.Attributes, "ouo.replay.encoding") == "gzip" {
		w.Header().Set("Content-Encoding", "gzip")
	}
	w.Header().Set("ETag", `"`+attrString(h.Attributes, "ouo.replay.sha256")+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("X-Ouo-Replay-Format", format)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// --- delete (section 8) -------------------------------------------------------------

// DELETE .../replays/{replay}.
func (s *Server) deleteReplay(w http.ResponseWriter, r *http.Request, rc readCtx) {
	if err := s.removeReplay(r.Context(), rc, r.PathValue("replay"), "api"); err != nil {
		storeFailure(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DELETE .../sessions/{session}/replays: each replay gets its own tombstone (MUN-41).
func (s *Server) deleteSession(w http.ResponseWriter, r *http.Request, rc readCtx) {
	groups, err := s.replays(r.Context(), rc)
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	for id := range groups {
		if err := s.removeReplay(r.Context(), rc, id, "api"); err != nil {
			storeFailure(w, r, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeReplay writes the tombstone, then removes everything else under the replay
// prefix (MUN-40). Idempotent.
func (s *Server) removeReplay(ctx context.Context, rc readCtx, replay, by string) error {
	tk := s.keys.tombstone(rc.tenant, rc.project, rc.session, replay)
	tomb, _ := json.Marshal(map[string]any{"deleted_at": s.now().UnixMilli(), "by": by})
	if err := s.store.Create(ctx, tk, tomb, s.retentionTags(rc.project)); err != nil && !errors.Is(err, store.ErrExists) {
		return err
	}
	n, err := s.purge(ctx, s.keys.replay(rc.tenant, rc.project, rc.session, replay), tk)
	if err != nil {
		return err
	}
	// MUN-44: best effort audit record through the Collector (slog -> OTLP logs).
	slog.InfoContext(ctx, "replay deleted", "tenant", rc.tenant, "ouo.project.id", rc.project,
		"session.id", rc.session, "ouo.replay.id", replay, "objects_removed", n, "by", by)
	return nil
}

// DELETE /api/v1/projects/{project} (MUN-45): every replay with its tombstone, then
// every debug file of the project.
func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	tenant, ok := s.private(w, r)
	if !ok {
		return
	}
	project := r.PathValue("project")
	if !reProject.MatchString(project) {
		writeError(w, r, http.StatusBadRequest, "malformed project id")
		return
	}
	ctx := r.Context()
	objs, err := s.store.List(ctx, s.keys.root+tenant+"/"+project+"/")
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	type rep struct{ session, replay string }
	seen := map[rep]bool{}
	for _, o := range objs {
		parts := strings.Split(strings.TrimPrefix(o.Key, s.keys.root+tenant+"/"+project+"/"), "/")
		if len(parts) < 3 || !reHex32.MatchString(parts[0]) || !reHex32.MatchString(parts[1]) {
			continue
		}
		seen[rep{parts[0], parts[1]}] = true
	}
	for rp := range seen {
		if err := s.removeReplay(ctx, readCtx{tenant: tenant, project: project, session: rp.session}, rp.replay, "api"); err != nil {
			storeFailure(w, r, err)
			return
		}
	}
	n, err := s.purge(ctx, s.keys.debugProject(tenant, project), "")
	if err != nil {
		storeFailure(w, r, err)
		return
	}
	slog.InfoContext(ctx, "project deleted", "tenant", tenant, "ouo.project.id", project, "replays", len(seen), "debug_file_objects", n)
	writeJSON(w, r, http.StatusOK, map[string]int{"replays": len(seen), "debug_files": n})
}

// purge deletes every object under prefix except keep.
func (s *Server) purge(ctx context.Context, prefix, keep string) (int, error) {
	objs, err := s.store.List(ctx, prefix)
	if err != nil {
		return 0, err
	}
	n := 0
	for _, o := range objs {
		if o.Key == keep {
			continue
		}
		if err := s.store.Delete(ctx, o.Key); err != nil {
			return n, err
		}
		s.mu.Lock()
		delete(s.headers, o.Key)
		s.mu.Unlock()
		n++
	}
	return n, nil
}

// --- retention sweeper (section 9) --------------------------------------------------

// Sweep runs once: replays whose newest object is older than their project's retention
// are deleted with a "retention" tombstone (MUN-51); tombstones older than
// tombstone_ttl are removed after their prefix is purged again (MUN-42). Safe to run
// in several replicas: tombstones are create-only and deletes are idempotent.
func (s *Server) Sweep(ctx context.Context) error {
	objs, err := s.store.List(ctx, s.keys.root)
	if err != nil {
		return err
	}
	type group struct {
		rc       readCtx
		replay   string
		newest   time.Time
		tombTime time.Time
		tomb     bool
	}
	groups := map[string]*group{}
	for _, o := range objs {
		parts := strings.Split(strings.TrimPrefix(o.Key, s.keys.root), "/")
		if len(parts) < 5 {
			continue // schema.json
		}
		id := strings.Join(parts[:4], "/")
		g := groups[id]
		if g == nil {
			g = &group{rc: readCtx{tenant: parts[0], project: parts[1], session: parts[2]}, replay: parts[3]}
			groups[id] = g
		}
		if len(parts) == 5 && parts[4] == "deleted.json" {
			g.tomb, g.tombTime = true, o.Modified
			continue
		}
		if o.Modified.After(g.newest) {
			g.newest = o.Modified
		}
	}
	now := s.now()
	var errs []error
	for _, g := range groups {
		switch {
		case g.tomb:
			if now.Sub(g.tombTime) < s.cfg.TombstoneTTL {
				continue
			}
			tk := s.keys.tombstone(g.rc.tenant, g.rc.project, g.rc.session, g.replay)
			if _, err := s.purge(ctx, s.keys.replay(g.rc.tenant, g.rc.project, g.rc.session, g.replay), tk); err != nil {
				errs = append(errs, err)
				continue
			}
			errs = append(errs, s.store.Delete(ctx, tk))
		default:
			ret := s.cfg.Retention.For(g.rc.project)
			if ret <= 0 || now.Sub(g.newest) < ret {
				continue
			}
			if err := s.removeReplay(ctx, g.rc, g.replay, "retention"); err != nil {
				errs = append(errs, err)
				continue
			}
			s.m.swept.Add(ctx, 1, metric.WithAttributes(attribute.String("ouo.project.id", g.rc.project), attribute.String("reason", "retention")))
		}
	}
	errs = append(errs, s.sweepDebugFiles(ctx, now))
	return errors.Join(errs...)
}

// RunSweeper sweeps every retention.sweep_interval until ctx ends.
func (s *Server) RunSweeper(ctx context.Context) {
	t := time.NewTicker(s.cfg.Retention.SweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Sweep(ctx); err != nil {
				slog.WarnContext(ctx, "retention sweep", "err", err)
			}
		}
	}
}
