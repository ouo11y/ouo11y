// Package symbolicate is a prototype of the ouo-go library that turns a
// minified JavaScript stack trace into original files, lines and functions
// when someone opens an error (ADR-0022). It reads source maps from a Source,
// which in the BFF is a client of the debug-file store, and caches parsed maps.
//
// The parsing and naming rules are rum-api's (services/rum-api/internal/
// sourcemap): stack.go and helpers.go are copies. What is new is the lookup:
// every stored map has a debug id, and the release index is a list of
// candidate ids, so a frame never takes the map of another build.
package symbolicate

import (
	"bytes"
	"container/list"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"sync"
	"time"

	gosm "github.com/go-sourcemap/sourcemap"

	"github.com/ouo11y/ouo11y/project/agents/symbolication/prototype/debugfiles"
)

// Frame statuses.
const (
	FrameMapped    = "mapped"    // original position found
	FrameNoMap     = "no_map"    // no map uploaded for the frame's script
	FrameUnmapped  = "unmapped"  // a map exists but has no mapping at the position
	FrameAmbiguous = "ambiguous" // no debug id, and the release has several builds of this path
)

// Result statuses.
const (
	StatusOK      = "ok"      // every frame mapped
	StatusPartial = "partial" // some frames mapped
	StatusNoMaps  = "no_maps" // no frame mapped
)

// Position is a place in generated or original code (1-based line and column).
type Position struct {
	File     string `json:"file"`
	Line     int    `json:"line"`
	Column   int    `json:"column"`
	Function string `json:"function,omitempty"`
}

// Context is the original source around a mapped frame (from sourcesContent).
type Context struct {
	Pre  []string `json:"pre"`
	Line string   `json:"line"`
	Post []string `json:"post"`
}

// Frame is one frame of a symbolicated stack.
type Frame struct {
	Status    string    `json:"status"`
	Generated Position  `json:"generated"`
	Original  *Position `json:"original,omitempty"`
	Context   *Context  `json:"context,omitempty"`
	DebugID   string    `json:"debug_id,omitempty"`
}

// Result is a symbolicated stack: its frames and the stack text rewritten
// with the original positions (lines that are not frames are kept).
type Result struct {
	Status     string  `json:"status"`
	Mapped     int     `json:"mapped"`
	Frames     []Frame `json:"frames"`
	Stacktrace string  `json:"stacktrace"`
}

// Request is what symbolication needs from an exception record.
type Request struct {
	ProjectID  string            `json:"project_id"` // ouo.project.id
	Release    string            `json:"release"`    // service.version
	Stacktrace string            `json:"stacktrace"` // exception.stacktrace
	DebugIDs   map[string]string `json:"debug_ids"`  // ouo.exception.debug_ids: script URL -> debug id
}

// Source is where maps come from. debugfiles.Client is one.
type Source interface {
	// Map returns the decompressed map of a debug id; an error wrapping
	// fs.ErrNotExist when there is none.
	Map(ctx context.Context, project, debugID string) ([]byte, error)
	// Candidates returns the debug ids uploaded for a release and URL path.
	Candidates(ctx context.Context, project, release, urlPath string) ([]string, error)
}

// Options tune the cache.
type Options struct {
	CacheEntries int           // parsed maps kept (default 64)
	CacheBytes   int64         // their decompressed size, all together (default 256 MiB)
	CacheTTL     time.Duration // how long a parsed map or a candidate list is kept (default 1 h: files are write-once)
	MissTTL      time.Duration // how long a miss is remembered (default 60 s)
	Now          func() time.Time
}

// Symbolicator maps stacks with the maps of a Source.
type Symbolicator struct {
	src      Source
	size     int
	maxBytes int64
	ttl      time.Duration
	negTTL   time.Duration
	now      func() time.Time

	mu    sync.Mutex
	lru   *list.List
	items map[string]*list.Element
	bytes int64
}

type cacheEntry struct {
	key     string
	v       any   // *jsMap, []string (candidates) or nil (known miss)
	size    int64 // decompressed bytes a map was parsed from
	expires time.Time
}

// New returns a Symbolicator over src.
func New(src Source, o Options) *Symbolicator {
	if o.CacheEntries <= 0 {
		o.CacheEntries = 64
	}
	if o.CacheBytes <= 0 {
		o.CacheBytes = 256 << 20
	}
	if o.CacheTTL <= 0 {
		o.CacheTTL = time.Hour
	}
	if o.MissTTL <= 0 {
		o.MissTTL = time.Minute
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Symbolicator{src: src, size: o.CacheEntries, maxBytes: o.CacheBytes, ttl: o.CacheTTL, negTTL: o.MissTTL, now: o.Now,
		lru: list.New(), items: map[string]*list.Element{}}
}

// CachedBytes is the decompressed size of the maps in the cache.
func (s *Symbolicator) CachedBytes() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bytes
}

func (s *Symbolicator) remove(el *list.Element) {
	e := el.Value.(*cacheEntry)
	s.lru.Remove(el)
	delete(s.items, e.key)
	s.bytes -= e.size
}

// cached returns the value of key, calling load on a miss. A load that
// returns (nil, 0, nil) is a miss and is remembered for MissTTL; an error is
// returned and not cached.
func (s *Symbolicator) cached(key string, load func() (any, int64, error)) (any, error) {
	now := s.now()
	s.mu.Lock()
	if el, ok := s.items[key]; ok {
		e := el.Value.(*cacheEntry)
		if now.Before(e.expires) {
			s.lru.MoveToFront(el)
			s.mu.Unlock()
			return e.v, nil
		}
		s.remove(el)
	}
	s.mu.Unlock()

	v, size, err := load()
	if err != nil {
		return nil, err
	}
	ttl := s.ttl
	if v == nil {
		ttl = s.negTTL
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.items[key]; ok { // a concurrent load won
		s.remove(el)
	}
	s.items[key] = s.lru.PushFront(&cacheEntry{key: key, v: v, size: size, expires: now.Add(ttl)})
	s.bytes += size
	for s.lru.Len() > 1 && (s.lru.Len() > s.size || s.bytes > s.maxBytes) {
		s.remove(s.lru.Back())
	}
	return v, nil
}

// jsMap is a parsed source map. hermes is set for the map of a Hermes
// bytecode bundle, whose generated column is the bytecode offset, 0-based.
type jsMap struct {
	*gosm.Consumer
	hermes bool
}

func (m *jsMap) lookup(f RawFrame) (source, name string, line, column int, ok bool) {
	col := max(f.Column-1, 0)
	if f.Address || m.hermes {
		col = f.Column
	}
	return m.Source(f.Line, col)
}

var hermesMapKey = []byte(`"x_hermes_function_offsets"`)

// byID returns the parsed map of a debug id; nil when there is none or it
// does not parse (the store is opaque and does not check uploads).
func (s *Symbolicator) byID(ctx context.Context, project, id string) (*jsMap, error) {
	v, err := s.cached("map/"+project+"/"+id, func() (any, int64, error) {
		b, err := s.src.Map(ctx, project, id)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, 0, nil
		}
		if err != nil {
			return nil, 0, err
		}
		c, err := gosm.Parse("", b)
		if err != nil {
			return nil, 0, nil
		}
		return &jsMap{Consumer: c, hermes: bytes.Contains(b, hermesMapKey)}, int64(len(b)), nil
	})
	m, _ := v.(*jsMap)
	return m, err
}

// byRelease returns the map of a release and URL path when exactly one build
// was uploaded for them. Two builds of one path (OTA bundles, a re-deploy
// under the same version) are ambiguous: mapping with either would show
// confident, wrong lines.
func (s *Symbolicator) byRelease(ctx context.Context, project, release, scriptURL string) (m *jsMap, id string, ambiguous bool, err error) {
	if release == "" {
		return nil, "", false, nil
	}
	p := debugfiles.URLPath(scriptURL)
	v, err := s.cached("rel/"+project+"/"+release+"\x00"+p, func() (any, int64, error) {
		ids, err := s.src.Candidates(ctx, project, release, p)
		if err != nil || len(ids) == 0 {
			return nil, 0, err
		}
		return ids, 0, nil
	})
	ids, _ := v.([]string)
	if err != nil || len(ids) == 0 {
		return nil, "", false, err
	}
	if len(ids) > 1 {
		return nil, "", true, nil
	}
	m, err = s.byID(ctx, project, ids[0])
	return m, ids[0], false, err
}

type parsedLine struct {
	text      string
	frame     *RawFrame
	c         *jsMap
	id        string
	ambiguous bool
}

// Symbolicate maps every frame of req.Stacktrace it can. A backend error is
// returned only when no frame could be looked up at all; otherwise the frames
// whose map failed to load are left as no_map.
func (s *Symbolicator) Symbolicate(ctx context.Context, req Request) (Result, error) {
	lines := strings.Split(strings.TrimRight(req.Stacktrace, "\n"), "\n")
	parsed := make([]parsedLine, len(lines))
	var firstErr error
	lookups, failed := 0, 0
	for i, l := range lines {
		parsed[i].text = l
		f, ok := ParseFrame(l)
		if !ok {
			continue
		}
		parsed[i].frame = &f
		lookups++
		var err error
		if id, ok := debugfiles.NormalizeDebugID(req.DebugIDs[f.URL]); ok {
			// A frame that names its build is only ever mapped with that build's map.
			parsed[i].id = id
			parsed[i].c, err = s.byID(ctx, req.ProjectID, id)
		} else {
			parsed[i].c, parsed[i].id, parsed[i].ambiguous, err = s.byRelease(ctx, req.ProjectID, req.Release, f.URL)
		}
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	if lookups > 0 && failed == lookups {
		return Result{}, fmt.Errorf("load source maps: %w", firstErr)
	}

	res := Result{Frames: []Frame{}}
	out := make([]string, len(lines))
	frames := 0
	for i, p := range parsed {
		out[i] = p.text
		if p.frame == nil {
			continue
		}
		frames++
		f := *p.frame
		fr := Frame{Status: FrameNoMap, Generated: Position{File: f.URL, Line: f.Line, Column: f.Column, Function: f.Function}, DebugID: p.id}
		if p.ambiguous {
			fr.Status = FrameAmbiguous
		}
		if p.c != nil {
			fr.Status = FrameUnmapped
			if src, _, line, col, ok := p.c.lookup(f); ok && src != "" {
				content := p.c.SourceContent(src)
				orig := &Position{File: displaySource(src), Line: line, Column: col + 1, Function: f.Function}
				if name := enclosingFunction(content, line, col); name != "" {
					orig.Function = name
				} else if caller := nextFrame(parsed, i); caller != nil && caller.c != nil {
					// Caller-name rule: the name at the caller's call site is this frame's function.
					if _, name, _, _, ok := caller.c.lookup(*caller.frame); ok && name != "" {
						orig.Function = name
					}
				}
				fr.Status, fr.Original = FrameMapped, orig
				fr.Context = sourceContext(content, line)
				res.Mapped++
				out[i] = formatFrame(p.text, orig)
			}
		}
		res.Frames = append(res.Frames, fr)
	}
	res.Status = status(res.Mapped, frames)
	res.Stacktrace = strings.Join(out, "\n")
	return res, nil
}
