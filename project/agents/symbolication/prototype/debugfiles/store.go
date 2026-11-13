// Package debugfiles is a prototype of the debug-file store proposed in
// ADR-0022: write-once, opaque files (source maps, later dSYMs and R8
// mappings) keyed by tenant, project, kind and debug id, the same shape as
// Muninn's replay chunks. The store never parses a body.
//
// Layout under the root:
//
//	debug-files/<tenant>/<project>/<kind>/<debug id>          body, exactly as sent (gzip)
//	debug-files/<tenant>/<project>/<kind>/<debug id>.json     meta: sha256, bytes, release, file, uploaded_at
//	debug-files/<tenant>/<project>/release/<h(release)>/<h(path)>/<debug id>   empty pointer
//
// A pointer says "this debug id was uploaded for this release and URL path".
// It is the fallback for a frame whose bundle has no debug id. Pointers are
// write-once too, so two builds of one release and path leave two pointers,
// and the reader refuses to guess between them.
package debugfiles

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Kinds of debug file. Only source maps are prototyped; the other two show
// that the key has room for them.
const (
	KindSourceMap = "sourcemap"
	KindDSYM      = "dsym"
	KindProguard  = "proguard"
)

var (
	// ErrNotFound is returned when no file has the key.
	ErrNotFound = fmt.Errorf("debug file not found: %w", fs.ErrNotExist)
	// ErrConflict is returned when the key holds other bytes: files are write-once.
	ErrConflict = errors.New("debug file exists with different content")
	// ErrInvalid is returned for a bad tenant, project, kind or debug id.
	ErrInvalid = errors.New("invalid debug file key")
)

var (
	segmentRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	debugIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$`)
)

func validSegment(s string) bool { return segmentRe.MatchString(s) && s != "." && s != ".." }

// NormalizeDebugID lowercases a debug id and puts the dashes back; ok is
// false for anything that is not a UUID.
func NormalizeDebugID(id string) (string, bool) {
	if !debugIDRe.MatchString(id) {
		return "", false
	}
	h := strings.ToLower(strings.ReplaceAll(id, "-", ""))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], true
}

// ContentDebugID is the debug id of a file uploaded without one: a UUID made
// from the SHA-256 of its bytes, so the same upload always gets the same key.
func ContentDebugID(body []byte) string {
	h := sha256.Sum256(body)
	b := h[:16]
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	id, _ := NormalizeDebugID(hex.EncodeToString(b))
	return id
}

// URLPath is the lookup key of a script URL in the release pointers: its
// path, without host, query or fragment.
func URLPath(raw string) string {
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

// Key names one debug file.
type Key struct {
	Tenant  string
	Project string
	Kind    string
	DebugID string
}

func (k Key) path() (string, error) {
	id, ok := NormalizeDebugID(k.DebugID)
	if !ok || !validSegment(k.Tenant) || !validSegment(k.Project) ||
		(k.Kind != KindSourceMap && k.Kind != KindDSYM && k.Kind != KindProguard) {
		return "", ErrInvalid
	}
	return path.Join("debug-files", k.Tenant, k.Project, k.Kind, id), nil
}

// Meta describes a stored file. The store fills SHA256, Bytes and UploadedAt.
type Meta struct {
	DebugID    string    `json:"debug_id"`
	Kind       string    `json:"kind"`
	SHA256     string    `json:"sha256"`
	Bytes      int64     `json:"bytes"` // as stored (compressed)
	Release    string    `json:"release,omitempty"`
	File       string    `json:"file,omitempty"` // URL path of the minified file
	UploadedAt time.Time `json:"uploaded_at"`
}

func hash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:16])
}

func pointerDir(tenant, project, release, file string) string {
	return path.Join("debug-files", tenant, project, "release", hash(release), hash(URLPath(file)))
}

// FS keeps debug files as files under Root. An S3 store has the same three
// operations: put-if-absent, get, list a prefix.
type FS struct {
	Root string
	Now  func() time.Time
}

func (s *FS) abs(key string) string { return filepath.Join(s.Root, filepath.FromSlash(key)) }

// writeOnce creates the file, or reports that it exists.
func (s *FS) writeOnce(key string, data []byte) (created bool, err error) {
	p := s.abs(key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return false, err
	}
	// Write a temporary file and link it: a reader never sees half a file,
	// and Link fails when the name is taken, which is the write-once check.
	tmp, err := os.CreateTemp(filepath.Dir(p), ".upload-*")
	if err != nil {
		return false, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	if err := os.Link(tmp.Name(), p); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// Put stores body under k. A repeat with the same bytes succeeds and changes
// nothing (created is false); a repeat with other bytes is ErrConflict and
// the first write stays. With release and file it also leaves the pointer.
func (s *FS) Put(_ context.Context, k Key, release, file string, body []byte) (Meta, bool, error) {
	key, err := k.path()
	if err != nil {
		return Meta{}, false, err
	}
	id, _ := NormalizeDebugID(k.DebugID)
	sum := sha256.Sum256(body)
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	m := Meta{DebugID: id, Kind: k.Kind, SHA256: hex.EncodeToString(sum[:]), Bytes: int64(len(body)), Release: release, UploadedAt: now().UTC()}
	if file != "" {
		m.File = URLPath(file)
	}
	created, err := s.writeOnce(key, body)
	if err != nil {
		return Meta{}, false, err
	}
	if created {
		meta, _ := json.Marshal(m)
		if _, err := s.writeOnce(key+".json", meta); err != nil {
			return Meta{}, false, err
		}
	} else {
		old, err := os.ReadFile(s.abs(key))
		if err != nil {
			return Meta{}, false, err
		}
		if sha256.Sum256(old) != sum {
			return Meta{}, false, ErrConflict
		}
		if b, err := os.ReadFile(s.abs(key + ".json")); err == nil {
			_ = json.Unmarshal(b, &m)
		}
	}
	// The pointer is written for a repeat too: one map can serve two releases.
	if release != "" && file != "" && k.Kind == KindSourceMap {
		if _, err := s.writeOnce(path.Join(pointerDir(k.Tenant, k.Project, release, file), id), nil); err != nil {
			return Meta{}, false, err
		}
	}
	return m, created, nil
}

// Get returns the body as stored.
func (s *FS) Get(_ context.Context, k Key) ([]byte, error) {
	key, err := k.path()
	if err != nil {
		return nil, ErrNotFound
	}
	b, err := os.ReadFile(s.abs(key))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return b, err
}

// Candidates returns the debug ids uploaded for a release and URL path, sorted.
func (s *FS) Candidates(_ context.Context, tenant, project, release, file string) ([]string, error) {
	if !validSegment(tenant) || !validSegment(project) || release == "" || file == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(s.abs(pointerDir(tenant, project, release, file)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		if id, ok := NormalizeDebugID(e.Name()); ok {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids, nil
}
