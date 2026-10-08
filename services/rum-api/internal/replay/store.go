// Package replay stores replay chunks (ADR-0003, ADR-0006): one directory per
// session, one gzip JSON file per chunk, plus meta.json. A session's replay is
// either rrweb events (web) or JPEG frames (mobile); the chunk's `kind` says
// which, and the two never mix inside one session.
package replay

import (
	"context"
	"errors"
	"io"
	"regexp"
	"time"
)

// Replay kinds. A chunk without `kind` is rrweb (docs/specs/mobile-replay.md).
const (
	KindRRWeb  = "rrweb"
	KindFrames = "frames"
)

// ErrNotFound is returned when a session has no replay.
var ErrNotFound = errors.New("replay not found")

// ErrInvalid wraps validation failures of an incoming chunk.
var ErrInvalid = errors.New("invalid chunk")

// ErrWrongKind is returned when a chunk's kind differs from the kind of the
// session's existing replay, and when a kind-specific read (events / frames)
// is asked of a replay of the other kind. The API maps it to 409.
var ErrWrongKind = errors.New("replay kind mismatch")

// Viewport is the device viewport of a frames replay (points) and the scale
// the SDK applied before encoding the JPEGs.
type Viewport struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Scale  float64 `json:"scale"`
}

// Chunk is the validated envelope of one SDK upload. Timestamps are epoch
// milliseconds (same unit as rrweb event timestamps and frame `ts`).
type Chunk struct {
	Kind      string `json:"kind"`
	SessionID string `json:"session_id"`
	Seq       int    `json:"seq"`
	StartedAt int64  `json:"started_at"`
	EndedAt   int64  `json:"ended_at"`
	// EventCount is the number of rrweb events (kind rrweb).
	EventCount int `json:"-"`
	// FrameCount and TouchCount are the frames / touches (kind frames).
	FrameCount int `json:"-"`
	TouchCount int `json:"-"`
	// Viewport and Platform come with frames chunks.
	Viewport *Viewport `json:"-"`
	Platform string    `json:"-"`
}

// ChunkInfo is what the API lists per chunk.
type ChunkInfo struct {
	Seq        int   `json:"seq"`
	StartedAt  int64 `json:"started_at"`
	EndedAt    int64 `json:"ended_at"`
	Bytes      int64 `json:"bytes"` // gzip bytes on disk
	EventCount int   `json:"event_count"`
	FrameCount int   `json:"frame_count"`
	TouchCount int   `json:"touch_count"`
}

// Meta is replays/<session>/meta.json. Kind is taken from the first chunk;
// Viewport and Platform are set for frames replays only. FrameCount and
// TouchCount are totals over all chunks (0 for rrweb).
type Meta struct {
	SessionID  string      `json:"session_id"`
	Kind       string      `json:"kind"`
	ChunkCount int         `json:"chunk_count"`
	FirstSeq   int         `json:"first_seq"`
	LastSeq    int         `json:"last_seq"`
	StartedAt  int64       `json:"started_at"`
	EndedAt    int64       `json:"ended_at"`
	Bytes      int64       `json:"bytes"`
	FrameCount int         `json:"frame_count"`
	TouchCount int         `json:"touch_count"`
	Viewport   *Viewport   `json:"viewport,omitempty"`
	Platform   string      `json:"platform,omitempty"`
	UpdatedAt  time.Time   `json:"updated_at"`
	Chunks     []ChunkInfo `json:"chunks"`
}

// Store is the replay storage abstraction (filesystem now, S3 later).
type Store interface {
	// Put validates and stores one chunk. body is the chunk JSON (already
	// decompressed); gzipBody, if non-nil, is the original gzip bytes and is
	// stored as-is to avoid recompressing. It returns ErrInvalid for a bad
	// chunk and ErrWrongKind when the session already holds a replay of the
	// other kind (nothing is written in either case).
	Put(ctx context.Context, body []byte, gzipBody []byte) (Chunk, error)
	// Meta returns the session's replay metadata or ErrNotFound.
	Meta(ctx context.Context, sessionID string) (Meta, error)
	// Has reports whether the session has at least one chunk.
	Has(ctx context.Context, sessionID string) bool
	// Kind returns the replay kind of the session (KindRRWeb or KindFrames)
	// or ErrNotFound. Cheaper than Meta: implementations may cache it.
	Kind(ctx context.Context, sessionID string) (string, error)
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

// normalizeKind maps the on-disk / on-the-wire kind to a known constant:
// absent means rrweb (chunks and meta.json written before frames existed).
func normalizeKind(k string) string {
	if k == "" {
		return KindRRWeb
	}
	return k
}
