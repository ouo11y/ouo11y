package symbolicate

// The DWARF reader of services/rum-api/internal/sourcemap/dsym.go (removed by ADR-0026).

import (
	"bytes"
	"debug/dwarf"
	"debug/macho"
	"encoding/hex"
	"sort"
	"strings"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// lcUUID is the LC_UUID load command: cmd, cmdsize, then the 16-byte UUID.
const lcUUID = 0x1b

// machoUUID returns the LC_UUID as a normalized debug id.
func machoUUID(f *macho.File) (string, bool) {
	for _, l := range f.Loads {
		raw := l.Raw()
		if len(raw) >= 24 && f.ByteOrder.Uint32(raw) == lcUUID {
			return ouogo.NormalizeDebugID(hex.EncodeToString(raw[8:24]))
		}
	}
	return "", false
}

// debugFile is the DWARF of one slice, ready for address lookups.
type debugFile struct {
	id    string // the slice's LC_UUID, normalised
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
	id, _ := machoUUID(f)
	df := &debugFile{d: d, id: id}
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
