// Package sourcemap stores JavaScript source maps and native debug files
// (dSYM DWARF) per project and translates minified stack traces and native
// crash addresses back to original files, lines and functions (ADR-0011,
// docs/sourcemaps.md, docs/symbolication.md).
//
// Layout under the bucket's sourcemaps/ root:
//
//	<project>/debug-id/<uuid>.map.gz and .json            (map, meta)
//	<project>/release/<sha256(release)>/<sha256(path)>.map.gz and .json
//	<project>/dsym/<uuid>.dwarf.gz and .json              (one Mach-O slice per LC_UUID)
//
// The release index is the fallback for bundles without a debug id: a frame's
// script URL path (host ignored) plus the record's service.version.
package sourcemap

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	gosm "github.com/go-sourcemap/sourcemap"
)

// DefaultMaxBytes limits one decompressed map (limits.max_sourcemap_bytes).
const DefaultMaxBytes = 64 << 20

// ErrInvalid wraps validation failures of an upload.
var ErrInvalid = errors.New("invalid source map")

// ErrTooLarge is returned for a map above the size limit.
var ErrTooLarge = errors.New("source map too large")

var (
	projectRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	debugIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$`)
)

// ValidProject reports whether id is a usable project id (same rule as session ids).
func ValidProject(id string) bool { return projectRe.MatchString(id) && id != "." && id != ".." }

// NormalizeDebugID lowercases a debug id and puts the dashes back; ok is
// false for anything that is not a UUID.
func NormalizeDebugID(id string) (string, bool) {
	if !debugIDRe.MatchString(id) {
		return "", false
	}
	h := strings.ToLower(strings.ReplaceAll(id, "-", ""))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], true
}

// URLPath is the lookup key of a script URL in the release index: its path
// ("/assets/index-B3x9.js"), without host, query or fragment. A bare file
// name gets a leading slash.
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

// Meta describes one stored map or dSYM slice.
type Meta struct {
	ProjectID  string    `json:"project_id"`
	Kind       string    `json:"kind,omitempty"` // "dsym" for a native debug file, empty for a source map
	DebugID    string    `json:"debug_id,omitempty"`
	Release    string    `json:"release,omitempty"`
	File       string    `json:"file,omitempty"` // URL path of the minified file; a dSYM's binary name
	Arch       string    `json:"arch,omitempty"` // dSYM only: arm64, x86_64, ...
	Bytes      int64     `json:"bytes"`          // decompressed size
	Sources    int       `json:"sources"`
	UploadedAt time.Time `json:"uploaded_at"`
}

// Upload is one map to store. At least DebugID or Release + File is required.
type Upload struct {
	ProjectID string
	DebugID   string
	Release   string
	File      string
	Map       []byte // decompressed JSON
}

// Store reads and writes maps in an Objects bucket.
type Store struct {
	Objects  Objects
	MaxBytes int64 // 0: DefaultMaxBytes
	// Retention returns a project's map retention (0: forever); nil: forever.
	Retention func(projectID string) time.Duration
	Now       func() time.Time
	// MaxDSYMBytes limits one uploaded dSYM file (0: DefaultMaxDSYMBytes).
	MaxDSYMBytes int64
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func gzipBytes(b []byte) *bytes.Buffer {
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(b)
	zw.Close()
	return &gz
}

func hash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:16])
}

func debugIDKey(project, id string) string { return project + "/debug-id/" + id }

func releaseKey(project, release, file string) string {
	return project + "/release/" + hash(release) + "/" + hash(URLPath(file))
}

// Put validates and stores one map, under its debug id and / or its release
// path. A re-upload replaces the map and restarts its retention.
func (s *Store) Put(ctx context.Context, u Upload) (Meta, error) {
	max := s.MaxBytes
	if max <= 0 {
		max = DefaultMaxBytes
	}
	if !ValidProject(u.ProjectID) {
		return Meta{}, fmt.Errorf("%w: project id", ErrInvalid)
	}
	if int64(len(u.Map)) > max {
		return Meta{}, fmt.Errorf("%w: %d bytes, limit %d", ErrTooLarge, len(u.Map), max)
	}
	m := Meta{ProjectID: u.ProjectID, Release: u.Release, Bytes: int64(len(u.Map)), UploadedAt: s.now().UTC()}
	if u.File != "" {
		m.File = URLPath(u.File)
	}
	var head struct {
		DebugID  string   `json:"debugId"`
		DebugID2 string   `json:"debug_id"`
		Sources  []string `json:"sources"`
	}
	if err := json.Unmarshal(u.Map, &head); err != nil {
		return Meta{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if _, err := gosm.Parse("", u.Map); err != nil {
		return Meta{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	m.Sources = len(head.Sources)
	id := u.DebugID
	if id == "" {
		id = head.DebugID
	}
	if id == "" {
		id = head.DebugID2
	}
	if id != "" {
		norm, ok := NormalizeDebugID(id)
		if !ok {
			return Meta{}, fmt.Errorf("%w: debug id %q is not a UUID", ErrInvalid, id)
		}
		m.DebugID = norm
	}
	if m.DebugID == "" && (m.Release == "" || m.File == "") {
		return Meta{}, fmt.Errorf("%w: a debug id, or a release and a file, is required", ErrInvalid)
	}
	gz := gzipBytes(u.Map)
	meta, _ := json.Marshal(m)
	var keys []string
	if m.DebugID != "" {
		keys = append(keys, debugIDKey(m.ProjectID, m.DebugID))
	}
	if m.Release != "" && m.File != "" {
		keys = append(keys, releaseKey(m.ProjectID, m.Release, m.File))
	}
	for _, k := range keys {
		if err := s.putObject(ctx, k, ".map.gz", gz.Bytes(), meta); err != nil {
			return Meta{}, err
		}
	}
	return m, nil
}

// putObject writes the data object first and the meta second: the sweeper and
// List key on the meta.
func (s *Store) putObject(ctx context.Context, key, ext string, gz, meta []byte) error {
	if err := s.Objects.Put(ctx, key+ext, gz); err != nil {
		return err
	}
	return s.Objects.Put(ctx, key+".json", meta)
}

// Ref names the map a frame needs: by debug id, else by release + URL. With
// DSYM it names the dSYM slice of the build UUID in DebugID instead.
type Ref struct {
	ProjectID string
	DebugID   string
	Release   string
	URL       string
	DSYM      bool
}

func (r Ref) key() (string, bool) {
	if !ValidProject(r.ProjectID) {
		return "", false
	}
	if r.DSYM {
		id, ok := NormalizeDebugID(r.DebugID)
		return dsymKey(r.ProjectID, id), ok
	}
	if id, ok := NormalizeDebugID(r.DebugID); ok {
		return debugIDKey(r.ProjectID, id), true
	}
	if r.Release != "" && r.URL != "" {
		return releaseKey(r.ProjectID, r.Release, r.URL), true
	}
	return "", false
}

// Load returns the decompressed map (or dSYM slice) for ref, or ErrNotFound.
func (s *Store) Load(ctx context.Context, ref Ref) ([]byte, error) {
	k, ok := ref.key()
	if !ok {
		return nil, ErrNotFound
	}
	ext, max := ".map.gz", s.MaxBytes
	if max <= 0 {
		max = DefaultMaxBytes
	}
	if ref.DSYM {
		ext, max = ".dwarf.gz", s.maxDSYMBytes()
	}
	gz, err := s.Objects.Get(ctx, k+ext)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	zr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(zr, max+1))
}

// List returns the metas of a project's maps, newest first (both indexes:
// a map uploaded with a debug id and a release is listed twice).
func (s *Store) List(ctx context.Context, projectID string) ([]Meta, error) {
	if !ValidProject(projectID) {
		return nil, fmt.Errorf("%w: project id", ErrInvalid)
	}
	objs, err := s.Objects.List(ctx, projectID+"/")
	if err != nil {
		return nil, err
	}
	out := []Meta{}
	for _, o := range objs {
		if !strings.HasSuffix(o.Key, ".json") {
			continue
		}
		b, err := s.Objects.Get(ctx, o.Key)
		if err != nil {
			continue
		}
		var m Meta
		if json.Unmarshal(b, &m) == nil {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UploadedAt.After(out[j].UploadedAt) })
	return out, nil
}

// CountProject returns how many maps (meta objects) a project has.
func (s *Store) CountProject(ctx context.Context, projectID string) (int, error) {
	if !ValidProject(projectID) {
		return 0, fmt.Errorf("%w: project id", ErrInvalid)
	}
	objs, err := s.Objects.List(ctx, projectID+"/")
	n := 0
	for _, o := range objs {
		if strings.HasSuffix(o.Key, ".json") {
			n++
		}
	}
	return n, err
}

// DeleteProject removes every map of a project and returns how many maps
// (meta objects) it removed.
func (s *Store) DeleteProject(ctx context.Context, projectID string) (int, error) {
	if !ValidProject(projectID) {
		return 0, fmt.Errorf("%w: project id", ErrInvalid)
	}
	objs, err := s.Objects.List(ctx, projectID+"/")
	if err != nil {
		return 0, err
	}
	n := 0
	for _, o := range objs {
		if err := s.Objects.Delete(ctx, o.Key); err != nil {
			return n, err
		}
		if strings.HasSuffix(o.Key, ".json") {
			n++
		}
	}
	return n, nil
}

// Sweep deletes the maps older than their project's retention (measured from
// the upload, the meta's modification time) and returns how many it removed.
// Orphan map objects without a meta are removed once older than an hour.
func (s *Store) Sweep(ctx context.Context) (int, error) {
	if s.Retention == nil {
		return 0, nil
	}
	objs, err := s.Objects.List(ctx, "")
	if err != nil {
		return 0, err
	}
	now := s.now()
	metas := map[string]time.Time{}
	for _, o := range objs {
		if k, ok := strings.CutSuffix(o.Key, ".json"); ok {
			metas[k] = o.ModTime
		}
	}
	n := 0
	for _, o := range objs {
		base, isMeta := strings.CutSuffix(o.Key, ".json")
		if !isMeta {
			base = strings.TrimSuffix(strings.TrimSuffix(o.Key, ".map.gz"), ".dwarf.gz")
		}
		project, _, _ := strings.Cut(o.Key, "/")
		ret := s.Retention(project)
		uploaded, hasMeta := metas[base]
		switch {
		case !hasMeta && now.Sub(o.ModTime) > time.Hour:
		case hasMeta && ret > 0 && now.Sub(uploaded) > ret:
		default:
			continue
		}
		if err := s.Objects.Delete(ctx, o.Key); err != nil {
			return n, err
		}
		if isMeta {
			n++
		}
	}
	return n, nil
}
