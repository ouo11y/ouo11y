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
	synth   map[string]bool     // classes and methods (sig) R8 synthesized: lambdas, bridges
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
}

// sig names the original method with its arguments, the key of a synthesized method.
func (e *pgMember) sig() string { return e.class + "." + e.name + "(" + e.args + ")" }

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
				m.synth[last.sig()] = true // marks every line of that method
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
	return m, nil
}

// fileOf is the source file of an original class: the mapping's sourceFile, else the
// outer class's simple name + ".java". That is what R8's retrace prints too (Kotlin
// classes included), so it is the expected output, not a guess.
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
}

// retrace maps one frame; the rows are innermost first. ok is false when the class is
// not in the mapping (a library or platform frame R8 did not touch). nil rows with ok
// true is unmapped: the method or the line is not there, or several originals match.
func (m *pgMap) retrace(f JVMFrame) (rows []pgRow, ok bool) {
	c := m.classes[f.Module]
	if c == nil {
		return nil, false
	}
	// Inline groups: an entry, then the callers it was inlined into, which R8 writes on
	// the same obfuscated range with a single original line (":c"). Entries on one range
	// without that are separate methods sharing a name: candidates, not a chain.
	entries := c.methods[f.Function]
	var all, hit [][]*pgMember
	for i := 0; i < len(entries); {
		j := i + 1
		for j < len(entries) && entries[i].hasObf && entries[j].hasObf && entries[j].obfStart == entries[i].obfStart &&
			entries[j].obfEnd == entries[i].obfEnd && entries[j].nOrig == 1 {
			j++
		}
		g := entries[i:j]
		all = append(all, g)
		if f.Lineno > 0 && g[0].hasObf && f.Lineno >= g[0].obfStart && f.Lineno <= g[0].obfEnd {
			hit = append(hit, g)
		}
		i = j
	}
	line := f.Lineno
	if len(hit) == 0 {
		// No line, or no range holds it: the groups without a range, else any group;
		// no line is known then, except for an unranged entry that was never renumbered.
		for _, g := range all {
			if !g[0].hasObf {
				hit = append(hit, g)
			}
		}
		if len(hit) == 0 {
			hit, line = all, 0
		}
	}
	if len(hit) == 0 {
		return nil, true
	}
	// Several groups only when they all end in one original method.
	out := hit[0][len(hit[0])-1]
	for _, g := range hit[1:] {
		if e := g[len(g)-1]; e.class != out.class || e.name != out.name {
			return nil, true
		}
	}
	g := hit[0]
	if len(hit) > 1 {
		g = []*pgMember{out}
	}
	for _, e := range g {
		n := 0
		switch {
		case !e.hasObf:
			if e.nOrig == 0 {
				n = line
			}
		case line == 0:
		case e.nOrig == 2 && e.origEnd-e.origStart == e.obfEnd-e.obfStart:
			n = e.origStart + line - e.obfStart
		case e.nOrig >= 1:
			n = e.origStart
		default:
			n = line
		}
		rows = append(rows, pgRow{class: e.class, method: e.name, file: m.fileOf(e.class), line: n})
	}
	// R8's retrace drops the synthetic rows (lambda classes, bridges) when others remain.
	var kept []pgRow
	for i, r := range rows {
		if !m.synth[r.class] && !m.synth[g[i].sig()] {
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
		if m != nil {
			l = retraceClass(l, m, i == 0)
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

// retraceClass retraces the exception class of a stack's first line ("a.c: msg") and of
// its "Caused by: " and "Suppressed: " lines.
func retraceClass(l string, m *pgMap, first bool) string {
	prefix := ""
	if !first {
		t := strings.TrimLeft(l, " \t")
		var ok bool
		for _, p := range []string{"Caused by: ", "Suppressed: "} {
			if strings.HasPrefix(t, p) {
				prefix, ok = l[:len(l)-len(t)]+p, true
			}
		}
		if !ok {
			return l
		}
	}
	rest := l[len(prefix):]
	name, _, _ := strings.Cut(rest, ":")
	if c := m.classes[strings.TrimSpace(name)]; c != nil && !strings.Contains(name, " ") {
		return prefix + c.original + rest[len(name):]
	}
	return l
}
