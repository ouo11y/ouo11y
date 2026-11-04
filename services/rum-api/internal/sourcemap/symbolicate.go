package sourcemap

import (
	"bytes"
	"container/list"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	gosm "github.com/go-sourcemap/sourcemap"
)

// Frame statuses.
const (
	FrameMapped   = "mapped"   // original position found
	FrameNoMap    = "no_map"   // no map uploaded for the frame's script
	FrameUnmapped = "unmapped" // a map exists but has no mapping at the position
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

// Frame is one frame of a symbolicated stack. A native frame has the binary
// image's name as Generated.File (no line), its Address, and Inlined when
// the function was inlined into the next frame (same address).
type Frame struct {
	Status    string    `json:"status"`
	Generated Position  `json:"generated"`
	Original  *Position `json:"original,omitempty"`
	Context   *Context  `json:"context,omitempty"`
	DebugID   string    `json:"debug_id,omitempty"`
	Address   string    `json:"address,omitempty"`
	Inlined   bool      `json:"inlined,omitempty"`
}

// Result is a symbolicated stack: its frames and the stack text rewritten
// with the original positions (lines that are not frames are kept).
type Result struct {
	Status     string  `json:"status"`
	Mapped     int     `json:"mapped"` // frames mapped; a native stack counts captured frames, not inlined rows
	Frames     []Frame `json:"frames"`
	Stacktrace string  `json:"stacktrace"`
}

// Request is what symbolication needs from an exception record. With Frames
// it is a native crash (ouo.crash.frames and ouo.crash.images), symbolicated
// through dSYMs; Stacktrace is then the Apple-style text it rewrites.
type Request struct {
	ProjectID  string            `json:"project_id"`
	Release    string            `json:"release"`
	Stacktrace string            `json:"stacktrace"`
	DebugIDs   map[string]string `json:"debug_ids"` // script URL -> debug id (ouo.exception.debug_ids)
	Frames     []NativeFrame     `json:"frames,omitempty"`
	Images     []NativeImage     `json:"images,omitempty"`
}

// contextLines is how many source lines are returned before and after a frame.
const contextLines = 3

// Symbolicator maps stacks with the maps and dSYMs of a Store, caching
// parsed ones.
type Symbolicator struct {
	store    *Store
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
	v       any   // *jsMap or *debugFile; nil: known miss
	size    int64 // decompressed bytes it was parsed from
	expires time.Time
}

// Options tune the cache.
type Options struct {
	CacheEntries int           // parsed maps and dSYMs kept (default 128)
	CacheBytes   int64         // their decompressed size, all together (default 512 MiB)
	CacheTTL     time.Duration // how long a parsed map is trusted (default 10 min; replicas see re-uploads after it)
	MissTTL      time.Duration // how long a miss is remembered (default 60 s)
	Now          func() time.Time
}

// NewSymbolicator returns a Symbolicator over store.
func NewSymbolicator(store *Store, o Options) *Symbolicator {
	if o.CacheEntries <= 0 {
		o.CacheEntries = 128
	}
	if o.CacheBytes <= 0 {
		o.CacheBytes = 512 << 20
	}
	if o.CacheTTL <= 0 {
		o.CacheTTL = 10 * time.Minute
	}
	if o.MissTTL <= 0 {
		o.MissTTL = time.Minute
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Symbolicator{store: store, size: o.CacheEntries, maxBytes: o.CacheBytes, ttl: o.CacheTTL, negTTL: o.MissTTL, now: o.Now,
		lru: list.New(), items: map[string]*list.Element{}}
}

// Evict drops a cached map (after a re-upload on this replica).
func (s *Symbolicator) Evict(ref Ref) {
	k, ok := ref.key()
	if !ok {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.items[k]; ok {
		s.remove(el)
	}
}

// EvictProject drops every cached map of a project.
func (s *Symbolicator) EvictProject(projectID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, el := range s.items {
		if strings.HasPrefix(k, projectID+"/") {
			s.remove(el)
		}
	}
}

// remove drops a cache element; s.mu is held.
func (s *Symbolicator) remove(el *list.Element) {
	e := el.Value.(*cacheEntry)
	s.lru.Remove(el)
	delete(s.items, e.key)
	s.bytes -= e.size
}

// cached returns ref's parsed object, loading it from the store and parsing
// it with parse on a miss. A missing or unparsable object is remembered as
// nil for MissTTL; a backend error is returned and not cached.
func (s *Symbolicator) cached(ctx context.Context, ref Ref, parse func([]byte) (any, error)) (any, error) {
	k, ok := ref.key()
	if !ok {
		return nil, nil
	}
	now := s.now()
	s.mu.Lock()
	if el, ok := s.items[k]; ok {
		e := el.Value.(*cacheEntry)
		if now.Before(e.expires) {
			s.lru.MoveToFront(el)
			s.mu.Unlock()
			return e.v, nil
		}
		s.remove(el)
	}
	s.mu.Unlock()

	var v any
	var size int64
	ttl := s.ttl
	b, err := s.store.Load(ctx, ref)
	switch {
	case errors.Is(err, ErrNotFound):
		ttl = s.negTTL
	case err != nil:
		return nil, err // backend failure: not cached
	default:
		if v, err = parse(b); err != nil {
			slog.Warn("stored debug file does not parse", "key", k, "error", err)
			v, ttl = nil, s.negTTL
		} else {
			size = int64(len(b))
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if el, ok := s.items[k]; ok { // a concurrent load won
		s.remove(el)
	}
	s.items[k] = s.lru.PushFront(&cacheEntry{key: k, v: v, size: size, expires: now.Add(ttl)})
	s.bytes += size
	// Evict the oldest past either limit, but always keep the newest entry.
	for s.lru.Len() > 1 && (s.lru.Len() > s.size || s.bytes > s.maxBytes) {
		s.remove(s.lru.Back())
	}
	return v, nil
}

// jsMap is a parsed source map. hermes is set for the map of a Hermes bytecode
// bundle (hermesc's map, or Metro's composed with it), which carries
// x_hermes_function_offsets: its generated positions are line 1 (the bytecode
// segment) and the bytecode offset as a 0-based column.
type jsMap struct {
	*gosm.Consumer
	hermes bool
}

// lookup maps a stack frame. A browser or JSC frame prints a 1-based column;
// Hermes prints the bytecode offset itself ("address at file:1:<offset>",
// lib/VM/JSError.cpp appendBytecodeFrame), the generated column of its map as
// is. The React Native SDK drops the "address at" when it normalises a stack,
// so a Hermes map says it too. One off in a Hermes column lands on the
// previous instruction, which is often another line.
func (m *jsMap) lookup(f RawFrame) (source, name string, line, column int, ok bool) {
	col := max(f.Column-1, 0)
	if f.Address || m.hermes {
		col = f.Column
	}
	return m.Source(f.Line, col)
}

var hermesMapKey = []byte(`"x_hermes_function_offsets"`)

func (s *Symbolicator) consumer(ctx context.Context, ref Ref) (*jsMap, error) {
	v, err := s.cached(ctx, ref, func(b []byte) (any, error) {
		c, err := gosm.Parse("", b)
		if err != nil {
			return nil, err
		}
		return &jsMap{Consumer: c, hermes: bytes.Contains(b, hermesMapKey)}, nil
	})
	c, _ := v.(*jsMap)
	return c, err
}

type parsedLine struct {
	text  string
	frame *RawFrame
	c     *jsMap
	id    string
}

// Symbolicate maps every frame of req.Stacktrace it can. A backend error is
// returned only when no frame could be looked up at all; otherwise the frames
// whose map failed to load are left as no_map.
func (s *Symbolicator) Symbolicate(ctx context.Context, req Request) (Result, error) {
	if len(req.Frames) > 0 {
		return s.symbolicateNative(ctx, req)
	}
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
		ref := Ref{ProjectID: req.ProjectID, DebugID: req.DebugIDs[f.URL], Release: req.Release, URL: f.URL}
		parsed[i].id, _ = NormalizeDebugID(ref.DebugID)
		lookups++
		c, err := s.consumer(ctx, ref)
		if err != nil {
			failed++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if c == nil && ref.DebugID != "" && req.Release != "" {
			// A debug id the store does not know: try the release index.
			if c, err = s.consumer(ctx, Ref{ProjectID: req.ProjectID, Release: req.Release, URL: f.URL}); err != nil {
				c = nil
			}
		}
		parsed[i].c = c
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

func status(mapped, frames int) string {
	switch {
	case mapped > 0 && mapped == frames:
		return StatusOK
	case mapped > 0:
		return StatusPartial
	}
	return StatusNoMaps
}

// funcDecl matches the line that opens a named function: a declaration, a
// variable or property holding a function or arrow, or a method.
var funcDecl = regexp.MustCompile(`(?:function\*?\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b[^(]*\(|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{)`)

// notFunctions are keywords the method form of funcDecl would take for a name.
var notFunctions = map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true, "with": true, "return": true}

// enclosingFunction finds the name of the function around (line, col) of the
// original source by walking back to the nearest unmatched "{" (or arrow) whose
// line declares a function. A heuristic: strings and comments are not parsed,
// so a brace inside one can mislead it; then the caller-name rule is used.
func enclosingFunction(content string, line, col int) string {
	if content == "" || line < 1 {
		return ""
	}
	lines := strings.Split(content, "\n")
	if line > len(lines) {
		return ""
	}
	depth := 0
	for i := line - 1; i >= 0 && i >= line-1-400; i-- {
		text := lines[i]
		if i == line-1 && col < len(text) {
			text = text[:col]
		}
		for j := len(text) - 1; j >= 0; j-- {
			switch text[j] {
			case '}':
				depth++
			case '{':
				if depth > 0 {
					depth--
					continue
				}
				if name := declName(lines, i, text[:j+1]); name != "" {
					return name
				}
			}
		}
		// A concise arrow body has no brace: `const f = () => expr` on this line.
		if i == line-1 && depth == 0 && strings.Contains(text, "=>") {
			if name := declName(lines, i, text); name != "" {
				return name
			}
		}
	}
	return ""
}

// declName returns the function name declared on head (a line up to its
// opening brace), looking one line up for signatures split over two lines.
func declName(lines []string, i int, head string) string {
	for _, cand := range []string{head, prevLine(lines, i) + " " + head} {
		m := funcDecl.FindStringSubmatch(cand)
		if m == nil {
			continue
		}
		for _, g := range m[1:] {
			if g != "" && !notFunctions[g] {
				return g
			}
		}
	}
	return ""
}

func prevLine(lines []string, i int) string {
	if i == 0 {
		return ""
	}
	return lines[i-1]
}

func nextFrame(parsed []parsedLine, i int) *parsedLine {
	for j := i + 1; j < len(parsed); j++ {
		if parsed[j].frame != nil {
			return &parsed[j]
		}
	}
	return nil
}

// formatFrame rewrites a frame line in the engine's own style.
func formatFrame(raw string, p *Position) string {
	loc := fmt.Sprintf("%s:%d:%d", p.File, p.Line, p.Column)
	indent := raw[:len(raw)-len(strings.TrimLeft(raw, " \t"))]
	if v8Frame.MatchString(raw) {
		suffix := ""
		if strings.HasSuffix(strings.TrimRight(raw, " \t"), " [in app]") {
			suffix = " [in app]"
		}
		if p.Function != "" {
			return indent + "at " + p.Function + " (" + loc + ")" + suffix
		}
		return indent + "at " + loc + suffix
	}
	return indent + p.Function + "@" + loc
}

// displaySource turns a map's source path into a project path:
// "../../src/App.tsx" and "webpack://shop/./src/App.tsx" become "src/App.tsx".
func displaySource(src string) string {
	if i := strings.Index(src, "://"); i >= 0 {
		rest := src[i+3:]
		if strings.HasPrefix(src, "webpack") {
			if _, after, ok := strings.Cut(rest, "/"); ok {
				rest = after
			}
		}
		src = rest
	}
	src = path.Clean(src)
	for strings.HasPrefix(src, "../") {
		src = src[3:]
	}
	return strings.TrimPrefix(src, "./")
}

func sourceContext(content string, line int) *Context {
	if content == "" || line < 1 {
		return nil
	}
	lines := strings.Split(content, "\n")
	if line > len(lines) {
		return nil
	}
	clip := func(s string) string {
		if len(s) > 300 {
			return s[:300] + "…"
		}
		return s
	}
	c := &Context{Line: clip(lines[line-1]), Pre: []string{}, Post: []string{}}
	for i := max(0, line-1-contextLines); i < line-1; i++ {
		c.Pre = append(c.Pre, clip(lines[i]))
	}
	for i := line; i < min(len(lines), line+contextLines); i++ {
		c.Post = append(c.Post, clip(lines[i]))
	}
	return c
}
