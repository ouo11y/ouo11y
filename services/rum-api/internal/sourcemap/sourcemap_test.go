package sourcemap

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

const testDebugID = "c0ffee00-0000-4000-8000-000000000001"

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func newStore(t *testing.T) *Store {
	t.Helper()
	o, err := NewFSObjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &Store{Objects: o}
}

func TestParseFrame(t *testing.T) {
	cases := []struct {
		line string
		want RawFrame
		ok   bool
	}{
		{"    at o (https://a.example/x.js:1:64)", RawFrame{"o", "https://a.example/x.js", 1, 64}, true},
		{"    at https://a.example/x.js:2:5", RawFrame{"", "https://a.example/x.js", 2, 5}, true},
		{"    at async load (http://localhost:4173/assets/index.js:3:9)", RawFrame{"load", "http://localhost:4173/assets/index.js", 3, 9}, true},
		{"    at new Cart (https://a.example/x.js:1:1)", RawFrame{"new Cart", "https://a.example/x.js", 1, 1}, true},
		{"    at render (address at index.android.bundle:1:9123)", RawFrame{"render", "index.android.bundle", 1, 9123}, true},
		{"o@https://a.example/x.js:1:64", RawFrame{"o", "https://a.example/x.js", 1, 64}, true},
		{"@http://localhost:4173/assets/index.js:40:1234", RawFrame{"", "http://localhost:4173/assets/index.js", 40, 1234}, true},
		{"TypeError: x is undefined", RawFrame{}, false},
		{"    at native", RawFrame{}, false},
		{"    at eval (eval at <anonymous> (https://a.example/x.js:1:1), <anonymous>:1:1)", RawFrame{}, false},
	}
	for _, c := range cases {
		got, ok := ParseFrame(c.line)
		if ok != c.ok || got != c.want {
			t.Errorf("ParseFrame(%q) = %+v, %v; want %+v, %v", c.line, got, ok, c.want, c.ok)
		}
	}
}

func TestURLPathAndDebugID(t *testing.T) {
	for in, want := range map[string]string{
		"https://cdn.example/assets/index-B3x9.js?v=1": "/assets/index-B3x9.js",
		"http://localhost:4173/assets/index.js":        "/assets/index.js",
		"assets/index.js":                              "/assets/index.js",
		"/assets/../index.js":                          "/index.js",
		"index.android.bundle":                         "/index.android.bundle",
	} {
		if got := URLPath(in); got != want {
			t.Errorf("URLPath(%q) = %q, want %q", in, got, want)
		}
	}
	if id, ok := NormalizeDebugID("C0FFEE0000004000800000000000000 1"); ok {
		t.Errorf("accepted %q", id)
	}
	if id, ok := NormalizeDebugID("C0FFEE00000040008000000000000001"); !ok || id != testDebugID {
		t.Errorf("NormalizeDebugID = %q, %v", id, ok)
	}
}

func TestPutValidates(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	m := fixture(t, "app.min.js.map")
	for name, u := range map[string]Upload{
		"bad project":      {ProjectID: "../x", DebugID: testDebugID, Map: m},
		"no key":           {ProjectID: "shop", Map: m},
		"release, no file": {ProjectID: "shop", Release: "1.0", Map: m},
		"bad debug id":     {ProjectID: "shop", DebugID: "nope", Map: m},
		"not json":         {ProjectID: "shop", DebugID: testDebugID, Map: []byte("<html>")},
		"not a v3 map":     {ProjectID: "shop", DebugID: testDebugID, Map: []byte(`{"version":2}`)},
	} {
		if _, err := s.Put(ctx, u); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
	s.MaxBytes = 100
	if _, err := s.Put(ctx, Upload{ProjectID: "shop", DebugID: testDebugID, Map: m}); !errors.Is(err, ErrTooLarge) {
		t.Errorf("err = %v, want ErrTooLarge", err)
	}
}

func TestSymbolicateByDebugID(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	meta, err := s.Put(ctx, Upload{ProjectID: "shop", DebugID: strings.ToUpper(testDebugID), Map: fixture(t, "app.min.js.map")})
	if err != nil {
		t.Fatal(err)
	}
	if meta.DebugID != testDebugID || meta.Sources != 1 {
		t.Fatalf("meta = %+v", meta)
	}
	sym := NewSymbolicator(s, Options{})
	stack := string(fixture(t, "stack-v8.txt"))
	res, err := sym.Symbolicate(ctx, Request{ProjectID: "shop", Stacktrace: stack,
		DebugIDs: map[string]string{"https://shop.example/assets/app.min.js": testDebugID}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusOK || res.Mapped != 3 || len(res.Frames) != 3 {
		t.Fatalf("result = %+v", res)
	}
	want := []Position{
		{File: "src/app.ts", Line: 10, Function: "totalOf"},
		{File: "src/app.ts", Line: 21, Function: "checkout"},
		{File: "src/app.ts", Line: 28, Function: "run"},
	}
	for i, w := range want {
		o := res.Frames[i].Original
		if o == nil || o.File != w.File || o.Line != w.Line || o.Function != w.Function {
			t.Errorf("frame %d original = %+v, want %+v", i, o, w)
		}
		if res.Frames[i].DebugID != testDebugID {
			t.Errorf("frame %d debug id = %q", i, res.Frames[i].DebugID)
		}
	}
	c := res.Frames[0].Context
	if c == nil || !strings.Contains(c.Line, `throw new RangeError("negative price")`) || len(c.Pre) != 3 || len(c.Post) != 3 {
		t.Errorf("context = %+v", c)
	}
	if !strings.HasPrefix(res.Stacktrace, "RangeError: negative price\n    at totalOf (src/app.ts:10:") ||
		!strings.HasSuffix(res.Stacktrace, "\n    at native") {
		t.Errorf("stacktrace =\n%s", res.Stacktrace)
	}
}

func TestSymbolicateByReleaseAndOtherProject(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if _, err := s.Put(ctx, Upload{ProjectID: "shop", Release: "1.4.2", File: "assets/app.min.js", Map: fixture(t, "app.min.js.map")}); err != nil {
		t.Fatal(err)
	}
	sym := NewSymbolicator(s, Options{})
	// Another host, same path: the release index ignores the host.
	stack := strings.ReplaceAll(string(fixture(t, "stack-v8.txt")), "https://shop.example", "http://localhost:4173")
	res, err := sym.Symbolicate(ctx, Request{ProjectID: "shop", Release: "1.4.2", Stacktrace: stack})
	if err != nil || res.Status != StatusOK {
		t.Fatalf("by release: %+v, %v", res, err)
	}
	// An unknown debug id falls back to the release index.
	res, _ = sym.Symbolicate(ctx, Request{ProjectID: "shop", Release: "1.4.2", Stacktrace: stack,
		DebugIDs: map[string]string{"http://localhost:4173/assets/app.min.js": testDebugID}})
	if res.Status != StatusOK {
		t.Errorf("debug id miss, release hit: %+v", res)
	}
	for name, req := range map[string]Request{
		"other release": {ProjectID: "shop", Release: "1.4.3", Stacktrace: stack},
		"other project": {ProjectID: "blog", Release: "1.4.2", Stacktrace: stack},
		"no release":    {ProjectID: "shop", Stacktrace: stack},
	} {
		res, err := sym.Symbolicate(ctx, req)
		if err != nil || res.Status != StatusNoMaps || res.Frames[0].Status != FrameNoMap || res.Stacktrace != strings.TrimRight(stack, "\n") {
			t.Errorf("%s: %+v, %v", name, res, err)
		}
	}
}

type countingObjects struct {
	Objects
	gets int
	fail error
}

func (c *countingObjects) Get(ctx context.Context, key string) ([]byte, error) {
	c.gets++
	if c.fail != nil {
		return nil, c.fail
	}
	return c.Objects.Get(ctx, key)
}

func TestCacheAndErrors(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if _, err := s.Put(ctx, Upload{ProjectID: "shop", DebugID: testDebugID, Map: fixture(t, "app.min.js.map")}); err != nil {
		t.Fatal(err)
	}
	co := &countingObjects{Objects: s.Objects}
	s.Objects = co
	now := time.Unix(1000, 0)
	sym := NewSymbolicator(s, Options{Now: func() time.Time { return now }})
	req := Request{ProjectID: "shop", Stacktrace: string(fixture(t, "stack-v8.txt")),
		DebugIDs: map[string]string{"https://shop.example/assets/app.min.js": testDebugID}}
	for range 3 {
		if res, err := sym.Symbolicate(ctx, req); err != nil || res.Status != StatusOK {
			t.Fatal(res, err)
		}
	}
	if co.gets != 1 {
		t.Errorf("gets = %d, want 1 (one load for 3 x 3 frames)", co.gets)
	}
	// Misses are cached too, for MissTTL.
	miss := Request{ProjectID: "shop", Stacktrace: req.Stacktrace, Release: "9.9"}
	sym.Symbolicate(ctx, miss)
	sym.Symbolicate(ctx, miss)
	if co.gets != 2 {
		t.Errorf("gets = %d after two misses, want 2", co.gets)
	}
	// A backend failure is returned, and not cached.
	sym.Evict(Ref{ProjectID: "shop", DebugID: testDebugID})
	co.fail = errors.New("bucket down")
	if _, err := sym.Symbolicate(ctx, req); err == nil {
		t.Error("want an error when every lookup fails")
	}
	co.fail = nil
	if res, err := sym.Symbolicate(ctx, req); err != nil || res.Status != StatusOK {
		t.Errorf("after recovery: %+v, %v", res, err)
	}
	// Past the TTL the map is read again.
	before := co.gets
	now = now.Add(11 * time.Minute)
	sym.Symbolicate(ctx, req)
	if co.gets != before+1 {
		t.Errorf("gets = %d, want %d after the TTL", co.gets, before+1)
	}
}

func TestListDeleteSweep(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	now := time.Now()
	s.Now = func() time.Time { return now }
	m := fixture(t, "app.min.js.map")
	if _, err := s.Put(ctx, Upload{ProjectID: "shop", DebugID: testDebugID, Release: "1.0", File: "/a.js", Map: m}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(ctx, Upload{ProjectID: "blog", DebugID: testDebugID, Map: m}); err != nil {
		t.Fatal(err)
	}
	ms, err := s.List(ctx, "shop")
	if err != nil || len(ms) != 2 {
		t.Fatalf("list = %+v, %v (debug id and release index)", ms, err)
	}
	// Retention 1h for shop, forever for blog; "now" moves 2h on.
	s.Retention = func(p string) time.Duration {
		if p == "shop" {
			return time.Hour
		}
		return 0
	}
	if n, err := s.Sweep(ctx); err != nil || n != 0 {
		t.Fatalf("sweep before expiry = %d, %v", n, err)
	}
	now = now.Add(2 * time.Hour)
	if n, err := s.Sweep(ctx); err != nil || n != 2 {
		t.Fatalf("sweep = %d, %v; want 2", n, err)
	}
	if ms, _ := s.List(ctx, "shop"); len(ms) != 0 {
		t.Errorf("shop after sweep = %+v", ms)
	}
	if n, err := s.DeleteProject(ctx, "blog"); err != nil || n != 1 {
		t.Errorf("delete blog = %d, %v", n, err)
	}
	if _, err := s.Load(ctx, Ref{ProjectID: "blog", DebugID: testDebugID}); !errors.Is(err, ErrNotFound) {
		t.Errorf("load after delete: %v", err)
	}
}

func TestEnclosingFunction(t *testing.T) {
	src := strings.Join([]string{
		"export function RenderBomb({ armed }: { armed: boolean }) {", // 1
		"  if (armed) {",                        // 2
		`    throw new Error("x");`,             // 3
		"  }",                                   // 4
		"  return null;",                        // 5
		"}",                                     // 6
		"const onClick = async (e: Event) => {", // 7
		"  go(e);",                              // 8
		"};",                                    // 9
		"class A {",                             // 10
		"  private save(): void {",              // 11
		"    for (const x of y) { use(x); }",    // 12
		"  }",                                   // 13
		"}",                                     // 14
		"const f = (n) => n.boom();",            // 15
		"top();",                                // 16
	}, "\n")
	for _, c := range []struct {
		line, col int
		want      string
	}{{3, 4, "RenderBomb"}, {5, 2, "RenderBomb"}, {8, 2, "onClick"}, {12, 27, "save"}, {15, 17, "f"}, {16, 0, ""}} {
		if got := enclosingFunction(src, c.line, c.col); got != c.want {
			t.Errorf("line %d: %q, want %q", c.line, got, c.want)
		}
	}
}

func TestDisplaySource(t *testing.T) {
	for in, want := range map[string]string{
		"../../src/App.tsx":            "src/App.tsx",
		"webpack://shop/./src/App.tsx": "src/App.tsx",
		"./src/a.ts":                   "src/a.ts",
		"src/a.ts":                     "src/a.ts",
	} {
		if got := displaySource(in); got != want {
			t.Errorf("displaySource(%q) = %q, want %q", in, got, want)
		}
	}
}
