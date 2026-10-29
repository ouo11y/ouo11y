package sourcemap

import (
	"bytes"
	"context"
	"debug/dwarf"
	"debug/macho"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"
)

// DefaultMaxDSYMBytes limits one uploaded dSYM DWARF file, all slices
// together (limits.max_dsym_bytes). A React Native app's Release dSYM is
// about 50 MiB.
const DefaultMaxDSYMBytes = 512 << 20

// lcUUID is the LC_UUID load command: cmd, cmdsize, then the 16-byte UUID.
const lcUUID = 0x1b

func dsymKey(project, id string) string { return project + "/dsym/" + id }

func (s *Store) maxDSYMBytes() int64 {
	if s.MaxDSYMBytes > 0 {
		return s.MaxDSYMBytes
	}
	return DefaultMaxDSYMBytes
}

// DSYMUpload is one DWARF file from a .dSYM bundle
// (Contents/Resources/DWARF/<name>): thin or universal (fat).
type DSYMUpload struct {
	ProjectID string
	Release   string // optional, informational
	File      string // the binary's name, informational
	Data      []byte
}

// PutDSYM stores every architecture slice of a DWARF file under its LC_UUID,
// the debug_id of the binary image in a crash report. A re-upload replaces
// the slice and restarts its retention.
func (s *Store) PutDSYM(ctx context.Context, u DSYMUpload) ([]Meta, error) {
	if !ValidProject(u.ProjectID) {
		return nil, fmt.Errorf("%w: project id", ErrInvalid)
	}
	if max := s.maxDSYMBytes(); int64(len(u.Data)) > max {
		return nil, fmt.Errorf("%w: %d bytes, limit %d", ErrTooLarge, len(u.Data), max)
	}
	slices, err := machoSlices(u.Data)
	if err != nil {
		return nil, err
	}
	name := ""
	if u.File != "" {
		name = path.Base(u.File)
	}
	var out []Meta
	for _, sl := range slices {
		f, err := macho.NewFile(bytes.NewReader(sl))
		if err != nil {
			return nil, fmt.Errorf("%w: not a Mach-O file: %v", ErrInvalid, err)
		}
		id, ok := machoUUID(f)
		if !ok {
			return nil, fmt.Errorf("%w: no LC_UUID in the %s slice", ErrInvalid, archName(f))
		}
		if f.Section("__debug_info") == nil {
			return nil, fmt.Errorf("%w: no DWARF (__debug_info) in the %s slice: upload the file inside the .dSYM bundle", ErrInvalid, archName(f))
		}
		m := Meta{ProjectID: u.ProjectID, Kind: "dsym", DebugID: id, Release: u.Release, File: name,
			Arch: archName(f), Bytes: int64(len(sl)), UploadedAt: s.now().UTC()}
		meta, _ := json.Marshal(m)
		if err := s.putObject(ctx, dsymKey(u.ProjectID, id), ".dwarf.gz", gzipBytes(sl).Bytes(), meta); err != nil {
			return out, err
		}
		out = append(out, m)
	}
	return out, nil
}

// machoSlices returns the architecture slices of a universal file, or the
// file itself when it is thin.
func machoSlices(b []byte) ([][]byte, error) {
	ff, err := macho.NewFatFile(bytes.NewReader(b))
	if errors.Is(err, macho.ErrNotFat) {
		return [][]byte{b}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("%w: not a Mach-O file: %v", ErrInvalid, err)
	}
	defer ff.Close()
	var out [][]byte
	for _, a := range ff.Arches {
		end := uint64(a.Offset) + uint64(a.Size)
		if end > uint64(len(b)) {
			return nil, fmt.Errorf("%w: truncated universal file", ErrInvalid)
		}
		out = append(out, b[a.Offset:end])
	}
	return out, nil
}

// machoUUID returns the LC_UUID as a normalized debug id.
func machoUUID(f *macho.File) (string, bool) {
	for _, l := range f.Loads {
		raw := l.Raw()
		if len(raw) >= 24 && f.ByteOrder.Uint32(raw) == lcUUID {
			return NormalizeDebugID(hex.EncodeToString(raw[8:24]))
		}
	}
	return "", false
}

func archName(f *macho.File) string {
	switch f.Cpu {
	case macho.CpuArm64:
		return "arm64"
	case macho.CpuAmd64:
		return "x86_64"
	}
	return strings.ToLower(strings.TrimPrefix(f.Cpu.String(), "Cpu"))
}

// debugFile is the DWARF of one slice, ready for address lookups.
type debugFile struct {
	d     *dwarf.Data
	units []unit
	syms  []symbol // function symbols in __TEXT,__text, by address
	end   uint64   // end of __text
}

type symbol struct {
	addr uint64
	name string
}

// unit is a compilation unit and its address ranges. dsymutil writes a unit's
// range as the span of its functions, so units overlap: Reader.SeekPC, which
// stops at the first match, can pick a unit that has no code at the address.
type unit struct {
	e      *dwarf.Entry
	ranges [][2]uint64
}

func parseDebugFile(b []byte) (*debugFile, error) {
	f, err := macho.NewFile(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	d, err := f.DWARF()
	if err != nil {
		return nil, err
	}
	df := &debugFile{d: d}
	if text := f.Section("__text"); text != nil && f.Symtab != nil {
		df.end = text.Addr + text.Size
		idx := uint8(0)
		for i, sec := range f.Sections {
			if sec == text {
				idx = uint8(i + 1)
			}
		}
		for _, sy := range f.Symtab.Syms {
			// N_SECT and not a debugging (stab) entry.
			if sy.Type&0xe0 == 0 && sy.Type&0x0e == 0x0e && sy.Sect == idx {
				df.syms = append(df.syms, symbol{addr: sy.Value, name: strings.TrimPrefix(sy.Name, "_")})
			}
		}
		sort.Slice(df.syms, func(i, j int) bool { return df.syms[i].addr < df.syms[j].addr })
	}
	r := d.Reader()
	for {
		e, err := r.Next()
		if err != nil {
			return nil, err
		}
		if e == nil {
			return df, nil
		}
		if e.Tag == dwarf.TagCompileUnit {
			if rg, err := d.Ranges(e); err == nil && len(rg) > 0 {
				df.units = append(df.units, unit{e: e, ranges: rg})
			}
		}
		r.SkipChildren() // jumps to the next unit
	}
}

// location is one function at an address with its file and line.
type location struct {
	Function string
	File     string
	Line     int
	Column   int
}

// lookup returns the functions at svma (an address in the slice's own
// address space): the innermost first, then each function it was inlined
// into, as atos -i prints them. Code without DWARF gets the name of the
// nearest symbol before it and no file. Nil when nothing covers svma.
func (df *debugFile) lookup(svma uint64) []location {
	var lineOnly []location
	for _, u := range df.units {
		if !inRanges(u.ranges, svma) {
			continue
		}
		locs, scoped := df.lookupIn(u.e, svma)
		if scoped {
			return locs
		}
		if lineOnly == nil {
			lineOnly = locs
		}
	}
	if lineOnly != nil || svma >= df.end {
		return lineOnly
	}
	i := sort.Search(len(df.syms), func(i int) bool { return df.syms[i].addr > svma }) - 1
	if i < 0 {
		return nil
	}
	return []location{{Function: df.syms[i].name}}
}

// lookupIn looks svma up in one unit; scoped reports that a function DIE
// contains it (not only a line table row).
func (df *debugFile) lookupIn(cu *dwarf.Entry, svma uint64) (locs []location, scoped bool) {
	r := df.d.Reader()
	r.Seek(cu.Offset)
	if _, err := r.Next(); err != nil { // the unit entry; r now reads its children
		return nil, false
	}
	inner := location{}
	var files []*dwarf.LineFile
	if lr, err := df.d.LineReader(cu); err == nil && lr != nil {
		var le dwarf.LineEntry
		if lr.SeekPC(svma, &le) == nil && le.File != nil {
			inner = location{File: le.File.Name, Line: le.Line, Column: le.Column}
		}
		files = lr.Files()
	}
	scopes := df.scopes(r, svma) // outermost first
	if len(scopes) == 0 {
		if inner.File == "" {
			return nil, false
		}
		return []location{inner}, false
	}
	out := make([]location, 0, len(scopes))
	at := inner
	for i := len(scopes) - 1; i >= 0; i-- {
		e := scopes[i]
		at.Function = df.name(e, 0)
		out = append(out, at)
		// The caller's position is where this scope was inlined.
		line, _ := intAttr(e, dwarf.AttrCallLine)
		col, _ := intAttr(e, dwarf.AttrCallColumn)
		at = location{Line: line, Column: col}
		if fi, ok := intAttr(e, dwarf.AttrCallFile); ok && fi >= 0 && fi < len(files) && files[fi] != nil {
			at.File = files[fi].Name
		}
	}
	return out, true
}

// scopes returns the subprogram and inlined-subroutine entries around pc,
// outermost first, from the children of the entry r is positioned in. It
// descends into every entry with children (namespaces, types, lexical
// blocks) except functions that do not contain pc.
func (df *debugFile) scopes(r *dwarf.Reader, pc uint64) []*dwarf.Entry {
	for {
		e, err := r.Next()
		if err != nil || e == nil || e.Tag == 0 {
			return nil
		}
		fn := e.Tag == dwarf.TagSubprogram || e.Tag == dwarf.TagInlinedSubroutine
		switch {
		case fn && df.contains(e, pc):
			if !e.Children {
				return []*dwarf.Entry{e}
			}
			return append([]*dwarf.Entry{e}, df.scopes(r, pc)...)
		case fn:
			if e.Children {
				r.SkipChildren()
			}
		case e.Children:
			if in := df.scopes(r, pc); len(in) > 0 {
				return in
			}
		}
	}
}

func (df *debugFile) contains(e *dwarf.Entry, pc uint64) bool {
	ranges, err := df.d.Ranges(e)
	return err == nil && inRanges(ranges, pc)
}

func inRanges(ranges [][2]uint64, pc uint64) bool {
	for _, rg := range ranges {
		if pc >= rg[0] && pc < rg[1] {
			return true
		}
	}
	return false
}

// name is the entry's DW_AT_name, following the abstract origin (inlined and
// out-of-line copies) or the specification (C++ and Swift methods).
func (df *debugFile) name(e *dwarf.Entry, depth int) string {
	if n, ok := e.Val(dwarf.AttrName).(string); ok {
		return n
	}
	if depth > 4 {
		return ""
	}
	for _, a := range []dwarf.Attr{dwarf.AttrAbstractOrigin, dwarf.AttrSpecification} {
		off, ok := e.Val(a).(dwarf.Offset)
		if !ok {
			continue
		}
		r := df.d.Reader()
		r.Seek(off)
		if o, err := r.Next(); err == nil && o != nil {
			return df.name(o, depth+1)
		}
	}
	if n, ok := e.Val(dwarf.AttrLinkageName).(string); ok {
		return n
	}
	return ""
}

func intAttr(e *dwarf.Entry, a dwarf.Attr) (int, bool) {
	v, ok := e.Val(a).(int64)
	return int(v), ok
}
