// Package replay stores replay chunks (ADR-0003, ADR-0006, ADR-0008): one
// directory per session, one gzip JSON file per chunk, plus meta.json. A
// session's replay is rrweb events (web), JPEG frames (ouo mobile SDK) or mp4
// video segments (Sentry mobile Session Replay through the collector's Sentry
// bridge, docs/specs/sentry-bridge.md 11); the chunk's `kind` says which, and
// kinds never mix inside one session. A video chunk is stored as two files:
// <seq>.mp4 and <seq>.json.gz (the chunk without the base64 mp4).
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
	KindVideo  = "video"
)

// DefaultMaxVideoBytes is the default limit of one decoded video segment
// (MAX_VIDEO_CHUNK_BYTES).
const DefaultMaxVideoBytes = 8 << 20

// ErrNotFound is returned when a session has no replay.
var ErrNotFound = errors.New("replay not found")

// ErrInvalid wraps validation failures of an incoming chunk.
var ErrInvalid = errors.New("invalid chunk")

// ErrWrongKind is returned when a chunk's kind differs from the kind of the
// session's existing replay, and when a kind-specific read (events / frames)
// is asked of a replay of the other kind. The API maps it to 409.
var ErrWrongKind = errors.New("replay kind mismatch")

// ErrTooLarge is returned when a video chunk's decoded mp4 exceeds the
// store's limit. The API maps it to 413.
var ErrTooLarge = errors.New("chunk too large")

// ErrWrongProject is returned when a chunk arrives for a session whose replay
// was recorded under another project id (ADR-0007). The API maps it to 403.
var ErrWrongProject = errors.New("replay belongs to another project")

// Viewport is the device viewport of a frames replay (points) and the scale
// the SDK applied before encoding the JPEGs. For a video replay it is the
// video's pixel size, scale 1.
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
	// Viewport and Platform come with frames and video chunks.
	Viewport *Viewport `json:"-"`
	Platform string    `json:"-"`
	// DurationMs, VideoBytes and Source come with video chunks: the
	// segment's video.duration_ms (ended_at - started_at when absent), the
	// decoded mp4 size and the optional `source` object. FrameCount is
	// video.frame_count (0 when absent).
	DurationMs int64   `json:"-"`
	VideoBytes int64   `json:"-"`
	Source     *Source `json:"-"`

	// mp4 is the decoded video and stored the chunk JSON without video.mp4
	// (with video.bytes), both set for video chunks only.
	mp4    []byte
	stored []byte
}

// Source is where a bridged replay came from (sentry-bridge.md 9): the
// vendor and its replay id. Other fields of the chunk's `source` object
// (segment_id, replay_type) stay in the chunk file.
type Source struct {
	Vendor   string `json:"vendor,omitempty"`
	ReplayID string `json:"replay_id,omitempty"`
}

// ChunkInfo is what the API lists per chunk.
type ChunkInfo struct {
	Seq        int   `json:"seq"`
	StartedAt  int64 `json:"started_at"`
	EndedAt    int64 `json:"ended_at"`
	Bytes      int64 `json:"bytes"` // bytes on disk (gzip JSON, plus the mp4 for video)
	EventCount int   `json:"event_count"`
	FrameCount int   `json:"frame_count"`
	TouchCount int   `json:"touch_count"`
	// DurationMs and VideoBytes (the mp4 size) are set for video chunks only.
	DurationMs *int64 `json:"duration_ms,omitempty"`
	VideoBytes int64  `json:"video_bytes,omitempty"`
}

// Meta is replays/<session>/meta.json. Kind is taken from the first chunk;
// Viewport and Platform are set for frames and video replays, Source for
// video replays whose chunks carry one (the first one seen is kept).
// FrameCount and TouchCount are totals over all chunks (0 for rrweb).
type Meta struct {
	SessionID string `json:"session_id"`
	// ProjectID is the project the collector authenticated for the upload
	// (ADR-0007, X-Ouo-Project-Id on the sink). Empty on meta.json files
	// written before Phase 8a.
	ProjectID  string      `json:"project_id,omitempty"`
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
	Source     *Source     `json:"source,omitempty"`
	UpdatedAt  time.Time   `json:"updated_at"`
	Chunks     []ChunkInfo `json:"chunks"`
}

// Store is the replay storage abstraction (filesystem now, S3 later).
type Store interface {
	// Put validates and stores one chunk for projectID. body is the chunk
	// JSON (already decompressed); gzipBody, if non-nil, is the original gzip
	// bytes and is stored as-is to avoid recompressing (not for video chunks,
	// whose stored JSON drops the base64 mp4). It returns ErrInvalid for a
	// bad chunk, ErrTooLarge for a video segment above the limit,
	// ErrWrongKind when the session already holds a replay of another kind
	// and ErrWrongProject when it belongs to another project (nothing is
	// written in any of these cases). A replay recorded without a project
	// (pre Phase 8a) adopts projectID.
	Put(ctx context.Context, projectID string, body []byte, gzipBody []byte) (Chunk, error)
	// Meta returns the session's replay metadata or ErrNotFound.
	Meta(ctx context.Context, sessionID string) (Meta, error)
	// Has reports whether the session has at least one chunk.
	Has(ctx context.Context, sessionID string) bool
	// Kind returns the replay kind of the session (KindRRWeb, KindFrames or
	// KindVideo) or ErrNotFound. Cheaper than Meta: implementations may cache it.
	Kind(ctx context.Context, sessionID string) (string, error)
	// OpenChunk returns a reader over the decompressed JSON of one chunk.
	OpenChunk(ctx context.Context, sessionID string, seq int) (io.ReadCloser, error)
	// OpenVideo returns the mp4 of one video segment or ErrNotFound.
	OpenVideo(ctx context.Context, sessionID string, seq int) (VideoFile, error)
	// Delete removes the whole replay of a session (no error when absent).
	Delete(ctx context.Context, sessionID string) error
}

// VideoFile is one stored mp4 segment: seekable content for range requests,
// its size and modification time (Last-Modified). The caller closes Content.
type VideoFile struct {
	Content io.ReadSeekCloser
	Size    int64
	ModTime time.Time
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
