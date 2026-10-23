// Package audit is rum-api's append-only deletion log
// (docs/operations/data-lifecycle.md, section Audit log). Every delete-by-user
// and delete-by-project writes a "started" entry before anything is deleted
// and a "completed" or "failed" entry with the same id after; a deletion whose
// started entry cannot be written does not run.
//
// Two backends follow the replay store: a JSON Lines file next to the
// filesystem replays (each line carries the SHA-256 of the previous line, so
// an edited or removed line breaks the chain) and one create-only object per
// entry in the S3 bucket (If-None-Match: *; pair it with S3 Object Lock for
// immutability). Nothing in rum-api updates or removes an entry.
package audit

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Entry statuses.
const (
	StatusStarted   = "started"
	StatusCompleted = "completed"
	StatusFailed    = "failed"
)

// Entry is one audit record. Counts and backend results are set on the
// completed / failed entry.
type Entry struct {
	ID     string    `json:"id"`
	Time   time.Time `json:"time"`
	Status string    `json:"status"`
	// Action is delete_user or delete_project.
	Action    string `json:"action"`
	UserID    string `json:"user_id,omitempty"`
	ProjectID string `json:"project_id,omitempty"`
	Actor     string `json:"actor"`
	Reason    string `json:"reason,omitempty"`
	DryRun    bool   `json:"dry_run,omitempty"`
	// Window is the time range searched and deleted (Loki), RFC 3339.
	From *time.Time `json:"from,omitempty"`
	To   *time.Time `json:"to,omitempty"`

	// SessionCount is the number of sessions found; Sessions lists their
	// ids (the first MaxSessionIDs).
	SessionCount int      `json:"session_count"`
	Sessions     []string `json:"sessions,omitempty"`
	Replays      *Replays `json:"replays,omitempty"`
	Loki         *Backend `json:"loki,omitempty"`
	Tempo        *Backend `json:"tempo,omitempty"`
	Error        string   `json:"error,omitempty"`

	// Prev is the SHA-256 (hex) of the previous line of the file log; empty
	// for the first line and on S3.
	Prev string `json:"prev,omitempty"`
}

// MaxSessionIDs bounds Entry.Sessions (a project can have millions).
const MaxSessionIDs = 1000

// Replays is what the replay store deleted.
type Replays struct {
	Deleted int   `json:"deleted"`
	Bytes   int64 `json:"bytes"`
}

// Backend is what a telemetry backend did with the deletion: Status is
// submitted, skipped, unsupported or failed.
type Backend struct {
	Status   string   `json:"status"`
	Query    string   `json:"query,omitempty"`
	TraceIDs []string `json:"trace_ids,omitempty"`
	Note     string   `json:"note,omitempty"`
	Error    string   `json:"error,omitempty"`
}

// Log is an append-only audit log.
type Log interface {
	Append(ctx context.Context, e Entry) error
	// List returns entries oldest first, at most limit (the newest ones) when
	// limit > 0.
	List(ctx context.Context, limit int) ([]Entry, error)
}

// File is the JSON Lines log at <dir>/audit/deletions.jsonl.
type File struct {
	path string
	mu   sync.Mutex
	last string // hash of the last line
}

// FileName is the log file inside the audit directory.
const FileName = "deletions.jsonl"

// NewFile opens (creating) the log under dataDir/audit.
func NewFile(dataDir string) (*File, error) {
	dir := filepath.Join(dataDir, "audit")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("create %s: %w", dir, err)
	}
	f := &File{path: filepath.Join(dir, FileName)}
	lines, err := f.lines()
	if err != nil {
		return nil, err
	}
	if n := len(lines); n > 0 {
		f.last = lineHash(lines[n-1])
	}
	return f, nil
}

// Path is the file's location (logs, docs).
func (f *File) Path() string { return f.path }

func lineHash(line []byte) string {
	sum := sha256.Sum256(line)
	return hex.EncodeToString(sum[:])
}

func (f *File) lines() ([][]byte, error) {
	b, err := os.ReadFile(f.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out [][]byte
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64<<10), 16<<20)
	for sc.Scan() {
		if line := bytes.TrimSpace(sc.Bytes()); len(line) > 0 {
			out = append(out, append([]byte(nil), line...))
		}
	}
	return out, sc.Err()
}

// Append implements Log: one line, opened O_APPEND, fsynced.
func (f *File) Append(ctx context.Context, e Entry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	e.Prev = f.last
	line, err := json.Marshal(e)
	if err != nil {
		return err
	}
	fh, err := os.OpenFile(f.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o640)
	if err != nil {
		return err
	}
	if _, err := fh.Write(append(line, '\n')); err != nil {
		fh.Close()
		return err
	}
	if err := fh.Sync(); err != nil {
		fh.Close()
		return err
	}
	if err := fh.Close(); err != nil {
		return err
	}
	f.last = lineHash(line)
	return nil
}

// List implements Log.
func (f *File) List(ctx context.Context, limit int) ([]Entry, error) {
	f.mu.Lock()
	lines, err := f.lines()
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if limit > 0 && len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	out := make([]Entry, 0, len(lines))
	for _, l := range lines {
		var e Entry
		if err := json.Unmarshal(l, &e); err != nil {
			return nil, fmt.Errorf("%s: %w", f.path, err)
		}
		out = append(out, e)
	}
	return out, nil
}

// Verify checks the hash chain and returns the number of lines, or the
// 1-based line whose prev does not match.
func (f *File) Verify() (int, error) {
	lines, err := f.lines()
	if err != nil {
		return 0, err
	}
	prev := ""
	for i, l := range lines {
		var e Entry
		if err := json.Unmarshal(l, &e); err != nil {
			return i, fmt.Errorf("line %d: %w", i+1, err)
		}
		if e.Prev != prev {
			return i, fmt.Errorf("line %d: chain broken (prev %q, want %q)", i+1, e.Prev, prev)
		}
		prev = lineHash(l)
	}
	return len(lines), nil
}

// ObjectStore is what the bucket log needs from the replay bucket
// (replay.S3 implements it under [<prefix>/]audit/).
type ObjectStore interface {
	// PutNew creates name and fails if it exists.
	PutNew(ctx context.Context, name string, data []byte) error
	// Names lists the object names, any order.
	Names(ctx context.Context) ([]string, error)
	Get(ctx context.Context, name string) ([]byte, error)
}

// Bucket is the S3 log: one object per entry, named
// <time>-<id>-<status>.json so names sort by time.
type Bucket struct {
	Store ObjectStore
}

// Append implements Log.
func (b Bucket) Append(ctx context.Context, e Entry) error {
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	name := fmt.Sprintf("%s-%s-%s.json", e.Time.UTC().Format("20060102T150405.000000000Z"), e.ID, e.Status)
	return b.Store.PutNew(ctx, name, data)
}

// List implements Log.
func (b Bucket) List(ctx context.Context, limit int) ([]Entry, error) {
	names, err := b.Store.Names(ctx)
	if err != nil {
		return nil, err
	}
	sort.Strings(names)
	if limit > 0 && len(names) > limit {
		names = names[len(names)-limit:]
	}
	out := make([]Entry, 0, len(names))
	for _, n := range names {
		if !strings.HasSuffix(n, ".json") {
			continue
		}
		data, err := b.Store.Get(ctx, n)
		if err != nil {
			return nil, err
		}
		var e Entry
		if err := json.Unmarshal(data, &e); err != nil {
			return nil, fmt.Errorf("audit object %s: %w", n, err)
		}
		out = append(out, e)
	}
	return out, nil
}
