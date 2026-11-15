package symbolicate

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// JVMFrame is one entry of ouo.crash.frames on Android (sdk/android signals-core
// JvmFrame): Sentry's Java frame names, module is the class, function the method.
type JVMFrame struct {
	Module   string `json:"module"`
	Function string `json:"function"`
	Filename string `json:"filename,omitempty"`
	Lineno   int    `json:"lineno,omitempty"` // 0: no line
}

// pgMap is a parsed R8 / ProGuard mapping (ADR-0027): the classes by their obfuscated
// name, and the original class names' source files.
type pgMap struct {
	classes map[string]*pgClass // obfuscated name -> class
	files   map[string]string   // original class name -> source file
	synth   map[string]bool     // original class names R8 synthesized (lambdas, outlines)
}

type pgClass struct {
	original string
	methods  map[string][]*pgMember // obfuscated method name -> entries, in file order
}

// pgMember is one method line: "[a:b:]ret name(args)[:c[:d]] -> x". name is the original
// method, qualified with its class when it was inlined from another class.
type pgMember struct {
	obfStart, obfEnd   int
	hasObf             bool
	class, name, args  string
	origStart, origEnd int
	nOrig              int // how many original line numbers the line gave: 0, 1 or 2
	synthesized        bool
}

var pgMethod = regexp.MustCompile(`^\s+(?:(\d+):(\d+):)?\S+ ([^\s(]+)\(([^)]*)\)(?::(\d+)(?::(\d+))?)? -> (\S+)$`)

// parseProguard reads R8's mapping format (version 2.x; ProGuard's is a subset). Fields,
// outlines and rewriteFrame metadata are ignored.
func parseProguard(b []byte) (any, error) {
	m := &pgMap{classes: map[string]*pgClass{}, files: map[string]string{}, synth: map[string]bool{}}
	var cls *pgClass
	var last *pgMember
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for sc.Scan() {
		line := sc.Text()
		trimmed := strings.TrimSpace(line)
		switch {
		case trimmed == "":
		case strings.HasPrefix(trimmed, "#"):
			if cls == nil {
				continue
			}
			var meta struct {
				ID       string `json:"id"`
				FileName string `json:"fileName"`
			}
			if json.Unmarshal([]byte(strings.TrimSpace(trimmed[1:])), &meta) != nil {
				continue
			}
			indented := line[0] == ' ' || line[0] == '\t'
			switch {
			case meta.ID == "sourceFile" && !indented:
				m.files[cls.original] = meta.FileName
			case meta.ID == "com.android.tools.r8.synthesized" && !indented:
				m.synth[cls.original] = true
			case meta.ID == "com.android.tools.r8.synthesized" && last != nil:
				last.synthesized = true
			}
		case line[0] != ' ' && line[0] != '\t':
			// "original.Class -> obf.Class:"
			orig, obf, ok := strings.Cut(strings.TrimSuffix(trimmed, ":"), " -> ")
			if !ok {
				cls = nil
				continue
			}
			cls = &pgClass{original: orig, methods: map[string][]*pgMember{}}
			m.classes[obf] = cls
			last = nil
		default:
			last = nil
			if cls == nil {
				continue
			}
			g := pgMethod.FindStringSubmatch(line)
			if g == nil {
				continue // a field
			}
			mb := &pgMember{class: cls.original, name: g[3], args: g[4]}
			if i := strings.LastIndexByte(g[3], '.'); i > 0 {
				mb.class, mb.name = g[3][:i], g[3][i+1:]
			}
			if g[1] != "" {
				mb.hasObf = true
				mb.obfStart, _ = strconv.Atoi(g[1])
				mb.obfEnd, _ = strconv.Atoi(g[2])
			}
			if g[5] != "" {
				mb.nOrig = 1
				mb.origStart, _ = strconv.Atoi(g[5])
				if g[6] != "" {
					mb.nOrig = 2
					mb.origEnd, _ = strconv.Atoi(g[6])
				}
			}
			cls.methods[g[7]] = append(cls.methods[g[7]], mb)
			last = mb
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(m.classes) == 0 {
		return nil, nil
	}
	// A synthesized flag on one line of a method marks every line of it.
	for _, c := range m.classes {
		synth := map[string]bool{}
		for _, ms := range c.methods {
			for _, mb := range ms {
				if mb.synthesized {
					synth[mb.class+"."+mb.name+"("+mb.args+")"] = true
				}
			}
		}
		for _, ms := range c.methods {
			for _, mb := range ms {
				mb.synthesized = mb.synthesized || synth[mb.class+"."+mb.name+"("+mb.args+")"]
			}
		}
	}
	return m, nil
}

// fileOf is the source file of an original class: the mapping's sourceFile, else the
// outer class's simple name + ".java", as R8's retrace prints it.
func (m *pgMap) fileOf(class string) string {
	if f := m.files[class]; f != "" {
		return f
	}
	s := class[strings.LastIndexByte(class, '.')+1:]
	if i := strings.IndexByte(s, '$'); i > 0 {
		s = s[:i]
	}
	return s + ".java"
}

// pgRow is one original frame of a retraced frame (several when R8 inlined).
type pgRow struct {
	class, method, file string
	line                int
	synthetic           bool
}

// retrace maps one frame; the rows are innermost first. ok is false when the class is
// not in the mapping (a library or platform frame R8 did not touch). nil rows with ok
// true is unmapped: the method or the line is not there, or several originals match.
func (m *pgMap) retrace(f JVMFrame) (rows []pgRow, ok bool) {
	c := m.classes[f.Module]
	if c == nil {
		return nil, false
	}
	entries := c.methods[f.Function]
	// Inline groups: consecutive entries on the same obfuscated range, innermost first.
	var all [][]*pgMember
	for i := 0; i < len(entries); {
		j := i + 1
		for j < len(entries) && entries[i].hasObf && entries[j].hasObf && entries[j].obfStart == entries[i].obfStart && entries[j].obfEnd == entries[i].obfEnd {
			j++
		}
		all = append(all, entries[i:j])
		i = j
	}
	var groups [][]*pgMember
	for _, g := range all {
		if f.Lineno > 0 && g[0].hasObf && f.Lineno >= g[0].obfStart && f.Lineno <= g[0].obfEnd {
			groups = append(groups, g)
		}
	}
	if len(groups) == 0 {
		// No line, or no range holds it: an entry without a range, or else the outermost
		// method of any group, but only when they all name one original method.
		var cands []*pgMember
		for _, e := range entries {
			if !e.hasObf {
				cands = append(cands, e)
			}
		}
		if len(cands) == 0 {
			for _, g := range all {
				cands = append(cands, g[len(g)-1])
			}
		}
		for _, e := range cands {
			if e.class != cands[0].class || e.name != cands[0].name {
				return nil, true
			}
		}
		if len(cands) == 0 {
			return nil, true
		}
		e := cands[0]
		line := 0
		if !e.hasObf && e.nOrig == 0 {
			line = f.Lineno // never renumbered
		}
		return []pgRow{{class: e.class, method: e.name, file: m.fileOf(e.class), line: line, synthetic: e.synthesized}}, true
	}
	for _, g := range groups[1:] {
		if g[0].class != groups[0][0].class || g[0].name != groups[0][0].name {
			return nil, true
		}
	}
	for _, e := range groups[0] {
		line := 0
		switch {
		case e.nOrig == 2 && e.origEnd-e.origStart == e.obfEnd-e.obfStart:
			line = e.origStart + f.Lineno - e.obfStart
		case e.nOrig >= 1:
			line = e.origStart
		default:
			line = f.Lineno
		}
		rows = append(rows, pgRow{class: e.class, method: e.name, file: m.fileOf(e.class), line: line, synthetic: e.synthesized || m.synth[e.class]})
	}
	// R8's retrace drops the synthetic rows (lambda classes, bridges) when others remain.
	kept := rows[:0:0]
	for _, r := range rows {
		if !r.synthetic {
			kept = append(kept, r)
		}
	}
	if len(kept) > 0 {
		rows = kept
	}
	return rows, true
}

// ResolveJVM retraces the JVM frames of an Android exception (e.JVMFrames) with the R8
// mapping uploaded under e.MappingID (kind "proguard", ADR-0027), and only that one: no
// id or no upload is no_map for every frame. A frame of a class the mapping does not
// know (the platform, an unminified library) is no_map; an inlined method is a row of
// its own, innermost first, like a dSYM frame. The stack's "at" lines are rewritten,
// and the exception class in its first line.
func (r *Resolver) ResolveJVM(ctx context.Context, e Exception) (Result, error) {
	var m *pgMap
	id, _ := ouogo.NormalizeDebugID(e.MappingID)
	if id != "" {
		v, err := r.lookup(ctx).file(e.Project, ouogo.DebugFileProguard, id, parseProguard)
		if err != nil {
			return Result{}, fmt.Errorf("load R8 mapping: %w", err)
		}
		m, _ = v.(*pgMap)
	}
	res := Result{Frames: []Frame{}}
	byFrame := make([][]Frame, len(e.JVMFrames))
	for i, f := range e.JVMFrames {
		gen := Frame{Status: FrameNoMap, DebugID: id, Generated: Position{File: f.Filename, Line: f.Lineno, Function: f.Module + "." + f.Function}}
		if m == nil {
			gen.DebugID = ""
			byFrame[i] = []Frame{gen}
			continue
		}
		rows, ok := m.retrace(f)
		switch {
		case !ok:
			byFrame[i] = []Frame{gen}
		case len(rows) == 0:
			gen.Status = FrameUnmapped
			byFrame[i] = []Frame{gen}
		default:
			for j, row := range rows {
				fr := gen
				fr.Status = FrameMapped
				fr.Original = &Position{File: row.file, Line: row.line, Function: row.class + "." + row.method}
				fr.Inlined = j < len(rows)-1
				byFrame[i] = append(byFrame[i], fr)
			}
			res.Mapped++
		}
	}
	for _, frs := range byFrame {
		res.Frames = append(res.Frames, frs...)
	}
	res.Status = status(res.Mapped, len(e.JVMFrames))
	res.Stacktrace = jvmStack(e.Stacktrace, byFrame, m)
	return res, nil
}

// jvmLine matches an "at" line of a Java stack ("\tat a.b.run(SourceFile:80)").
var jvmLine = regexp.MustCompile(`^(\s*at )\S+\(.*\)\s*$`)

// jvmStack rewrites the stack text: the n-th "at" line is the n-th frame, printed as
// R8's retrace prints it, one line per inlined method; the first line's exception class
// is retraced. Without a stack text the frames alone are printed.
func jvmStack(raw string, byFrame [][]Frame, m *pgMap) string {
	render := func(prefix string, frs []Frame) []string {
		var out []string
		for _, fr := range frs {
			p := fr.Generated
			if fr.Original != nil {
				p = *fr.Original
			}
			where := p.File
			if where == "" {
				where = "Unknown Source"
			}
			if p.Line > 0 {
				where += ":" + strconv.Itoa(p.Line)
			}
			out = append(out, fmt.Sprintf("%s%s(%s)", prefix, p.Function, where))
		}
		return out
	}
	if strings.TrimSpace(raw) == "" {
		var out []string
		for _, frs := range byFrame {
			out = append(out, render("    at ", frs)...)
		}
		return strings.Join(out, "\n")
	}
	var out []string
	n := 0
	for i, l := range strings.Split(strings.TrimRight(raw, "\n"), "\n") {
		if name, _, _ := strings.Cut(l, ":"); i == 0 && m != nil && m.classes[name] != nil {
			l = m.classes[name].original + l[len(name):]
		}
		g := jvmLine.FindStringSubmatch(l)
		if g == nil || n >= len(byFrame) {
			out = append(out, l)
			continue
		}
		out = append(out, render(g[1], byFrame[n])...)
		n++
	}
	return strings.Join(out, "\n")
}
