package replay

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Object names inside a session's directory (filesystem) or key prefix (S3).
// Both stores use the same layout, so a filesystem replay tree can be copied
// into a bucket as is (deploy/README.md).
const metaName = "meta.json"

func chunkName(seq int) string { return fmt.Sprintf("%06d.json.gz", seq) }

func videoName(seq int) string { return fmt.Sprintf("%06d.mp4", seq) }

func gzipBytes(b []byte) ([]byte, error) {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(b); err != nil {
		return nil, err
	}
	if err := gw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// prepareChunk validates body and returns the chunk with the gzip bytes to
// store as <seq>.json.gz: gzipBody as is when given, except for video chunks,
// whose stored JSON drops the base64 mp4. maxVideo <= 0 means
// DefaultMaxVideoBytes.
func prepareChunk(body, gzipBody []byte, maxVideo int64) (Chunk, []byte, error) {
	if maxVideo <= 0 {
		maxVideo = DefaultMaxVideoBytes
	}
	c, err := parseChunk(body, maxVideo)
	if err != nil {
		return c, nil, err
	}
	data := gzipBody
	if c.Kind == KindVideo {
		// The uploaded gzip holds the base64 mp4; store the slim JSON.
		data = nil
		body = c.stored
	}
	if data == nil {
		if data, err = gzipBytes(body); err != nil {
			return c, nil, err
		}
	}
	return c, data, nil
}

// checkMeta rejects a chunk for a session that already holds (exists) a
// replay of another kind or of another project.
func checkMeta(meta Meta, exists bool, c Chunk, projectID string) error {
	if !exists {
		return nil
	}
	if meta.Kind != c.Kind {
		return fmt.Errorf("%w: session %s holds a %s replay, chunk is %s", ErrWrongKind, c.SessionID, meta.Kind, c.Kind)
	}
	if meta.ProjectID != "" && projectID != "" && meta.ProjectID != projectID {
		return fmt.Errorf("%w: session %s", ErrWrongProject, c.SessionID)
	}
	return nil
}

// applyChunk records c (stored as dataLen bytes of gzip JSON, plus the mp4
// for video) in meta. A chunk whose seq is already listed replaces the entry,
// so a retried upload never counts twice.
func applyChunk(meta *Meta, c Chunk, projectID string, dataLen int64, now time.Time) {
	meta.SessionID = c.SessionID
	if projectID != "" {
		meta.ProjectID = projectID
	}
	meta.Kind = c.Kind
	if c.Kind == KindFrames || c.Kind == KindVideo {
		// Viewport and platform follow the latest chunk (a device does not
		// change viewport mid-session; orientation changes are out of scope).
		meta.Viewport, meta.Platform = c.Viewport, c.Platform
	}
	if meta.Source == nil && c.Source != nil {
		// A session keeps the first replay id it sees (sentry-bridge.md 9).
		meta.Source = c.Source
	}
	info := ChunkInfo{Seq: c.Seq, StartedAt: c.StartedAt, EndedAt: c.EndedAt, Bytes: dataLen,
		EventCount: c.EventCount, FrameCount: c.FrameCount, TouchCount: c.TouchCount}
	if c.Kind == KindVideo {
		d := c.DurationMs
		info.DurationMs, info.VideoBytes = &d, c.VideoBytes
		info.Bytes += c.VideoBytes
	}
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
	meta.recompute(now)
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

func decodeMeta(sessionID string, b []byte) (Meta, error) {
	var m Meta
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("corrupt meta.json for %s: %w", sessionID, err)
	}
	m.Kind = normalizeKind(m.Kind) // meta.json written before Phase 7 has no kind
	return m, nil
}

func encodeMeta(m Meta) ([]byte, error) { return json.MarshalIndent(m, "", " ") }
