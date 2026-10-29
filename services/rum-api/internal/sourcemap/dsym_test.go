package sourcemap

import (
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
	"time"
)

// testdata/dsym/crashy.dwarf is the dSYM DWARF of crashy.c for arm64 and
// x86_64 (gen.sh). The UUIDs and addresses below are what gen.sh printed,
// checked with `atos -i -arch arm64 -o crashy.dwarf -l 0x100000000 <addr>`.
const (
	crashyARM64 = "3ccbba5f-01c6-36b3-9475-412655ac7ffe"
	crashyX86   = "af6a9aa7-dee9-35d6-90c3-f007eceb1efc"
)

// crashyRequest is a crash in crash_here as the SDK reports it, with the
// image loaded at 0x104a00000 (ASLR slide 0x4a00000) and one frame in a
// system library without a dSYM.
func crashyRequest() Request {
	return Request{
		ProjectID: "web-store",
		Stacktrace: "SIGSEGV: EXC_BAD_ACCESS (SIGSEGV) SEGV_MAPERR at 0x0\n" +
			"Thread (main thread) crashed, arm64:\n" +
			"0   crashy                          0x0000000104a0050c 0x104a00000 + 1292\n" +
			"1   crashy                          0x0000000104a00534 0x104a00000 + 1332\n" +
			"2   crashy                          0x0000000104a00570 0x104a00000 + 1392\n" +
			"3   dyld                            0x0000000189e1e0e0 0x189e18000 + 24800\n" +
			"\nBinary Images:\n" +
			"0x104a00000 - 0x104a03fff crashy arm64 <3ccbba5f01c636b39475412655ac7ffe> /private/var/containers/Bundle/Application/X/crashy.app/crashy\n",
		Frames: []NativeFrame{
			{InstructionAddr: "0x104a0050c", ImageAddr: "0x104a00000"},
			{InstructionAddr: "0x104a00534", ImageAddr: "0x104a00000"},
			{InstructionAddr: "0x104a00570", ImageAddr: "0x104a00000"},
			{InstructionAddr: "0x189e1e0e0", ImageAddr: "0x189e18000"},
		},
		Images: []NativeImage{
			{CodeFile: "/private/var/containers/Bundle/Application/X/crashy.app/crashy", DebugID: "3CCBBA5F-01C6-36B3-9475-412655AC7FFE",
				ImageAddr: "0x104a00000", ImageSize: 16384, ImageVMAddr: "0x100000000"},
			{CodeFile: "/usr/lib/dyld", DebugID: "0e5a2b4c-0000-3000-8000-000000000000",
				ImageAddr: "0x189e18000", ImageSize: 600000, ImageVMAddr: "0x180000000"},
		},
	}
}

func TestPutDSYMSplitsSlices(t *testing.T) {
	st := newStore(t)
	ms, err := st.PutDSYM(context.Background(), DSYMUpload{ProjectID: "web-store", Release: "1.4.2", File: "crashy.app.dSYM/Contents/Resources/DWARF/crashy", Data: fixture(t, "dsym/crashy.dwarf")})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, m := range ms {
		if m.Kind != "dsym" || m.File != "crashy" || m.Release != "1.4.2" || m.Bytes == 0 {
			t.Errorf("meta %+v", m)
		}
		got[m.Arch] = m.DebugID
	}
	if got["arm64"] != crashyARM64 || got["x86_64"] != crashyX86 || len(got) != 2 {
		t.Fatalf("slices %v", got)
	}
	// Each slice loads on its own, as a thin Mach-O file.
	b, err := st.Load(context.Background(), Ref{ProjectID: "web-store", DebugID: crashyX86, DSYM: true})
	if err != nil {
		t.Fatal(err)
	}
	df, err := parseDebugFile(b)
	if err != nil {
		t.Fatal(err)
	}
	if l := df.lookup(0x100000550); len(l) != 1 || l[0].Function != "main" || l[0].Line != 21 {
		t.Errorf("x86_64 main = %+v", l)
	}
	// Code without DWARF gets the symbol table's name, and no file.
	df.units = nil
	if l := df.lookup(0x100000514); len(l) != 1 || l[0] != (location{Function: "crash_here"}) {
		t.Errorf("symbol fallback = %+v", l)
	}
	if l := df.lookup(0x100004000); l != nil {
		t.Errorf("past __text = %+v", l)
	}
	// Another project does not see it.
	if _, err := st.Load(context.Background(), Ref{ProjectID: "shop", DebugID: crashyX86, DSYM: true}); !errors.Is(err, ErrNotFound) {
		t.Errorf("other project: %v", err)
	}
}

// thinMachO is a valid arm64 Mach-O header with only an LC_UUID: an app
// binary without DWARF, as uploaded by mistake instead of the dSYM.
func thinMachO() []byte {
	b := make([]byte, 32+24)
	le := binary.LittleEndian
	le.PutUint32(b[0:], 0xfeedfacf)
	le.PutUint32(b[4:], 0x0100000c) // CPU_TYPE_ARM64
	le.PutUint32(b[12:], 2)         // MH_EXECUTE
	le.PutUint32(b[16:], 1)         // ncmds
	le.PutUint32(b[20:], 24)        // sizeofcmds
	le.PutUint32(b[32:], lcUUID)
	le.PutUint32(b[36:], 24)
	copy(b[40:], []byte{0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12})
	return b
}

func TestPutDSYMValidates(t *testing.T) {
	st := newStore(t)
	st.MaxDSYMBytes = 1 << 20
	ctx := context.Background()
	for name, c := range map[string]struct {
		u    DSYMUpload
		want error
		msg  string
	}{
		"not mach-o": {DSYMUpload{ProjectID: "web-store", Data: []byte("{}")}, ErrInvalid, "not a Mach-O"},
		"no dwarf":   {DSYMUpload{ProjectID: "web-store", Data: thinMachO()}, ErrInvalid, "no DWARF"},
		"project":    {DSYMUpload{ProjectID: "../x", Data: thinMachO()}, ErrInvalid, "project"},
		"too large":  {DSYMUpload{ProjectID: "web-store", Data: make([]byte, 2<<20)}, ErrTooLarge, "limit"},
		"truncated":  {DSYMUpload{ProjectID: "web-store", Data: fixture(t, "dsym/crashy.dwarf")[:9000]}, ErrInvalid, ""},
	} {
		_, err := st.PutDSYM(ctx, c.u)
		if !errors.Is(err, c.want) || !strings.Contains(err.Error(), c.msg) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestSymbolicateNative(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	sym := NewSymbolicator(st, Options{})
	// Before the upload: every frame stays as it is.
	res, err := sym.Symbolicate(ctx, crashyRequest())
	if err != nil || res.Status != StatusNoMaps || len(res.Frames) != 4 || res.Frames[0].Generated.File != "crashy" || res.Frames[0].Address != "0x104a0050c" {
		t.Fatalf("before upload: %+v %v", res, err)
	}
	if _, err := st.PutDSYM(ctx, DSYMUpload{ProjectID: "web-store", Data: fixture(t, "dsym/crashy.dwarf")}); err != nil {
		t.Fatal(err)
	}
	sym.Evict(Ref{ProjectID: "web-store", DebugID: crashyARM64, DSYM: true})
	res, err = sym.Symbolicate(ctx, crashyRequest())
	if err != nil {
		t.Fatal(err)
	}
	type want struct {
		status, fn, file string
		line             int
		inlined          bool
	}
	wants := []want{
		{FrameMapped, "crash_here", "/src/crashy.c", 8, false},
		{FrameMapped, "inlined_step", "/src/crashy.c", 13, true}, // return address - 1 lands in the bl
		{FrameMapped, "level1", "/src/crashy.c", 17, false},
		{FrameMapped, "main", "/src/crashy.c", 22, false},
		{FrameNoMap, "", "", 0, false},
	}
	if len(res.Frames) != len(wants) {
		t.Fatalf("frames %+v", res.Frames)
	}
	for i, w := range wants {
		f := res.Frames[i]
		var got want
		got.status, got.inlined = f.Status, f.Inlined
		if f.Original != nil {
			got.fn, got.file, got.line = f.Original.Function, f.Original.File, f.Original.Line
		}
		if got != w {
			t.Errorf("frame %d = %+v (%+v), want %+v", i, got, f, w)
		}
	}
	if res.Frames[1].Address != res.Frames[2].Address || res.Frames[0].DebugID != crashyARM64 || res.Frames[4].Generated.File != "dyld" {
		t.Errorf("frame fields %+v", res.Frames)
	}
	if res.Status != StatusPartial || res.Mapped != 4 {
		t.Errorf("status %s mapped %d", res.Status, res.Mapped)
	}
	for _, line := range []string{
		"0   crashy                          0x0000000104a0050c crash_here (in crashy) (crashy.c:8)",
		"1   crashy                          0x0000000104a00534 inlined_step (in crashy) (crashy.c:13)",
		"1   crashy                          0x0000000104a00534 level1 (in crashy) (crashy.c:17)",
		"2   crashy                          0x0000000104a00570 main (in crashy) (crashy.c:22)",
		"3   dyld                            0x0000000189e1e0e0 0x189e18000 + 24800",
		"SIGSEGV: EXC_BAD_ACCESS (SIGSEGV) SEGV_MAPERR at 0x0",
		"Binary Images:",
	} {
		if !strings.Contains(res.Stacktrace+"\n", line+"\n") {
			t.Errorf("stacktrace lacks %q:\n%s", line, res.Stacktrace)
		}
	}

	// Without the stack text the frames alone are printed.
	req := crashyRequest()
	req.Stacktrace = ""
	res, _ = sym.Symbolicate(ctx, req)
	if !strings.HasPrefix(res.Stacktrace, "0   crashy                          0x104a0050c crash_here (in crashy) (crashy.c:8)\n") {
		t.Errorf("frames only:\n%s", res.Stacktrace)
	}

	// A frame without image_addr finds its image by range; an address outside every function is unmapped.
	req = crashyRequest()
	req.Frames = []NativeFrame{{InstructionAddr: "0x104a0050c"}, {InstructionAddr: "0x104a03000"}}
	res, _ = sym.Symbolicate(ctx, req)
	if res.Frames[0].Status != FrameMapped || res.Frames[1].Status != FrameUnmapped {
		t.Errorf("by range: %+v", res.Frames)
	}
}

func TestNativeBackendErrorAndCacheBytes(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	if _, err := st.PutDSYM(ctx, DSYMUpload{ProjectID: "web-store", Data: fixture(t, "dsym/crashy.dwarf")}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(ctx, Upload{ProjectID: "web-store", DebugID: testDebugID, Map: fixture(t, "app.min.js.map")}); err != nil {
		t.Fatal(err)
	}
	// A cache of one byte still keeps the newest entry, and evicts the older one.
	sym := NewSymbolicator(st, Options{CacheBytes: 1})
	req := crashyRequest()
	req.Frames, req.Images = req.Frames[:3], req.Images[:1]
	if res, err := sym.Symbolicate(ctx, req); err != nil || res.Mapped != 4 {
		t.Fatalf("%+v %v", res, err)
	}
	if n := sym.lru.Len(); n != 1 || sym.bytes == 0 {
		t.Errorf("after the dSYM: %d entries, %d bytes", n, sym.bytes)
	}
	if c, err := sym.consumer(ctx, Ref{ProjectID: "web-store", DebugID: testDebugID}); err != nil || c == nil {
		t.Fatal(c, err)
	}
	if n := sym.lru.Len(); n != 1 || sym.bytes != int64(len(fixture(t, "app.min.js.map"))) {
		t.Errorf("after the map: %d entries, %d bytes", n, sym.bytes)
	}

	// A backend failure on every lookup is an error.
	st.Objects = &countingObjects{Objects: st.Objects, fail: errors.New("bucket down")}
	if _, err := NewSymbolicator(st, Options{}).Symbolicate(ctx, crashyRequest()); err == nil {
		t.Error("backend failure on every lookup must be an error")
	}
}

func TestSweepAndDeleteDSYM(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	now := time.Now()
	st.Now = func() time.Time { return now }
	if _, err := st.PutDSYM(ctx, DSYMUpload{ProjectID: "web-store", Data: fixture(t, "dsym/crashy.dwarf")}); err != nil {
		t.Fatal(err)
	}
	st.Retention = func(string) time.Duration { return time.Hour }
	if n, err := st.Sweep(ctx); err != nil || n != 0 {
		t.Fatalf("fresh dSYMs swept: %d %v", n, err)
	}
	if ms, _ := st.List(ctx, "web-store"); len(ms) != 2 {
		t.Errorf("list %+v", ms)
	}
	now = now.Add(2 * time.Hour)
	if n, err := st.Sweep(ctx); err != nil || n != 2 {
		t.Fatalf("expired dSYMs: %d %v", n, err)
	}
	if n, _ := st.CountProject(ctx, "web-store"); n != 0 {
		t.Errorf("left %d", n)
	}
	if _, err := st.PutDSYM(ctx, DSYMUpload{ProjectID: "web-store", Data: fixture(t, "dsym/crashy.dwarf")}); err != nil {
		t.Fatal(err)
	}
	if n, err := st.DeleteProject(ctx, "web-store"); err != nil || n != 2 {
		t.Errorf("delete: %d %v", n, err)
	}
}
