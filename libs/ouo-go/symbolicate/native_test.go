package symbolicate

import (
	"context"
	"debug/macho"
	"errors"
	"strings"
	"testing"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// testdata/dsym/crashy.dwarf is the dSYM DWARF of crashy.c for arm64 and x86_64
// (dsym/gen.sh). The UUIDs and addresses below are what gen.sh printed, checked with
// `atos -i -arch arm64 -o crashy.dwarf -l 0x100000000 <addr>`. Muninn stores one slice
// per debug id (the upload CLI splits a universal file), so the tests store slices.
const (
	crashyARM64 = "3ccbba5f-01c6-36b3-9475-412655ac7ffe"
	crashyX86   = "af6a9aa7-dee9-35d6-90c3-f007eceb1efc"
)

// slice returns one architecture slice of the universal fixture.
func slice(t *testing.T, cpu macho.Cpu) []byte {
	t.Helper()
	b := fixture(t, "dsym/crashy.dwarf")
	ff, err := macho.NewFatFile(strings.NewReader(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	defer ff.Close()
	for _, a := range ff.Arches {
		if a.Cpu == cpu {
			return b[a.Offset : a.Offset+a.Size]
		}
	}
	t.Fatalf("no %v slice", cpu)
	return nil
}

// crashyException is a crash in crash_here as the SDK reports it, with the image loaded
// at 0x104a00000 (ASLR slide 0x4a00000) and one frame in a system library without a dSYM.
func crashyException() Exception {
	return Exception{
		Project: "shop",
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

func TestResolveNative(t *testing.T) {
	ctx := context.Background()
	src := newFake()
	r := New(src, Options{})
	// No dSYM: every frame stays as it is.
	res, err := r.Resolve(ctx, crashyException())
	if err != nil || res.Status != StatusNoMaps || len(res.Frames) != 4 || res.Frames[0].Generated.File != "crashy" || res.Frames[0].Address != "0x104a0050c" {
		t.Fatalf("before upload: %+v %v", res, err)
	}

	src.put(ouogo.DebugFileDSYM, crashyARM64, "", "", slice(t, macho.CpuArm64))
	r = New(src, Options{})
	res, err = r.Resolve(ctx, crashyException())
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
		got := want{status: f.Status, inlined: f.Inlined}
		if f.Original != nil {
			got.fn, got.file, got.line = f.Original.Function, f.Original.File, f.Original.Line
		}
		if got != w {
			t.Errorf("frame %d = %+v (%+v), want %+v", i, got, f, w)
		}
	}
	if res.Frames[0].DebugID != crashyARM64 || res.Frames[4].Generated.File != "dyld" {
		t.Errorf("frame fields %+v", res.Frames)
	}
	if res.Status != StatusPartial || res.Mapped != 3 { // 3 of 4 captured frames; the inlined row is not counted
		t.Errorf("status %s mapped %d", res.Status, res.Mapped)
	}
	for _, line := range []string{
		"0   crashy                          0x0000000104a0050c crash_here (in crashy) (crashy.c:8)",
		"1   crashy                          0x0000000104a00534 inlined_step (in crashy) (crashy.c:13)",
		"1   crashy                          0x0000000104a00534 level1 (in crashy) (crashy.c:17)",
		"2   crashy                          0x0000000104a00570 main (in crashy) (crashy.c:22)",
		"3   dyld                            0x0000000189e1e0e0 0x189e18000 + 24800",
		"Binary Images:",
	} {
		if !strings.Contains(res.Stacktrace+"\n", line+"\n") {
			t.Errorf("stacktrace lacks %q:\n%s", line, res.Stacktrace)
		}
	}

	// A frame without image_addr finds its image by range; an address outside every function is unmapped.
	e := crashyException()
	e.Frames = []NativeFrame{{InstructionAddr: "0x104a0050c"}, {InstructionAddr: "0x104a03000"}}
	res, _ = r.ResolveNative(ctx, e)
	if res.Frames[0].Status != FrameMapped || res.Frames[1].Status != FrameUnmapped {
		t.Errorf("by range: %+v", res.Frames)
	}
}

func TestResolveNativeMisses(t *testing.T) {
	ctx := context.Background()
	e := crashyException()
	e.Frames, e.Images = e.Frames[:1], e.Images[:1]

	// Another slice stored under this image's id, and a file that is no Mach-O: no map.
	for name, b := range map[string][]byte{"x86_64 slice": slice(t, macho.CpuAmd64), "garbage": []byte("{}")} {
		src := newFake()
		src.put(ouogo.DebugFileDSYM, crashyARM64, "", "", b)
		res, err := New(src, Options{}).Resolve(ctx, e)
		if err != nil || res.Frames[0].Status != FrameNoMap {
			t.Errorf("%s: %+v %v", name, res.Frames, err)
		}
	}

	// Muninn down for every lookup: an error.
	src := newFake()
	src.setFail(errors.New("down"))
	if _, err := New(src, Options{}).Resolve(ctx, e); err == nil {
		t.Error("Muninn failing every lookup must be an error")
	}
}
