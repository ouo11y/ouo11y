package symbolicate_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/project/agents/symbolication/prototype/debugfiles"
	"github.com/ouo11y/ouo11y/project/agents/symbolication/prototype/symbolicate"
)

const token = "ut_test"

// stack starts the store and the edge route in front of it, as the Collector
// and Muninn would stand, and returns the upload URL and the reader client.
func stack(t *testing.T) (edge string, client *debugfiles.Client) {
	t.Helper()
	store := httptest.NewServer(debugfiles.Handler(&debugfiles.FS{Root: t.TempDir()}, 64<<20))
	t.Cleanup(store.Close)
	client = &debugfiles.Client{BaseURL: store.URL}
	e := httptest.NewServer(debugfiles.EdgeHandler(client, map[string]string{token: "shop"}, 64<<20))
	t.Cleanup(e.Close)
	return e.URL, client
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func gz(b []byte) []byte {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write(b)
	zw.Close()
	return buf.Bytes()
}

// upload sends a map the way `ouo-sourcemaps upload` does.
func upload(t *testing.T, edge, tok, query string, mapJSON []byte) int {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, edge+"/v1/sourcemaps?"+query, bytes.NewReader(gz(mapJSON)))
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

const webID = "c0ffee00-0000-4000-8000-000000000001"

func TestResolveByDebugID(t *testing.T) {
	edge, client := stack(t)
	if got := upload(t, edge, token, "file=/assets/app.min.js&debug_id="+webID, fixture(t, "app.min.js.map")); got != http.StatusCreated {
		t.Fatalf("upload = %d", got)
	}
	sym := symbolicate.New(client, symbolicate.Options{})
	res, err := sym.Symbolicate(context.Background(), symbolicate.Request{ProjectID: "shop", Stacktrace: string(fixture(t, "stack-v8.txt")),
		DebugIDs: map[string]string{"https://shop.example/assets/app.min.js": webID}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != symbolicate.StatusOK || res.Mapped != 3 {
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
	if !strings.HasPrefix(res.Stacktrace, "RangeError: negative price\n    at totalOf (src/app.ts:10:") || !strings.HasSuffix(res.Stacktrace, "    at native") {
		t.Errorf("stack:\n%s", res.Stacktrace)
	}
}

func TestWriteOnce(t *testing.T) {
	edge, _ := stack(t)
	m := fixture(t, "app.min.js.map")
	q := "file=/assets/app.min.js&debug_id=" + webID
	if got := upload(t, edge, token, q, m); got != http.StatusCreated {
		t.Fatalf("first upload = %d", got)
	}
	if got := upload(t, edge, token, q, m); got != http.StatusOK {
		t.Errorf("same bytes again = %d, want 200", got)
	}
	if got := upload(t, edge, token, q, append([]byte(" "), m...)); got != http.StatusConflict {
		t.Errorf("other bytes under the same id = %d, want 409", got)
	}
	if got := upload(t, edge, "ut_wrong", q, m); got != http.StatusUnauthorized {
		t.Errorf("wrong token = %d, want 401", got)
	}
}

func TestMissingMapThenLateUpload(t *testing.T) {
	edge, client := stack(t)
	now := time.Now()
	sym := symbolicate.New(client, symbolicate.Options{Now: func() time.Time { return now }})
	req := symbolicate.Request{ProjectID: "shop", Stacktrace: string(fixture(t, "stack-v8.txt")),
		DebugIDs: map[string]string{"https://shop.example/assets/app.min.js": webID}}
	res, err := sym.Symbolicate(context.Background(), req)
	if err != nil || res.Status != symbolicate.StatusNoMaps || res.Frames[0].Status != symbolicate.FrameNoMap {
		t.Fatalf("before upload: %+v, %v", res, err)
	}
	if res.Stacktrace != strings.TrimRight(string(fixture(t, "stack-v8.txt")), "\n") {
		t.Errorf("a stack without maps must come back as recorded:\n%s", res.Stacktrace)
	}
	// CI uploads the map after the error was recorded.
	upload(t, edge, token, "debug_id="+webID, fixture(t, "app.min.js.map"))
	if res, _ = sym.Symbolicate(context.Background(), req); res.Status != symbolicate.StatusNoMaps {
		t.Errorf("within MissTTL the miss is remembered: %s", res.Status)
	}
	now = now.Add(61 * time.Second)
	if res, _ = sym.Symbolicate(context.Background(), req); res.Status != symbolicate.StatusOK {
		t.Errorf("after MissTTL the late map applies: %s", res.Status)
	}
}

func TestReleaseFallback(t *testing.T) {
	edge, client := stack(t)
	m := fixture(t, "app.min.js.map")
	stackText := string(fixture(t, "stack-v8.txt"))
	ctx := context.Background()
	// No debug id anywhere: the map is stored under its content id and found by release + path.
	if got := upload(t, edge, token, "file=/assets/app.min.js&release=1.4.2", m); got != http.StatusCreated {
		t.Fatalf("upload = %d", got)
	}
	sym := symbolicate.New(client, symbolicate.Options{})
	res, _ := sym.Symbolicate(ctx, symbolicate.Request{ProjectID: "shop", Release: "1.4.2", Stacktrace: stackText})
	if res.Status != symbolicate.StatusOK {
		t.Fatalf("release fallback: %+v", res)
	}
	// The release does not match: nothing is mapped, nothing is guessed.
	res, _ = sym.Symbolicate(ctx, symbolicate.Request{ProjectID: "shop", Release: "1.4.3", Stacktrace: stackText})
	if res.Status != symbolicate.StatusNoMaps || res.Frames[0].Status != symbolicate.FrameNoMap {
		t.Errorf("wrong release: %+v", res)
	}
	// Another project never sees the map.
	res, _ = sym.Symbolicate(ctx, symbolicate.Request{ProjectID: "other", Release: "1.4.2", Stacktrace: stackText})
	if res.Status != symbolicate.StatusNoMaps {
		t.Errorf("other project: %+v", res)
	}
	// A second build under the same release and path: ambiguous, so no frame is mapped.
	upload(t, edge, token, "file=/assets/app.min.js&release=1.4.2", append([]byte("\n"), m...))
	sym = symbolicate.New(client, symbolicate.Options{})
	res, _ = sym.Symbolicate(ctx, symbolicate.Request{ProjectID: "shop", Release: "1.4.2", Stacktrace: stackText})
	if res.Status != symbolicate.StatusNoMaps || res.Frames[0].Status != symbolicate.FrameAmbiguous {
		t.Errorf("two builds of one path: %+v", res.Frames[0])
	}
	// A frame with a debug id the store does not know stays unmapped, whatever the release holds.
	res, _ = sym.Symbolicate(ctx, symbolicate.Request{ProjectID: "shop", Release: "1.4.2", Stacktrace: stackText,
		DebugIDs: map[string]string{"https://shop.example/assets/app.min.js": "deadbeef-0000-4000-8000-000000000000"}})
	if res.Status != symbolicate.StatusNoMaps || res.Frames[0].Status != symbolicate.FrameNoMap {
		t.Errorf("unknown debug id: %+v", res.Frames[0])
	}
}

func TestGarbageUploadIsAMiss(t *testing.T) {
	edge, client := stack(t)
	upload(t, edge, token, "debug_id="+webID, []byte("not a source map"))
	sym := symbolicate.New(client, symbolicate.Options{})
	res, err := sym.Symbolicate(context.Background(), symbolicate.Request{ProjectID: "shop", Stacktrace: string(fixture(t, "stack-v8.txt")),
		DebugIDs: map[string]string{"https://shop.example/assets/app.min.js": webID}})
	if err != nil || res.Status != symbolicate.StatusNoMaps {
		t.Errorf("%+v, %v", res, err)
	}
}

// Two OTA bundles of one store version, both index.android.bundle (rum-api's
// Hermes fixture): each stack maps with its own bundle's map.
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
	edge, client := stack(t)
	for _, v := range []string{"v1", "v2"} {
		q := "file=/index.android.bundle&release=1.4.0&debug_id=" + exp[v].DebugID
		if got := upload(t, edge, token, q, fixture(t, "hermes/"+v+"/index.android.bundle.hbc.map")); got != http.StatusCreated {
			t.Fatalf("%s upload = %d", v, got)
		}
	}
	sym := symbolicate.New(client, symbolicate.Options{})
	for _, v := range []string{"v1", "v2"} {
		b := exp[v]
		stackText := "Error: card declined: 120\n" +
			fmt.Sprintf("  at chargeCard (app:///index.android.bundle:1:%d) [in app]\n", b.Throw.Column) +
			fmt.Sprintf("  at checkout (app:///index.android.bundle:1:%d) [in app]\n", b.Call.Column) +
			"  at anonymous (native)"
		res, err := sym.Symbolicate(context.Background(), symbolicate.Request{ProjectID: "shop", Release: "1.4.0", Stacktrace: stackText,
			DebugIDs: map[string]string{"app:///index.android.bundle": b.DebugID}})
		if err != nil || res.Status != symbolicate.StatusOK {
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
		// Without the debug id the two bundles are ambiguous (rum-api mapped v1 with v2's map here).
		res, _ = sym.Symbolicate(context.Background(), symbolicate.Request{ProjectID: "shop", Release: "1.4.0", Stacktrace: stackText})
		if res.Frames[0].Status != symbolicate.FrameAmbiguous {
			t.Errorf("%s without debug id: %s", v, res.Frames[0].Status)
		}
	}
}
