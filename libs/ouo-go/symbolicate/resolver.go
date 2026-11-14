// Package symbolicate resolves a recorded stack to original files, lines and functions
// with the debug files a client's CI uploaded to Muninn (ADR-0026, Muninn spec section
// 13): JavaScript source maps, Hermes maps included, and dSYM slices for native iOS
// frames. It replaces rum-api's internal/sourcemap; the parsing and naming rules are
// rum-api's, the lookup is ADR-0022's:
//
//   - a frame whose script URL has a debug id in the exception's ouo.exception.debug_ids
//     is resolved with that id's map or not at all (no_map), never with another build's;
//   - a frame without one lists the ids uploaded for (service.version, the script's URL
//     path) and is mapped only when there is exactly one; several are ambiguous (OTA
//     bundles of one store version, a re-deploy under the same version) and the frame
//     is kept as recorded.
//
// Parsed files are cached in memory: an LRU bounded by entry count and bytes, files
// trusted for CacheTTL (they are write-once), and misses remembered for MissTTL so a
// late upload applies a minute later.
package symbolicate

import (
	"bytes"
	"container/list"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	gosm "github.com/go-sourcemap/sourcemap"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// Frame statuses.
const (
	FrameMapped      = "mapped"      // original position found
	FrameNoMap       = "no_map"      // no debug file for the frame (or its named one is missing or unreadable)
	FrameAmbiguous   = "ambiguous"   // no debug id, and the release has several builds of the script's path
	FrameUnmapped    = "unmapped"    // a debug file exists but has nothing at the position
	FrameUnavailable = "unavailable" // the debug file could not be read (Muninn failed); kept as recorded
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

// Context is the original source around a mapped frame (from the map's sourcesContent).
type Context struct {
	Pre  []string `json:"pre"`
	Line string   `json:"line"`
	Post []string `json:"post"`
}

// Frame is one frame of a resolved stack. A native frame has the binary image's name as
// Generated.File (no line), its Address, and Inlined when the function was inlined into
// the next row (same address).
type Frame struct {
	Status    string    `json:"status"`
	Generated Position  `json:"generated"`
	Original  *Position `json:"original,omitempty"`
	Context   *Context  `json:"context,omitempty"`
	DebugID   string    `json:"debug_id,omitempty"`
	Address   string    `json:"address,omitempty"`
	Inlined   bool      `json:"inlined,omitempty"`
}

// Result is a resolved stack: its frames and the stack text rewritten with the original
// positions (lines that are not frames, and frames not mapped, are kept as recorded).
type Result struct {
	Status     string  `json:"status"`
	Mapped     int     `json:"mapped"` // frames mapped; a native stack counts captured frames, not inlined rows
	Frames     []Frame `json:"frames"`
	Stacktrace string  `json:"stacktrace"`
}

// Exception is what resolution needs from an exception record (FromEvent builds it).
type Exception struct {
	Project    string            // ouo.project.id
	Release    string            // service.version
	Stacktrace string            // exception.stacktrace
	DebugIDs   map[string]string // ouo.exception.debug_ids: script URL -> debug id
	// Frames and Images are a native crash (ouo.crash.frames, ouo.crash.images),
	// resolved through dSYMs; Stacktrace is then the Apple-style text it rewrites.
	Frames []NativeFrame
	Images []NativeImage
}

// Source is where debug files come from. *ouogo.Muninn is one.
type Source interface {
	// DebugFile returns a file's decompressed bytes; an error matching ouogo.ErrNotFound
	// when there is none.
	DebugFile(ctx context.Context, project, kind, debugID string) ([]byte, error)
	// DebugFileIDs returns the debug ids uploaded for a release and file path.
	DebugFileIDs(ctx context.Context, project, kind, release, file string) ([]string, error)
}

// Options tune the cache. Zero values take the defaults.
type Options struct {
	CacheEntries int           // parsed files kept (default 128)
	CacheBytes   int64         // their estimated size in memory, all together (default 512 MiB)
	CacheTTL     time.Duration // how long a parsed file is kept (default 1 h: files are write-once)
	MissTTL      time.Duration // how long a miss and a candidate list are kept (default 60 s)
	Now          func() time.Time
}

// parsedFactor estimates a parsed file's memory from its decompressed size.
const parsedFactor = 2

// Resolver resolves stacks with the debug files of a Source. It is safe for concurrent use.
type Resolver struct {
	src      Source
	size     int
	maxBytes int64
	ttl      time.Duration
	missTTL  time.Duration
	now      func() time.Time

	mu    sync.Mutex
	lru   *list.List
	items map[string]*list.Element
	bytes int64
}

type cacheEntry struct {
	key     string
	v       any   // *jsMap, *debugFile, []string (candidates) or nil (a known miss)
	size    int64 // estimated memory
	expires time.Time
}

// New returns a Resolver over src.
func New(src Source, o Options) *Resolver {
	if o.CacheEntries <= 0 {
		o.CacheEntries = 128
	}
	if o.CacheBytes <= 0 {
		o.CacheBytes = 512 << 20
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
	return &Resolver{src: src, size: o.CacheEntries, maxBytes: o.CacheBytes, ttl: o.CacheTTL, missTTL: o.MissTTL, now: o.Now,
		lru: list.New(), items: map[string]*list.Element{}}
}

// CachedBytes is the estimated memory of the files in the cache.
func (r *Resolver) CachedBytes() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bytes
}

// remove drops a cache element; r.mu is held.
func (r *Resolver) remove(el *list.Element) {
	e := el.Value.(*cacheEntry)
	r.lru.Remove(el)
	delete(r.items, e.key)
	r.bytes -= e.size
}

// lookup is one Resolve call: it remembers the keys whose load failed, so a stack of
// fifty frames on a Muninn that is down costs one failed request, not fifty.
type lookup struct {
	r    *Resolver
	ctx  context.Context
	errs map[string]error
}

func (r *Resolver) lookup(ctx context.Context) *lookup {
	return &lookup{r: r, ctx: ctx, errs: map[string]error{}}
}

// cached returns key's value, calling load on a miss. A load that returns a nil value
// is a miss and is kept for MissTTL; a value for ttl; an error is not cached.
func (l *lookup) cached(key string, ttl time.Duration, load func() (any, int64, error)) (any, error) {
	if err, ok := l.errs[key]; ok {
		return nil, err
	}
	r := l.r
	now := r.now()
	r.mu.Lock()
	if el, ok := r.items[key]; ok {
		e := el.Value.(*cacheEntry)
		if now.Before(e.expires) {
			r.lru.MoveToFront(el)
			r.mu.Unlock()
			return e.v, nil
		}
		r.remove(el)
	}
	r.mu.Unlock()

	v, size, err := load()
	if err != nil {
		l.errs[key] = err
		return nil, err
	}
	if v == nil {
		ttl, size = r.missTTL, 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if el, ok := r.items[key]; ok { // a concurrent load won
		r.remove(el)
	}
	r.items[key] = r.lru.PushFront(&cacheEntry{key: key, v: v, size: size, expires: now.Add(ttl)})
	r.bytes += size
	// Evict the oldest past either limit, but always keep the newest entry.
	for r.lru.Len() > 1 && (r.lru.Len() > r.size || r.bytes > r.maxBytes) {
		r.remove(r.lru.Back())
	}
	return v, nil
}

// file loads and parses one debug file. A missing file, a request Muninn would refuse
// and a file that does not parse (Muninn stores uploads opaque) are all misses.
func (l *lookup) file(project, kind, id string, parse func([]byte) (any, error)) (any, error) {
	return l.cached(kind+"/"+project+"/"+id, l.r.ttl, func() (any, int64, error) {
		b, err := l.r.src.DebugFile(l.ctx, project, kind, id)
		if miss(err) {
			return nil, 0, nil
		}
		if err != nil {
			return nil, 0, err
		}
		v, err := parse(b)
		if err != nil || v == nil {
			return nil, 0, nil
		}
		return v, int64(len(b)) * parsedFactor, nil
	})
}

func miss(err error) bool {
	var bad *ouogo.BadRequestError
	return errors.Is(err, ouogo.ErrNotFound) || errors.As(err, &bad)
}

// jsMap is a parsed source map. hermes is set for the map of a Hermes bytecode bundle
// (hermesc's map, or Metro's composed with it), which carries x_hermes_function_offsets:
// its generated positions are line 1 (the bytecode segment) and the bytecode offset as
// a 0-based column.
type jsMap struct {
	*gosm.Consumer
	hermes bool
}

// lookup maps a stack frame. A browser or JSC frame prints a 1-based column; Hermes
// prints the bytecode offset itself ("address at file:1:<offset>"), the generated column
// of its map as is. The React Native SDK drops the "address at" when it normalises a
// stack, so a Hermes map says it too. One off in a Hermes column lands on the previous
// instruction, which is often another line.
func (m *jsMap) lookup(f RawFrame) (source, name string, line, column int, ok bool) {
	col := max(f.Column-1, 0)
	if f.Address || m.hermes {
		col = f.Column
	}
	return m.Source(f.Line, col)
}

var hermesMapKey = []byte(`"x_hermes_function_offsets"`)

func parseMap(b []byte) (any, error) {
	c, err := gosm.Parse("", b)
	if err != nil {
		return nil, err
	}
	return &jsMap{Consumer: c, hermes: bytes.Contains(b, hermesMapKey)}, nil
}

func (l *lookup) sourceMap(project, id string) (*jsMap, error) {
	v, err := l.file(project, ouogo.DebugFileSourceMap, id, parseMap)
	m, _ := v.(*jsMap)
	return m, err
}

// byRelease returns the map of a release and script URL when exactly one build was
// uploaded for them; ambiguous when several were. Candidate lists are kept for MissTTL
// only: a second upload under the same release must turn a frame ambiguous soon.
func (l *lookup) byRelease(project, release, scriptURL string) (m *jsMap, id string, ambiguous bool, err error) {
	if release == "" {
		return nil, "", false, nil
	}
	file := ouogo.DebugFilePath(scriptURL)
	v, err := l.cached("ids/"+project+"/"+file+"\x00"+release, l.r.missTTL, func() (any, int64, error) {
		ids, err := l.r.src.DebugFileIDs(l.ctx, project, ouogo.DebugFileSourceMap, release, file)
		if miss(err) || err == nil && len(ids) == 0 {
			return nil, 0, nil
		}
		return ids, 0, err
	})
	ids, _ := v.([]string)
	switch {
	case err != nil || len(ids) == 0:
		return nil, "", false, err
	case len(ids) > 1:
		return nil, "", true, nil
	}
	m, err = l.sourceMap(project, ids[0])
	return m, ids[0], false, err
}

type parsedLine struct {
	text      string
	frame     *RawFrame
	c         *jsMap
	id        string
	ambiguous bool
	failed    bool
}

// Resolve resolves every frame of e it can: a native crash (e.Frames set) through
// ResolveNative, otherwise e.Stacktrace as a JavaScript stack. An error is returned only
// when every lookup failed (Muninn down); a frame whose file could not be read while
// others could is FrameUnavailable. Lines that are not frames are kept.
func (r *Resolver) Resolve(ctx context.Context, e Exception) (Result, error) {
	if len(e.Frames) > 0 {
		return r.ResolveNative(ctx, e)
	}
	l := r.lookup(ctx)
	lines := strings.Split(strings.TrimRight(e.Stacktrace, "\n"), "\n")
	parsed := make([]parsedLine, len(lines))
	var firstErr error
	lookups, failed := 0, 0
	for i, text := range lines {
		p := &parsed[i]
		p.text = text
		f, ok := ParseFrame(text)
		if !ok {
			continue
		}
		p.frame = &f
		var err error
		if raw := e.DebugIDs[f.URL]; raw != "" {
			// A frame that names its build is only ever mapped with that build's map; a
			// malformed id names no file at all.
			id, ok := ouogo.NormalizeDebugID(raw)
			if !ok {
				continue
			}
			p.id = id
			lookups++
			p.c, err = l.sourceMap(e.Project, id)
		} else {
			lookups++
			p.c, p.id, p.ambiguous, err = l.byRelease(e.Project, e.Release, f.URL)
		}
		if err != nil {
			p.failed = true
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
		switch {
		case p.failed:
			fr.Status = FrameUnavailable
		case p.ambiguous:
			fr.Status = FrameAmbiguous
		case p.c != nil:
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
