package symbolicate

import (
	"context"
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// NativeFrame is one entry of ouo.crash.frames (project/kb-archive/ios-native-crashes.md), as JSON.
type NativeFrame struct {
	InstructionAddr string `json:"instruction_addr"`
	ImageAddr       string `json:"image_addr,omitempty"`
}

// NativeImage is one entry of ouo.crash.images: a loaded binary, with
// Sentry's debug_meta field names. DebugID is the image's LC_UUID.
type NativeImage struct {
	CodeFile    string `json:"code_file"`
	DebugID     string `json:"debug_id,omitempty"`
	ImageAddr   string `json:"image_addr"`
	ImageSize   uint64 `json:"image_size"`
	ImageVMAddr string `json:"image_vmaddr"`
}

// nativeLine matches a frame line of the Apple-style stack the SDK writes:
// "0   sentrydemo                      0x0000000104a1c2f0 0x104a00000 + 115440".
// Group 2 is the frame index, group 1 the line up to the address. The binary
// name may contain spaces ("My App").
var nativeLine = regexp.MustCompile(`^((\d+)\s+.+?\s+0x[0-9a-fA-F]+)`)

func parseHex(s string) (uint64, bool) {
	v, err := strconv.ParseUint(strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X"), 16, 64)
	return v, err == nil && s != ""
}

// ResolveNative resolves each frame of a native crash (e.Frames, e.Images) against the
// dSYM slice of its image, kind "dsym" under the image's debug id (its LC_UUID):
// svma = instruction_addr - image_addr + image_vmaddr, minus one for every frame but the
// first (a return address points after the call). A frame whose image has no uploaded
// dSYM stays as it is (no_map); an inlined function is a row of its own. An error is
// returned only when every lookup failed.
func (r *Resolver) ResolveNative(ctx context.Context, e Exception) (Result, error) {
	l := r.lookup(ctx)
	type image struct {
		NativeImage
		addr, vmaddr uint64
		id           string
	}
	var images []image
	for _, im := range e.Images {
		a, ok1 := parseHex(im.ImageAddr)
		vm, ok2 := parseHex(im.ImageVMAddr)
		if !ok1 || !ok2 {
			continue
		}
		id, _ := ouogo.NormalizeDebugID(im.DebugID)
		images = append(images, image{NativeImage: im, addr: a, vmaddr: vm, id: id})
	}
	find := func(f NativeFrame, pc uint64) *image {
		base, hasBase := parseHex(f.ImageAddr)
		for i := range images {
			im := &images[i]
			if hasBase && im.addr == base || !hasBase && pc >= im.addr && pc < im.addr+im.ImageSize {
				return im
			}
		}
		return nil
	}

	var firstErr error
	lookups, failed := 0, 0
	byFrame := make([][]Frame, len(e.Frames))
	res := Result{Frames: []Frame{}}
	for i, f := range e.Frames {
		pc, ok := parseHex(f.InstructionAddr)
		im := find(f, pc)
		gen := Frame{Status: FrameNoMap, Address: f.InstructionAddr}
		if im == nil || !ok || pc < im.addr {
			byFrame[i] = []Frame{gen}
			continue
		}
		gen.Generated.File, gen.DebugID = path.Base(im.CodeFile), im.id
		var df *debugFile
		if im.id != "" {
			lookups++
			v, err := l.file(e.Project, ouogo.DebugFileDSYM, im.id, func(b []byte) (any, error) {
				df, err := parseDebugFile(b)
				if err != nil || df.id != im.id {
					return nil, err // another slice stored under this id is no map for it
				}
				return df, nil
			})
			if err != nil {
				gen.Status = FrameUnavailable
				failed++
				if firstErr == nil {
					firstErr = err
				}
			}
			df, _ = v.(*debugFile)
		}
		if df == nil {
			byFrame[i] = []Frame{gen}
			continue
		}
		svma := pc - im.addr + im.vmaddr
		if i > 0 {
			svma--
		}
		locs := df.lookup(svma)
		if len(locs) == 0 {
			gen.Status = FrameUnmapped
			byFrame[i] = []Frame{gen}
			continue
		}
		for j, l := range locs {
			fr := gen
			fr.Status = FrameMapped
			fr.Original = &Position{File: l.File, Line: l.Line, Column: l.Column, Function: l.Function}
			fr.Inlined = j < len(locs)-1
			byFrame[i] = append(byFrame[i], fr)
		}
	}
	if lookups > 0 && failed == lookups {
		return Result{}, fmt.Errorf("load dSYMs: %w", firstErr)
	}
	// Mapped and Status count captured frames: the inlined rows before a
	// frame's last row are not counted, so "4/5" does not depend on inlining.
	for _, frs := range byFrame {
		if frs[len(frs)-1].Status == FrameMapped {
			res.Mapped++
		}
		res.Frames = append(res.Frames, frs...)
	}
	res.Status = status(res.Mapped, len(e.Frames))
	res.Stacktrace = nativeStack(e.Stacktrace, byFrame)
	return res, nil
}

// nativeStack rewrites the frame lines of the Apple-style stack in atos
// style, "crash_here (in crashy) (crashy.c:8)", one line per inlined
// function. Other lines (the title, Binary Images) are kept. Without a stack
// text the frames alone are printed.
func nativeStack(raw string, byFrame [][]Frame) string {
	render := func(prefix string, frs []Frame) []string {
		var out []string
		for _, fr := range frs {
			if fr.Original == nil {
				return []string{prefix}
			}
			o := fr.Original
			loc := path.Base(o.File)
			if o.Line > 0 {
				loc += ":" + strconv.Itoa(o.Line)
			}
			fn := o.Function
			if fn == "" {
				fn = "???"
			}
			out = append(out, fmt.Sprintf("%s %s (in %s) (%s)", prefix, fn, fr.Generated.File, loc))
		}
		return out
	}
	if strings.TrimSpace(raw) == "" {
		var out []string
		for i, frs := range byFrame {
			prefix := fmt.Sprintf("%-4d%-32s%s", i, frs[0].Generated.File, frs[0].Address)
			out = append(out, render(prefix, frs)...)
		}
		return strings.Join(out, "\n")
	}
	var out []string
	for _, l := range strings.Split(strings.TrimRight(raw, "\n"), "\n") {
		m := nativeLine.FindStringSubmatch(l)
		if m == nil {
			out = append(out, l)
			continue
		}
		n, err := strconv.Atoi(m[2])
		if err != nil || n >= len(byFrame) || byFrame[n][0].Original == nil {
			out = append(out, l)
			continue
		}
		out = append(out, render(m[1], byFrame[n])...)
	}
	return strings.Join(out, "\n")
}
