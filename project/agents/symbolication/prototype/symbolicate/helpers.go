package symbolicate

// Copied unchanged from services/rum-api/internal/sourcemap/symbolicate.go
// (function-name heuristics, frame formatting, source context), to show that
// the move to ouo-go is a move of code, not a rewrite.

import (
	"fmt"
	"path"
	"regexp"
	"strings"
)

// contextLines is how many source lines are returned before and after a frame.
const contextLines = 3

func status(mapped, frames int) string {
	switch {
	case mapped > 0 && mapped == frames:
		return StatusOK
	case mapped > 0:
		return StatusPartial
	}
	return StatusNoMaps
}

// funcDecl matches the line that opens a named function: a declaration, a
// variable or property holding a function or arrow, or a method.
var funcDecl = regexp.MustCompile(`(?:function\*?\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b[^(]*\(|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{)`)

// notFunctions are keywords the method form of funcDecl would take for a name.
var notFunctions = map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true, "with": true, "return": true}

// enclosingFunction finds the name of the function around (line, col) of the
// original source by walking back to the nearest unmatched "{" (or arrow) whose
// line declares a function. A heuristic: strings and comments are not parsed,
// so a brace inside one can mislead it; then the caller-name rule is used.
func enclosingFunction(content string, line, col int) string {
	if content == "" || line < 1 {
		return ""
	}
	lines := strings.Split(content, "\n")
	if line > len(lines) {
		return ""
	}
	depth := 0
	for i := line - 1; i >= 0 && i >= line-1-400; i-- {
		text := lines[i]
		if i == line-1 && col < len(text) {
			text = text[:col]
		}
		for j := len(text) - 1; j >= 0; j-- {
			switch text[j] {
			case '}':
				depth++
			case '{':
				if depth > 0 {
					depth--
					continue
				}
				if name := declName(lines, i, text[:j+1]); name != "" {
					return name
				}
			}
		}
		// A concise arrow body has no brace: `const f = () => expr` on this line.
		if i == line-1 && depth == 0 && strings.Contains(text, "=>") {
			if name := declName(lines, i, text); name != "" {
				return name
			}
		}
	}
	return ""
}

// declName returns the function name declared on head (a line up to its
// opening brace), looking one line up for signatures split over two lines.
func declName(lines []string, i int, head string) string {
	for _, cand := range []string{head, prevLine(lines, i) + " " + head} {
		m := funcDecl.FindStringSubmatch(cand)
		if m == nil {
			continue
		}
		for _, g := range m[1:] {
			if g != "" && !notFunctions[g] {
				return g
			}
		}
	}
	return ""
}

func prevLine(lines []string, i int) string {
	if i == 0 {
		return ""
	}
	return lines[i-1]
}

func nextFrame(parsed []parsedLine, i int) *parsedLine {
	for j := i + 1; j < len(parsed); j++ {
		if parsed[j].frame != nil {
			return &parsed[j]
		}
	}
	return nil
}

// formatFrame rewrites a frame line in the engine's own style.
func formatFrame(raw string, p *Position) string {
	loc := fmt.Sprintf("%s:%d:%d", p.File, p.Line, p.Column)
	indent := raw[:len(raw)-len(strings.TrimLeft(raw, " \t"))]
	if v8Frame.MatchString(raw) {
		suffix := ""
		if strings.HasSuffix(strings.TrimRight(raw, " \t"), " [in app]") {
			suffix = " [in app]"
		}
		if p.Function != "" {
			return indent + "at " + p.Function + " (" + loc + ")" + suffix
		}
		return indent + "at " + loc + suffix
	}
	return indent + p.Function + "@" + loc
}

// displaySource turns a map's source path into a project path:
// "../../src/App.tsx" and "webpack://shop/./src/App.tsx" become "src/App.tsx".
func displaySource(src string) string {
	if i := strings.Index(src, "://"); i >= 0 {
		rest := src[i+3:]
		if strings.HasPrefix(src, "webpack") {
			if _, after, ok := strings.Cut(rest, "/"); ok {
				rest = after
			}
		}
		src = rest
	}
	src = path.Clean(src)
	for strings.HasPrefix(src, "../") {
		src = src[3:]
	}
	return strings.TrimPrefix(src, "./")
}

func sourceContext(content string, line int) *Context {
	if content == "" || line < 1 {
		return nil
	}
	lines := strings.Split(content, "\n")
	if line > len(lines) {
		return nil
	}
	clip := func(s string) string {
		if len(s) > 300 {
			return s[:300] + "…"
		}
		return s
	}
	c := &Context{Line: clip(lines[line-1]), Pre: []string{}, Post: []string{}}
	for i := max(0, line-1-contextLines); i < line-1; i++ {
		c.Pre = append(c.Pre, clip(lines[i]))
	}
	for i := line; i < min(len(lines), line+contextLines); i++ {
		c.Post = append(c.Post, clip(lines[i]))
	}
	return c
}
