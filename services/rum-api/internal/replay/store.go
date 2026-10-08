// Package replay stores rrweb replay chunks (ADR-0003): one directory per
// session, one gzip JSON file per chunk, plus meta.json.
package replay

import (
	"context"
	"errors"
	"io"
	"regexp"
	"time"
)

// ErrNotFound is returned when a session has no replay.
var ErrNotFound = errors.New("replay not found")

// ErrInvalid wraps validation failures of an incoming chunk.
var ErrInvalid = errors.New("invalid chunk")

// Chunk is the SDK upload: {session_id, seq, started_at, ended_at, events}.
// Timestamps are epoch milliseconds (same unit as rrweb event timestamps).
type Chunk struct {
	SessionID string `json:"session_id"`
	Seq       int    `json:"seq"`
	StartedAt int64  `json:"started_at"`
	EndedAt   int64  `json:"ended_at"`
	// EventCount is the number of rrweb events in the chunk.
	EventCount int `json:"-"`
}

// ChunkInfo is what the API lists per chunk.
type ChunkInfo struct {
	Seq        int   `json:"seq"`
	StartedAt  int64 `json:"started_at"`
	EndedAt    int64 `json:"ended_at"`
	Bytes      int64 `json:"bytes"` // gzip bytes on disk
	EventCount int   `json:"event_count"`
}

// Meta is replays/<session>/meta.json.
type Meta struct {
	SessionID  string      `json:"session_id"`
	ChunkCount int         `json:"chunk_count"`
	FirstSeq   int         `json:"first_seq"`
	LastSeq    int         `json:"last_seq"`
	StartedAt  int64       `json:"started_at"`
	EndedAt    int64       `json:"ended_at"`
	Bytes      int64       `json:"bytes"`
	UpdatedAt  time.Time   `json:"updated_at"`
	Chunks     []ChunkInfo `json:"chunks"`
}

// Store is the replay storage abstraction (filesystem now, S3 later).
type Store interface {
	// Put validates and stores one chunk. body is the chunk JSON (already
	// decompressed); gzipBody, if non-nil, is the original gzip bytes and is
	// stored as-is to avoid recompressing.
	Put(ctx context.Context, body []byte, gzipBody []byte) (Chunk, error)
	// Meta returns the session's replay metadata or ErrNotFound.
	Meta(ctx context.Context, sessionID string) (Meta, error)
	// Has reports whether the session has at least one chunk.
	Has(ctx context.Context, sessionID string) bool
	// OpenChunk returns a reader over the decompressed JSON of one chunk.
	OpenChunk(ctx context.Context, sessionID string, seq int) (io.ReadCloser, error)
	// Delete removes the whole replay of a session (no error when absent).
	Delete(ctx context.Context, sessionID string) error
}

// sessionIDRe: UUID-ish, safe as a path segment, at most 64 chars.
var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

// ValidSessionID reports whether id can be used as a directory name.
func ValidSessionID(id string) bool {
	return sessionIDRe.MatchString(id) && id != "." && id != ".."
}
