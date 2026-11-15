package symbolicate

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// testdata/proguard is a real R8 build and crash (testdata/proguard/README.md).
const sampleMappingID = "fc5959f4-0d6c-4bb9-8edf-9788fbd76af1"

// sampleException is the crash as an exception record reaches Loki: the report's frames
// in ouo.crash.frames, its mapping id, and the stack text logcat printed.
func sampleException(t *testing.T) Exception {
	t.Helper()
	var report struct {
		Frames    json.RawMessage `json:"frames"`
		MappingID string          `json:"mapping_id"`
	}
	if err := json.Unmarshal(fixture(t, "proguard/report.json"), &report); err != nil {
		t.Fatal(err)
	}
	e, ok := FromEvent("shop", ouogo.Event{Attributes: map[string]string{
		"exception_stacktrace":     string(fixture(t, "proguard/stack-obfuscated.txt")),
		"ouo_crash_frames":         string(report.Frames),
		"ouo_exception_mapping_id": report.MappingID,
		"service_version":          "1.0",
	}})
	if !ok || len(e.JVMFrames) != 9 || len(e.Frames) != 0 || e.MappingID != sampleMappingID {
		t.Fatalf("FromEvent: ok=%v jvm=%d native=%d id=%q", ok, len(e.JVMFrames), len(e.Frames), e.MappingID)
	}
	return e
}

func TestRetraceMatchesR8(t *testing.T) {
	src := newFake()
	src.put(ouogo.DebugFileProguard, sampleMappingID, "", "", fixture(t, "proguard/mapping.txt"))
	res, err := New(src, Options{}).Resolve(context.Background(), sampleException(t))
	if err != nil {
		t.Fatal(err)
	}
	// R8's retrace output on the same stack; the logcat excerpt has three of the nine frames.
	want := strings.TrimRight(string(fixture(t, "proguard/stack-retrace.txt")), "\n")
	if res.Stacktrace != want {
		t.Fatalf("stack:\n%s\nwant:\n%s", res.Stacktrace, want)
	}
	// One minified frame, five original methods (R8 inlined four into the lambda); the
	// eight platform frames are not in the mapping.
	if res.Status != StatusPartial || res.Mapped != 1 || len(res.Frames) != 13 {
		t.Fatalf("status %s mapped %d frames %d", res.Status, res.Mapped, len(res.Frames))
	}
	wantRows := []string{
		"dev.ouo.sample.Prices.check MainActivity.kt:44 inlined",
		"dev.ouo.sample.Prices.sum MainActivity.kt:39 inlined",
		"dev.ouo.sample.Cart.total MainActivity.kt:33 inlined",
		"dev.ouo.sample.Checkout.pay MainActivity.kt:27 inlined",
		"dev.ouo.sample.MainActivity.onCreate$lambda$2 MainActivity.kt:20 ",
	}
	for i, w := range wantRows {
		f := res.Frames[i]
		inl := ""
		if f.Inlined {
			inl = "inlined"
		}
		got := f.Original.Function + " " + f.Original.File + ":" + itoa(f.Original.Line) + " " + inl
		if f.Status != FrameMapped || got != w || f.DebugID != sampleMappingID || f.Generated.Function != "a.b.run" || f.Generated.Line != 80 {
			t.Errorf("row %d: %s %q, want %q", i, f.Status, got, w)
		}
	}
	if f := res.Frames[5]; f.Status != FrameNoMap || f.Generated.Function != "android.os.Handler.handleCallback" {
		t.Errorf("platform frame: %+v", f)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestRetraceWithoutMapping(t *testing.T) {
	e := sampleException(t)
	src := newFake()
	r := New(src, Options{})
	// Uploaded under another id: never applied.
	src.put(ouogo.DebugFileProguard, "00000000-0000-4000-8000-000000000001", "", "", fixture(t, "proguard/mapping.txt"))
	for _, id := range []string{sampleMappingID, ""} {
		e.MappingID = id
		res, err := r.Resolve(context.Background(), e)
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != StatusNoMaps || res.Mapped != 0 || len(res.Frames) != 9 || res.Frames[0].Status != FrameNoMap {
			t.Fatalf("id %q: %+v", id, res)
		}
		if !strings.Contains(res.Stacktrace, "at a.b.run(r8-map-id-") {
			t.Fatalf("stack not kept as recorded:\n%s", res.Stacktrace)
		}
	}
	src.setFail(errors.New("muninn down"))
	e.MappingID = "00000000-0000-4000-8000-000000000002"
	if _, err := r.Resolve(context.Background(), e); err == nil {
		t.Fatal("want an error when Muninn fails")
	}
}

// A hand-written mapping for the cases the sample build has no example of.
const handMapping = `# compiler: R8
# {"id":"com.android.tools.r8.mapping","version":"2.2"}
com.shop.Basket -> a.a:
# {"id":"sourceFile","fileName":"Basket.kt"}
    java.util.List items -> a
    1:5:void add(int):10:14 -> a
    6:6:void add(int,int):20:20 -> a
    7:9:int count():30 -> b
    void clear() -> c
    void reset() -> d
    void reset(int) -> d
    void undo() -> e
    void redo() -> e
com.shop.Basket$Line -> a.b:
    1:1:void <init>():5:5 -> <init>
com.shop.Till -> a.d:
    1:2:void com.shop.Basket.count():30:31 -> a
    1:2:void pay():7 -> a
    3:3:void pay():8:8 -> a
com.shop.BasketException -> a.c:
# {"id":"sourceFile","fileName":"Errors.kt"}
`

func TestRetraceCases(t *testing.T) {
	v, err := parseProguard([]byte(handMapping))
	if err != nil {
		t.Fatal(err)
	}
	m := v.(*pgMap)
	cases := []struct {
		frame JVMFrame
		ok    bool
		want  string // "class.method file:line", "" unmapped
	}{
		{JVMFrame{Module: "a.a", Function: "a", Lineno: 3}, true, "com.shop.Basket.add Basket.kt:12"},    // a range, shifted
		{JVMFrame{Module: "a.a", Function: "a", Lineno: 6}, true, "com.shop.Basket.add Basket.kt:20"},    // an overload of one line
		{JVMFrame{Module: "a.a", Function: "b", Lineno: 8}, true, "com.shop.Basket.count Basket.kt:30"},  // a single original line
		{JVMFrame{Module: "a.a", Function: "c", Lineno: 42}, true, "com.shop.Basket.clear Basket.kt:42"}, // no range: line kept
		{JVMFrame{Module: "a.a", Function: "d", Lineno: 0}, true, "com.shop.Basket.reset Basket.kt:0"},   // overloads, one name
		{JVMFrame{Module: "a.a", Function: "e", Lineno: 1}, true, ""},                                    // two names: not guessed
		{JVMFrame{Module: "a.a", Function: "a", Lineno: 0}, true, "com.shop.Basket.add Basket.kt:0"},     // no line
		{JVMFrame{Module: "a.a", Function: "zz", Lineno: 1}, true, ""},                                   // unknown method
		{JVMFrame{Module: "a.b", Function: "<init>", Lineno: 1}, true, "com.shop.Basket$Line.<init> Basket.java:5"},
		{JVMFrame{Module: "a.d", Function: "a", Lineno: 0}, true, "com.shop.Till.pay Till.java:0"}, // no line: the outer method of inline groups
		{JVMFrame{Module: "java.lang.Thread", Function: "run", Lineno: 1}, false, ""},
	}
	for _, c := range cases {
		rows, ok := m.retrace(c.frame)
		got := ""
		if len(rows) == 1 {
			got = rows[0].class + "." + rows[0].method + " " + rows[0].file + ":" + itoa(rows[0].line)
		} else if len(rows) > 1 {
			got = "several rows"
		}
		if ok != c.ok || got != c.want {
			t.Errorf("%+v: ok=%v %q, want ok=%v %q", c.frame, ok, got, c.ok, c.want)
		}
	}
	// The exception class in the first line, and a stack without text.
	if got := jvmStack("a.c: out of stock\n\tat a.a.a(SourceFile:3)", [][]Frame{{{Status: FrameMapped, Original: &Position{File: "Basket.kt", Line: 12, Function: "com.shop.Basket.add"}}}}, m); got != "com.shop.BasketException: out of stock\n\tat com.shop.Basket.add(Basket.kt:12)" {
		t.Errorf("stack: %q", got)
	}
	if got := jvmStack("", [][]Frame{{{Status: FrameNoMap, Generated: Position{File: "Thread.java", Line: 1, Function: "java.lang.Thread.run"}}}}, m); got != "    at java.lang.Thread.run(Thread.java:1)" {
		t.Errorf("no text: %q", got)
	}
	if v, err := parseProguard([]byte("not a mapping")); v != nil || err != nil {
		t.Errorf("garbage: %v %v", v, err)
	}
}
