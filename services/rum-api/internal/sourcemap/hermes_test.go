package sourcemap

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	gosm "github.com/go-sourcemap/sourcemap"
)

// testdata/hermes: two OTA bundles of store version 1.4.0, both shipped as
// index.android.bundle, built by generate.mjs (Metro with withOuoDebugIds,
// hermesc -O, composed maps).
type hermesFrame struct {
	Line   int `json:"line"`
	Column int `json:"column"`
}

type hermesBundle struct {
	DebugID string      `json:"debug_id"`
	Throw   hermesFrame `json:"throw"`
	Call    hermesFrame `json:"call"`
}

func hermesFixture(t *testing.T) map[string]hermesBundle {
	t.Helper()
	var exp map[string]hermesBundle
	if err := json.Unmarshal(fixture(t, "hermes/expected.json"), &exp); err != nil {
		t.Fatal(err)
	}
	return exp
}

// hermesStack is the stack as the React Native SDK sends it: "address at"
// dropped, the per-install path reduced to app:///index.android.bundle, app
// frames marked.
func hermesStack(b hermesBundle) string {
	return "Error: card declined: 120\n" +
		fmt.Sprintf("  at chargeCard (app:///index.android.bundle:1:%d) [in app]\n", b.Throw.Column) +
		fmt.Sprintf("  at checkout (app:///index.android.bundle:1:%d) [in app]\n", b.Call.Column) +
		"  at anonymous (native)"
}

func TestHermesOTABundles(t *testing.T) {
	exp := hermesFixture(t)
	store := newStore(t)
	ctx := context.Background()
	for _, v := range []string{"v1", "v2"} {
		m, err := store.Put(ctx, Upload{ProjectID: "pilot", Release: "1.4.0", File: "/index.android.bundle",
			Map: fixture(t, "hermes/"+v+"/index.android.bundle.hbc.map")})
		if err != nil {
			t.Fatal(err)
		}
		// The composed map carries the id compose took from the bytecode.
		if m.DebugID != exp[v].DebugID {
			t.Fatalf("%s stored under %q, want %q", v, m.DebugID, exp[v].DebugID)
		}
	}
	sym := NewSymbolicator(store, Options{})
	for _, v := range []string{"v1", "v2"} {
		b := exp[v]
		res, err := sym.Symbolicate(ctx, Request{ProjectID: "pilot", Release: "1.4.0", Stacktrace: hermesStack(b),
			DebugIDs: map[string]string{"app:///index.android.bundle": b.DebugID}})
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != StatusOK || len(res.Frames) != 2 {
			t.Fatalf("%s: %+v", v, res)
		}
		src := "src/" + v + "/index.js"
		for i, want := range []struct {
			line int
			fn   string
		}{{b.Throw.Line, "chargeCard"}, {b.Call.Line, "checkout"}} {
			o := res.Frames[i].Original
			if o == nil || o.File != src || o.Line != want.line || o.Function != want.fn {
				t.Errorf("%s frame %d = %+v, want %s:%d %s", v, i, o, src, want.line, want.fn)
			}
			if res.Frames[i].DebugID != b.DebugID {
				t.Errorf("%s frame %d debug id %q", v, i, res.Frames[i].DebugID)
			}
		}
		if !strings.Contains(res.Stacktrace, fmt.Sprintf("at chargeCard (%s:%d:", src, b.Throw.Line)) ||
			!strings.Contains(res.Stacktrace, "[in app]") {
			t.Errorf("%s stack:\n%s", v, res.Stacktrace)
		}
		if res.Frames[0].Context == nil || !strings.Contains(res.Frames[0].Context.Line, "throw new Error") {
			t.Errorf("%s context %+v", v, res.Frames[0].Context)
		}
	}

	// Without debug ids the release index serves the last upload for the path:
	// the earlier OTA bundle's frames land on the wrong lines. That is why the
	// SDK sends debug ids.
	res, err := sym.Symbolicate(ctx, Request{ProjectID: "pilot", Release: "1.4.0", Stacktrace: hermesStack(exp["v1"])})
	if err != nil {
		t.Fatal(err)
	}
	if o := res.Frames[0].Original; o == nil || o.File != "src/v2/index.js" {
		t.Errorf("release fallback = %+v, want the v2 map", o)
	}
}

// withoutDebugID is a fixture map as React Native's compose writes it: no
// debugId (the CLI then sends the id in the request).
func withoutDebugID(t *testing.T, name string) []byte {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(fixture(t, name), &m); err != nil {
		t.Fatal(err)
	}
	delete(m, "debugId")
	delete(m, "debug_id")
	b, _ := json.Marshal(m)
	return b
}

// One OTA deploy without an upload: v1's frames carry v1's id, only v2 is in
// the store. The release index has v2's map under the same path; serving it
// would map v1's frames to v2's lines and call them mapped.
func TestHermesUnknownDebugIDDoesNotTakeAnotherBundlesMap(t *testing.T) {
	exp := hermesFixture(t)
	store := newStore(t)
	ctx := context.Background()
	// The id comes with the request only, as ouo-sourcemaps sends a composed map.
	m, err := store.Put(ctx, Upload{ProjectID: "pilot", DebugID: exp["v2"].DebugID, Release: "1.4.0", File: "/index.android.bundle",
		Map: withoutDebugID(t, "hermes/v2/index.android.bundle.hbc.map")})
	if err != nil || m.DebugID != exp["v2"].DebugID {
		t.Fatalf("%+v %v", m, err)
	}
	sym := NewSymbolicator(store, Options{})
	res, err := sym.Symbolicate(ctx, Request{ProjectID: "pilot", Release: "1.4.0", Stacktrace: hermesStack(exp["v1"]),
		DebugIDs: map[string]string{"app:///index.android.bundle": exp["v1"].DebugID}})
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != StatusNoMaps || res.Mapped != 0 {
		t.Fatalf("v1 stack with v1's unknown id: %s, %d mapped: %+v", res.Status, res.Mapped, res.Frames)
	}
	for _, f := range res.Frames {
		if f.Status != FrameNoMap || f.DebugID != exp["v1"].DebugID {
			t.Errorf("frame %+v", f)
		}
	}
	// v2's own stack still maps, by its id.
	res, _ = sym.Symbolicate(ctx, Request{ProjectID: "pilot", Release: "1.4.0", Stacktrace: hermesStack(exp["v2"]),
		DebugIDs: map[string]string{"app:///index.android.bundle": exp["v2"].DebugID}})
	if res.Status != StatusOK {
		t.Errorf("v2: %+v", res)
	}
}

// A map uploaded with no debug id at all (release + path only) names no
// build, so an unknown id still falls back to it, as before.
func TestHermesUnknownDebugIDFallsBackToAnIDlessMap(t *testing.T) {
	exp := hermesFixture(t)
	store := newStore(t)
	ctx := context.Background()
	if _, err := store.Put(ctx, Upload{ProjectID: "pilot", Release: "1.4.0", File: "/index.android.bundle",
		Map: withoutDebugID(t, "hermes/v1/index.android.bundle.hbc.map")}); err != nil {
		t.Fatal(err)
	}
	res, err := NewSymbolicator(store, Options{}).Symbolicate(ctx, Request{ProjectID: "pilot", Release: "1.4.0", Stacktrace: hermesStack(exp["v1"]),
		DebugIDs: map[string]string{"app:///index.android.bundle": exp["v1"].DebugID}})
	if err != nil || res.Status != StatusOK {
		t.Fatalf("%+v %v", res, err)
	}
}

// A Hermes column is the bytecode offset itself. Reading it as a 1-based
// column (offset-1) lands on the instruction before, which for these frames
// is on another line or in another function.
func TestHermesColumnIsBytecodeOffset(t *testing.T) {
	exp := hermesFixture(t)
	c, err := gosm.Parse("", fixture(t, "hermes/v1/index.android.bundle.hbc.map"))
	if err != nil {
		t.Fatal(err)
	}
	wrong := 0
	for _, f := range []hermesFrame{exp["v1"].Throw, exp["v1"].Call} {
		if _, _, line, _, ok := c.Source(1, f.Column); !ok || line != f.Line {
			t.Errorf("offset %d -> line %d, want %d", f.Column, line, f.Line)
		}
		if _, _, line, _, _ := c.Source(1, f.Column-1); line != f.Line {
			wrong++
		}
	}
	if wrong == 0 {
		t.Fatal("offset-1 resolves the same: the fixture does not tell the two readings apart")
	}
	m := &jsMap{Consumer: c, hermes: true}
	if _, _, line, _, _ := m.lookup(RawFrame{Line: 1, Column: exp["v1"].Throw.Column}); line != exp["v1"].Throw.Line {
		t.Errorf("lookup -> line %d", line)
	}
}
