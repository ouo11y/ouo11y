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
	// kinds caches session id -> replay kind (a kind never changes once the
	// first chunk is stored; Delete evicts). Saves parsing meta.json for every
	// session of a list request.
	kinds map[string]string
}

// NewFS creates the store rooted at dataDir (replays live in dataDir/replays).
func NewFS(dataDir string) (*FS, error) {
	root := filepath.Join(dataDir, "replays")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", root, err)
	}
	return &FS{Root: root, Now: time.Now, locks: map[string]*sync.Mutex{}, kinds: map[string]string{}}, nil
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

// Put implements Store.
func (s *FS) Put(ctx context.Context, projectID string, body []byte, gzipBody []byte) (Chunk, error) {
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

	meta, err := s.readMeta(c.SessionID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return c, err
	}
	if err == nil && meta.Kind != c.Kind {
		return c, fmt.Errorf("%w: session %s holds a %s replay, chunk is %s", ErrWrongKind, c.SessionID, meta.Kind, c.Kind)
	}
	if err == nil && meta.ProjectID != "" && projectID != "" && meta.ProjectID != projectID {
		return c, fmt.Errorf("%w: session %s", ErrWrongProject, c.SessionID)
	}

	dir := s.dir(c.SessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return c, err
	}
	if err := writeAtomic(filepath.Join(dir, chunkName(c.Seq)), data); err != nil {
		return c, err
	}

	meta.SessionID = c.SessionID
	if projectID != "" {
		meta.ProjectID = projectID
	}
	meta.Kind = c.Kind
	if c.Kind == KindFrames {
		// Viewport and platform follow the latest chunk (a device does not
		// change viewport mid-session; orientation changes are out of scope).
		meta.Viewport, meta.Platform = c.Viewport, c.Platform
	}
	info := ChunkInfo{Seq: c.Seq, StartedAt: c.StartedAt, EndedAt: c.EndedAt, Bytes: int64(len(data)),
		EventCount: c.EventCount, FrameCount: c.FrameCount, TouchCount: c.TouchCount}
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
	if err := s.writeMeta(meta); err != nil {
		return c, err
	}
	s.mu.Lock()
	s.kinds[c.SessionID] = c.Kind
	s.mu.Unlock()
	return c, nil
}

func (m *Meta) recompute(now time.Time) {
	m.ChunkCount = len(m.Chunks)
	m.Bytes = 0
	m.FrameCount, m.TouchCount = 0, 0
	m.StartedAt, m.EndedAt = 0, 0
	for i, ch := range m.Chunks {
		m.Bytes += ch.Bytes
		m.FrameCount += ch.FrameCount
		m.TouchCount += ch.TouchCount
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
	m.Kind = normalizeKind(m.Kind) // meta.json written before Phase 7 has no kind
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

// Kind implements Store: a stat of meta.json plus a cached kind, so listing
// many sessions does not parse every meta.json.
func (s *FS) Kind(ctx context.Context, sessionID string) (string, error) {
	if !s.Has(ctx, sessionID) {
		return "", ErrNotFound
	}
	s.mu.Lock()
	k, ok := s.kinds[sessionID]
	s.mu.Unlock()
	if ok {
		return k, nil
	}
	m, err := s.readMeta(sessionID)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.kinds[sessionID] = m.Kind
	s.mu.Unlock()
	return m.Kind, nil
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
	s.mu.Lock()
	delete(s.kinds, sessionID)
	s.mu.Unlock()
	return os.RemoveAll(s.dir(sessionID))
}
