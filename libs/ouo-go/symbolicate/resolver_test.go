package symbolicate

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

var _ Source = (*ouogo.Muninn)(nil)

// fakeMuninn is a Source with Muninn's semantics (spec 13.3): files by kind and debug id,
// candidate lists by kind, release and normalised file. fail makes every read fail.
type fakeMuninn struct {
	mu      sync.Mutex
	files   map[string][]byte   // kind/id
	release map[string][]string // kind/release/file
	fail    error
	reads   int
}

func newFake() *fakeMuninn {
	return &fakeMuninn{files: map[string][]byte{}, release: map[string][]string{}}
}

func (f *fakeMuninn) put(kind, id, release, file string, b []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[kind+"/"+id] = b
	if release != "" {
		k := kind + "/" + release + "/" + ouogo.DebugFilePath(file)
		f.release[k] = append(f.release[k], id)
		sort.Strings(f.release[k])
	}
}

func (f *fakeMuninn) DebugFile(_ context.Context, project, kind, id string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if f.fail != nil {
		return nil, f.fail
	}
	b, ok := f.files[kind+"/"+id]
	if !ok || project != "shop" {
		return nil, ouogo.ErrNotFound
	}
	return b, nil
}

func (f *fakeMuninn) DebugFileIDs(_ context.Context, project, kind, release, file string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	if f.fail != nil {
		return nil, f.fail
	}
	if project != "shop" {
		return []string{}, nil
	}
	return append([]string{}, f.release[kind+"/"+release+"/"+file]...), nil
}

func (f *fakeMuninn) setFail(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail = err
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// testdata/app.min.js is src/app.ts minified by esbuild (gen.sh); stack-v8.txt is its
// recorded stack, served from https://shop.example/assets/app.min.js.
const (
	webID     = "c0ffee00-0000-4000-8000-000000000001"
	webURL    = "https://shop.example/assets/app.min.js"
	otherID   = "c0ffee00-0000-4000-8000-000000000002"
	unknownID = "deadbeef-0000-4000-8000-000000000000"
)

func webException(t *testing.T, release string, ids map[string]string) Exception {
	return Exception{Project: "shop", Release: release, Stacktrace: string(fixture(t, "stack-v8.txt")), DebugIDs: ids}
}

func checkWebMapped(t *testing.T, res Result) {
	t.Helper()
	if res.Status != StatusOK || res.Mapped != 3 || len(res.Frames) != 3 {
		t.Fatalf("%+v", res)
	}
	for i, want := range []struct {
		line int
		fn   string
	}{{10, "totalOf"}, {21, "checkout"}, {28, "run"}} {
		o := res.Frames[i].Original
		if o == nil || o.File != "src/app.ts" || o.Line != want.line || o.Function != want.fn {
			t.Errorf("frame %d = %+v, want src/app.ts:%d %s", i, o, want.line, want.fn)
		}
	}
	if c := res.Frames[0].Context; c == nil || !strings.Contains(c.Line, "negative price") || len(c.Pre) != 3 {
		t.Errorf("context %+v", c)
	}
	if !strings.HasPrefix(res.Stacktrace, "RangeError: negative price\n    at totalOf (src/app.ts:10:") || !strings.HasSuffix(res.Stacktrace, "    at native") {
		t.Errorf("stack:\n%s", res.Stacktrace)
	}
}

func TestDebugIDHit(t *testing.T) {
	src := newFake()
	src.put(ouogo.DebugFileSourceMap, webID, "", "", fixture(t, "app.min.js.map"))
	// The id as an SDK may write it: 32 hex, uppercase.
	id := strings.ToUpper(strings.ReplaceAll(webID, "-", ""))
	res, err := New(src, Options{}).Resolve(context.Background(), webException(t, "", map[string]string{webURL: id}))
	if err != nil {
		t.Fatal(err)
	}
	checkWebMapped(t, res)
	if res.Frames[0].DebugID != webID {
		t.Errorf("debug id %q", res.Frames[0].DebugID)
	}
}

func TestReleaseFallback(t *testing.T) {
	ctx := context.Background()
	m := fixture(t, "app.min.js.map")
	src := newFake()
	r := New(src, Options{})

	// Zero candidates: nothing is mapped, nothing is guessed.
	res, err := r.Resolve(ctx, webException(t, "1.4.2", nil))
	if err != nil || res.Status != StatusNoMaps || res.Frames[0].Status != FrameNoMap {
		t.Fatalf("no candidate: %+v %v", res, err)
	}
	if res.Stacktrace != strings.TrimRight(string(fixture(t, "stack-v8.txt")), "\n") {
		t.Errorf("a stack without maps must come back as recorded:\n%s", res.Stacktrace)
	}

	// Exactly one: mapped, under the release the file was uploaded with only.
	src.put(ouogo.DebugFileSourceMap, webID, "1.4.3", "/assets/app.min.js", m)
	res, _ = r.Resolve(ctx, webException(t, "1.4.3", nil))
	checkWebMapped(t, res)
	if res.Frames[0].DebugID != webID {
		t.Errorf("the candidate's id is reported: %q", res.Frames[0].DebugID)
	}
	if res, _ = r.Resolve(ctx, webException(t, "", nil)); res.Status != StatusNoMaps {
		t.Errorf("no release: %s", res.Status)
	}
	if res, _ = r.Resolve(ctx, Exception{Project: "other", Release: "1.4.3", Stacktrace: string(fixture(t, "stack-v8.txt"))}); res.Status != StatusNoMaps {
		t.Errorf("another project: %s", res.Status)
	}

	// Several: ambiguous, the stack kept as recorded.
	src.put(ouogo.DebugFileSourceMap, otherID, "1.4.3", "https://cdn.example/assets/app.min.js?v=2", append([]byte("\n"), m...))
	res, _ = New(src, Options{}).Resolve(ctx, webException(t, "1.4.3", nil))
	if res.Status != StatusNoMaps || res.Frames[0].Status != FrameAmbiguous || res.Frames[0].Original != nil {
		t.Errorf("two builds of one path: %+v", res.Frames[0])
	}
	if res.Stacktrace != strings.TrimRight(string(fixture(t, "stack-v8.txt")), "\n") {
		t.Errorf("ambiguous stack rewritten:\n%s", res.Stacktrace)
	}
}

func TestUnknownDebugIDNeverFallsBack(t *testing.T) {
	src := newFake()
	src.put(ouogo.DebugFileSourceMap, webID, "1.4.2", "/assets/app.min.js", fixture(t, "app.min.js.map"))
	r := New(src, Options{})
	for _, id := range []string{unknownID, "not-a-debug-id"} {
		res, err := r.Resolve(context.Background(), webException(t, "1.4.2", map[string]string{webURL: id}))
		if err != nil || res.Status != StatusNoMaps || res.Frames[0].Status != FrameNoMap {
			t.Errorf("debug id %q: %+v %v", id, res.Frames[0], err)
		}
	}
}

func TestLateUploadAfterMissTTL(t *testing.T) {
	src := newFake()
	now := time.Now()
	r := New(src, Options{Now: func() time.Time { return now }})
	ctx := context.Background()
	byID := webException(t, "", map[string]string{webURL: webID})
	byRelease := webException(t, "1.4.2", nil)
	for _, e := range []Exception{byID, byRelease} {
		if res, _ := r.Resolve(ctx, e); res.Status != StatusNoMaps {
			t.Fatalf("before upload: %s", res.Status)
		}
	}
	// CI uploads the map after the error was recorded.
	src.put(ouogo.DebugFileSourceMap, webID, "1.4.2", webURL, fixture(t, "app.min.js.map"))
	reads := src.reads
	for _, e := range []Exception{byID, byRelease} {
		if res, _ := r.Resolve(ctx, e); res.Status != StatusNoMaps {
			t.Errorf("within MissTTL the miss is remembered: %s", res.Status)
		}
	}
	if src.reads != reads {
		t.Errorf("a remembered miss read Muninn %d times", src.reads-reads)
	}
	now = now.Add(61 * time.Second)
	for _, e := range []Exception{byID, byRelease} {
		res, _ := r.Resolve(ctx, e)
		checkWebMapped(t, res)
	}
}

func TestMuninnErrorIsNotAMiss(t *testing.T) {
	ctx := context.Background()
	src := newFake()
	src.put(ouogo.DebugFileSourceMap, webID, "", "", fixture(t, "app.min.js.map"))
	r := New(src, Options{})
	src.setFail(&ouogo.BackendError{Backend: "muninn", Err: errors.New("503")})
	e := webException(t, "", map[string]string{webURL: webID})
	if _, err := r.Resolve(ctx, e); err == nil {
		t.Fatal("Muninn failing every lookup must be an error")
	}
	if src.reads != 1 {
		t.Errorf("one failed key is read once per stack, read %d times", src.reads)
	}
	// The failure is not cached: once Muninn is back the map applies at once.
	src.setFail(nil)
	res, err := r.Resolve(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	checkWebMapped(t, res)

	// A missing map is no error.
	if res, err := New(newFake(), Options{}).Resolve(ctx, e); err != nil || res.Frames[0].Status != FrameNoMap {
		t.Errorf("missing map: %+v %v", res, err)
	}

	// Some lookups fail, others do not: the failed frames are unavailable, not no_map.
	src = newFake()
	src.put(ouogo.DebugFileSourceMap, webID, "", "", fixture(t, "app.min.js.map"))
	r = New(src, Options{})
	if _, err := r.Resolve(ctx, e); err != nil { // the map is cached now
		t.Fatal(err)
	}
	src.setFail(errors.New("down"))
	mixed := e
	mixed.Stacktrace += "\n    at x (https://cdn.example/vendor.js:1:5)"
	mixed.DebugIDs = map[string]string{webURL: webID, "https://cdn.example/vendor.js": otherID}
	res, err = r.Resolve(ctx, mixed)
	if err != nil || res.Status != StatusPartial || res.Frames[3].Status != FrameUnavailable || res.Frames[0].Status != FrameMapped {
		t.Errorf("partial failure: %+v %v", res, err)
	}
}

func TestGarbageMapIsNoMap(t *testing.T) {
	src := newFake()
	src.put(ouogo.DebugFileSourceMap, webID, "", "", []byte("not a source map"))
	res, err := New(src, Options{}).Resolve(context.Background(), webException(t, "", map[string]string{webURL: webID}))
	if err != nil || res.Status != StatusNoMaps || res.Frames[0].Status != FrameNoMap {
		t.Errorf("%+v, %v", res, err)
	}
}

func TestCacheBounds(t *testing.T) {
	m := fixture(t, "app.min.js.map")
	src := newFake()
	src.put(ouogo.DebugFileSourceMap, webID, "", "", m)
	src.put(ouogo.DebugFileSourceMap, otherID, "", "", append([]byte(" "), m...))
	ctx := context.Background()
	resolve := func(r *Resolver, id string) {
		if res, _ := r.Resolve(ctx, webException(t, "", map[string]string{webURL: id})); res.Status != StatusOK {
			t.Fatalf("%s: %s", id, res.Status)
		}
	}

	r := New(src, Options{})
	resolve(r, webID)
	if got := r.CachedBytes(); got != int64(len(m))*parsedFactor {
		t.Errorf("cached bytes %d, want %d (parsed ~ %dx the file)", got, len(m)*parsedFactor, parsedFactor)
	}

	// A one-entry cache keeps the newest only.
	r = New(src, Options{CacheEntries: 1})
	resolve(r, webID)
	resolve(r, otherID)
	if r.lru.Len() != 1 || r.CachedBytes() != int64(len(m)+1)*parsedFactor {
		t.Errorf("entries %d bytes %d", r.lru.Len(), r.CachedBytes())
	}
	// A cache of one byte still keeps the newest entry.
	r = New(src, Options{CacheBytes: 1})
	resolve(r, webID)
	resolve(r, otherID)
	if r.lru.Len() != 1 {
		t.Errorf("byte bound: %d entries", r.lru.Len())
	}
	reads := src.reads
	resolve(r, otherID)
	resolve(r, webID)
	if src.reads != reads+1 {
		t.Errorf("the newest entry is a hit, the evicted one a read: %d reads", src.reads-reads)
	}
}

// testdata/hermes: two OTA bundles of store version 1.4.0, both shipped as
// index.android.bundle, built by hermes/generate.mjs (Metro, hermesc -O, composed maps).
func TestHermesOTABundles(t *testing.T) {
	type frame struct{ Line, Column int }
	var exp map[string]struct {
		DebugID string `json:"debug_id"`
		Throw   frame  `json:"throw"`
		Call    frame  `json:"call"`
	}
	if err := json.Unmarshal(fixture(t, "hermes/expected.json"), &exp); err != nil {
		t.Fatal(err)
	}
	src := newFake()
	for _, v := range []string{"v1", "v2"} {
		src.put(ouogo.DebugFileSourceMap, exp[v].DebugID, "1.4.0", "/index.android.bundle", fixture(t, "hermes/"+v+"/index.android.bundle.hbc.map"))
	}
	r := New(src, Options{})
	for _, v := range []string{"v1", "v2"} {
		b := exp[v]
		// The stack as the React Native SDK sends it: "address at" dropped, app frames marked.
		stack := "Error: card declined: 120\n" +
			fmt.Sprintf("  at chargeCard (app:///index.android.bundle:1:%d) [in app]\n", b.Throw.Column) +
			fmt.Sprintf("  at checkout (app:///index.android.bundle:1:%d) [in app]\n", b.Call.Column) +
			"  at anonymous (native)"
		res, err := r.Resolve(context.Background(), Exception{Project: "shop", Release: "1.4.0", Stacktrace: stack,
			DebugIDs: map[string]string{"app:///index.android.bundle": b.DebugID}})
		if err != nil || res.Status != StatusOK {
			t.Fatalf("%s: %+v, %v", v, res, err)
		}
		for i, want := range []struct {
			line int
			fn   string
		}{{b.Throw.Line, "chargeCard"}, {b.Call.Line, "checkout"}} {
			o := res.Frames[i].Original
			if o == nil || o.File != "src/"+v+"/index.js" || o.Line != want.line || o.Function != want.fn {
				t.Errorf("%s frame %d = %+v, want src/%s/index.js:%d %s", v, i, o, v, want.line, want.fn)
			}
		}
		if !strings.Contains(res.Stacktrace, fmt.Sprintf("  at chargeCard (src/%s/index.js:%d:", v, b.Throw.Line)) || !strings.Contains(res.Stacktrace, ") [in app]\n") {
			t.Errorf("%s stack:\n%s", v, res.Stacktrace)
		}
		// The "address at" form reads the column the same way.
		addr := strings.ReplaceAll(stack, "(app:///", "(address at app:///")
		if res, _ := r.Resolve(context.Background(), Exception{Project: "shop", Stacktrace: addr,
			DebugIDs: map[string]string{"app:///index.android.bundle": b.DebugID}}); res.Frames[0].Original == nil || res.Frames[0].Original.Line != b.Throw.Line {
			t.Errorf("%s address at: %+v", v, res.Frames[0])
		}
		// Without the debug id the two bundles are ambiguous.
		res, _ = r.Resolve(context.Background(), Exception{Project: "shop", Release: "1.4.0", Stacktrace: stack})
		if res.Frames[0].Status != FrameAmbiguous {
			t.Errorf("%s without debug id: %s", v, res.Frames[0].Status)
		}
	}
}

func TestFromEvent(t *testing.T) {
	ev := ouogo.Event{Name: "exception", Attributes: map[string]string{
		"exception_stacktrace":    "Error: x\n    at a (https://shop.example/a.js:1:2)",
		"ouo_exception_debug_ids": `{"https://shop.example/a.js":"` + webID + `"}`,
		"service_version":         "1.4.2",
	}}
	e, ok := FromEvent("shop", ev)
	if !ok || e.Project != "shop" || e.Release != "1.4.2" || e.DebugIDs["https://shop.example/a.js"] != webID || len(e.Frames) != 0 {
		t.Errorf("%+v %v", e, ok)
	}
	// The "." spelling, malformed debug ids, and a native crash.
	ev.Attributes = map[string]string{
		"exception.stacktrace":    "0   crashy 0x0000000104a0050c 0x104a00000 + 1292",
		"ouo.exception.debug_ids": "{",
		"ouo_crash_frames":        `[{"instruction_addr":"0x104a0050c","image_addr":"0x104a00000"}]`,
		"ouo_crash_images":        `[{"code_file":"crashy","debug_id":"` + crashyARM64 + `","image_addr":"0x104a00000","image_size":16384,"image_vmaddr":"0x100000000"}]`,
	}
	e, ok = FromEvent("shop", ev)
	if !ok || e.Stacktrace == "" || e.DebugIDs != nil || len(e.Frames) != 1 || len(e.Images) != 1 || e.Images[0].ImageSize != 16384 {
		t.Errorf("%+v %v", e, ok)
	}
	if _, ok := FromEvent("shop", ouogo.Event{Name: "exception"}); ok {
		t.Error("an event without a stack has nothing to resolve")
	}
}

// TestThroughMuninn runs the resolver on the real client against a server answering as
// Muninn does (gzip file, candidate list).
func TestThroughMuninn(t *testing.T) {
	m := fixture(t, "app.min.js.map")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/projects/shop/debug-files/sourcemap/" + webID:
			var buf bytes.Buffer
			zw := gzip.NewWriter(&buf)
			zw.Write(m)
			zw.Close()
			w.Header().Set("Content-Encoding", "gzip")
			w.Write(buf.Bytes())
		case "/api/v1/projects/shop/debug-files/sourcemap":
			if r.URL.Query().Get("release") == "1.4.2" && r.URL.Query().Get("file") == "/assets/app.min.js" {
				w.Write([]byte(`{"debug_ids":["` + webID + `"]}`))
				return
			}
			w.Write([]byte(`{"debug_ids":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	r := New(&ouogo.Muninn{URL: srv.URL}, Options{})
	res, err := r.Resolve(context.Background(), webException(t, "1.4.2", nil))
	if err != nil {
		t.Fatal(err)
	}
	checkWebMapped(t, res)
	res, err = r.Resolve(context.Background(), webException(t, "", map[string]string{webURL: unknownID}))
	if err != nil || res.Frames[0].Status != FrameNoMap {
		t.Errorf("unknown id: %+v %v", res, err)
	}
}
