package replay

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// FS is the filesystem Store: <root>/replays/<session_id>/<seq %06d>.json.gz.
type FS struct {
	Root string
	// Now is injected for tests.
	Now func() time.Time

	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

// NewFS creates the store rooted at dataDir (replays live in dataDir/replays).
func NewFS(dataDir string) (*FS, error) {
	root := filepath.Join(dataDir, "replays")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", root, err)
	}
	return &FS{Root: root, Now: time.Now, locks: map[string]*sync.Mutex{}}, nil
}

func (s *FS) lock(sessionID string) func() {
	s.mu.Lock()
	m, ok := s.locks[sessionID]
	if !ok {
		m = &sync.Mutex{}
		s.locks[sessionID] = m
	}
	s.mu.Unlock()
	m.Lock()
	return m.Unlock
}

func (s *FS) dir(sessionID string) string { return filepath.Join(s.Root, sessionID) }

func chunkName(seq int) string { return fmt.Sprintf("%06d.json.gz", seq) }

// parseChunk validates the envelope and counts events without keeping them.
func parseChunk(body []byte) (Chunk, error) {
	var c Chunk
	dec := json.NewDecoder(bytes.NewReader(body))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return c, fmt.Errorf("%w: body must be a JSON object", ErrInvalid)
	}
	seenEvents := false
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return c, fmt.Errorf("%w: %v", ErrInvalid, err)
		}
		key, _ := keyTok.(string)
		switch key {
		case "session_id":
			if err := dec.Decode(&c.SessionID); err != nil {
				return c, fmt.Errorf("%w: session_id: %v", ErrInvalid, err)
			}
		case "seq":
			if err := dec.Decode(&c.Seq); err != nil {
				return c, fmt.Errorf("%w: seq: %v", ErrInvalid, err)
			}
		case "started_at":
			if err := dec.Decode(&c.StartedAt); err != nil {
				return c, fmt.Errorf("%w: started_at: %v", ErrInvalid, err)
			}
		case "ended_at":
			if err := dec.Decode(&c.EndedAt); err != nil {
				return c, fmt.Errorf("%w: ended_at: %v", ErrInvalid, err)
			}
		case "events":
			seenEvents = true
			if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
				return c, fmt.Errorf("%w: events must be an array", ErrInvalid)
			}
			for dec.More() {
				var raw json.RawMessage
				if err := dec.Decode(&raw); err != nil {
					return c, fmt.Errorf("%w: events[%d]: %v", ErrInvalid, c.EventCount, err)
				}
				c.EventCount++
			}
			if _, err := dec.Token(); err != nil {
				return c, fmt.Errorf("%w: events: %v", ErrInvalid, err)
			}
		default:
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return c, fmt.Errorf("%w: %s: %v", ErrInvalid, key, err)
			}
		}
	}
	if _, err := dec.Token(); err != nil {
		return c, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if !ValidSessionID(c.SessionID) {
		return c, fmt.Errorf("%w: session_id must match %s", ErrInvalid, sessionIDRe)
	}
	if c.Seq < 0 || c.Seq > 999999 {
		return c, fmt.Errorf("%w: seq must be between 0 and 999999", ErrInvalid)
	}
	if !seenEvents {
		return c, fmt.Errorf("%w: events missing", ErrInvalid)
	}
	if c.EndedAt < c.StartedAt {
		c.EndedAt = c.StartedAt
	}
	return c, nil
}

// Put implements Store.
func (s *FS) Put(ctx context.Context, body []byte, gzipBody []byte) (Chunk, error) {
	c, err := parseChunk(body)
	if err != nil {
		return c, err
	}
	data := gzipBody
	if data == nil {
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		if _, err := gw.Write(body); err != nil {
			return c, err
		}
		if err := gw.Close(); err != nil {
			return c, err
		}
		data = buf.Bytes()
	}

	unlock := s.lock(c.SessionID)
	defer unlock()

	dir := s.dir(c.SessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return c, err
	}
	if err := writeAtomic(filepath.Join(dir, chunkName(c.Seq)), data); err != nil {
		return c, err
	}

	meta, err := s.readMeta(c.SessionID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return c, err
	}
	meta.SessionID = c.SessionID
	info := ChunkInfo{Seq: c.Seq, StartedAt: c.StartedAt, EndedAt: c.EndedAt, Bytes: int64(len(data)), EventCount: c.EventCount}
	replaced := false
	for i := range meta.Chunks {
		if meta.Chunks[i].Seq == c.Seq {
			meta.Chunks[i] = info
			replaced = true
		}
	}
	if !replaced {
		meta.Chunks = append(meta.Chunks, info)
	}
	sort.Slice(meta.Chunks, func(i, j int) bool { return meta.Chunks[i].Seq < meta.Chunks[j].Seq })
	meta.recompute(s.Now())
	return c, s.writeMeta(meta)
}

func (m *Meta) recompute(now time.Time) {
	m.ChunkCount = len(m.Chunks)
	m.Bytes = 0
	m.StartedAt, m.EndedAt = 0, 0
	for i, ch := range m.Chunks {
		m.Bytes += ch.Bytes
		if i == 0 {
			m.FirstSeq, m.StartedAt, m.EndedAt = ch.Seq, ch.StartedAt, ch.EndedAt
		}
		m.LastSeq = ch.Seq
		if ch.StartedAt > 0 && (m.StartedAt == 0 || ch.StartedAt < m.StartedAt) {
			m.StartedAt = ch.StartedAt
		}
		if ch.EndedAt > m.EndedAt {
			m.EndedAt = ch.EndedAt
		}
	}
	m.UpdatedAt = now.UTC()
}

func (s *FS) readMeta(sessionID string) (Meta, error) {
	var m Meta
	b, err := os.ReadFile(filepath.Join(s.dir(sessionID), "meta.json"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return m, ErrNotFound
		}
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("corrupt meta.json for %s: %w", sessionID, err)
	}
	return m, nil
}

func (s *FS) writeMeta(m Meta) error {
	b, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.dir(m.SessionID), "meta.json"), b)
}

// writeAtomic writes to a temp file in the same directory and renames it.
func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// CreateTemp uses 0600; chunks are inspected from the host (bind mount).
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// Meta implements Store.
func (s *FS) Meta(ctx context.Context, sessionID string) (Meta, error) {
	if !ValidSessionID(sessionID) {
		return Meta{}, ErrNotFound
	}
	return s.readMeta(sessionID)
}

// Has implements Store.
func (s *FS) Has(ctx context.Context, sessionID string) bool {
	if !ValidSessionID(sessionID) {
		return false
	}
	_, err := os.Stat(filepath.Join(s.dir(sessionID), "meta.json"))
	return err == nil
}

type gzReadCloser struct {
	*gzip.Reader
	f *os.File
}

func (g gzReadCloser) Close() error {
	g.Reader.Close()
	return g.f.Close()
}

// OpenChunk implements Store.
func (s *FS) OpenChunk(ctx context.Context, sessionID string, seq int) (io.ReadCloser, error) {
	if !ValidSessionID(sessionID) || seq < 0 {
		return nil, ErrNotFound
	}
	f, err := os.Open(filepath.Join(s.dir(sessionID), chunkName(seq)))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	gr, err := gzip.NewReader(f)
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("chunk %s/%d: %w", sessionID, seq, err)
	}
	return gzReadCloser{Reader: gr, f: f}, nil
}

// Delete implements Store.
func (s *FS) Delete(ctx context.Context, sessionID string) error {
	if !ValidSessionID(sessionID) {
		return nil
	}
	unlock := s.lock(sessionID)
	defer unlock()
	return os.RemoveAll(s.dir(sessionID))
}

// WriteEvents streams every chunk of the session in seq order as one JSON
// array of rrweb events to w. It returns ErrNotFound when the session has no
// replay. Chunks that fail to decode are skipped (the player plays from the
// next full snapshot).
func WriteEvents(ctx context.Context, st Store, sessionID string, w io.Writer) error {
	meta, err := st.Meta(ctx, sessionID)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(w, "["); err != nil {
		return err
	}
	first := true
	for _, ch := range meta.Chunks {
		if err := ctx.Err(); err != nil {
			return err
		}
		rc, err := st.OpenChunk(ctx, sessionID, ch.Seq)
		if err != nil {
			continue
		}
		err = copyEvents(rc, w, &first)
		rc.Close()
		if err != nil {
			return err
		}
	}
	_, err = io.WriteString(w, "]")
	return err
}

// copyEvents finds the "events" array in a chunk and copies its elements.
func copyEvents(r io.Reader, w io.Writer, first *bool) error {
	dec := json.NewDecoder(r)
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil // corrupt chunk: skip
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil
		}
		if key, _ := keyTok.(string); key != "events" {
			var skip json.RawMessage
			if err := dec.Decode(&skip); err != nil {
				return nil
			}
			continue
		}
		if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
			return nil
		}
		for dec.More() {
			var raw json.RawMessage
			if err := dec.Decode(&raw); err != nil {
				return nil
			}
			if !*first {
				if _, err := io.WriteString(w, ","); err != nil {
					return err
				}
			}
			*first = false
			if _, err := w.Write(raw); err != nil {
				return err
			}
		}
		return nil
	}
	return nil
}
