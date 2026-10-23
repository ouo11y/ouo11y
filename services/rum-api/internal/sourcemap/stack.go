package sourcemap

import (
	"regexp"
	"strconv"
	"strings"
)

// RawFrame is one parsed line of a JavaScript stack trace. Line and Column
// are 1-based, as engines print them.
type RawFrame struct {
	Function string
	URL      string
	Line     int
	Column   int
}

var (
	// V8 (Chrome, Edge, Node, Hermes): "    at fn (url:1:2)", "    at url:1:2",
	// "    at async fn (url:1:2)", Hermes "at fn (address at url:1:2)".
	v8Frame = regexp.MustCompile(`^\s*at (?:(.+?) \()?(?:address at )?(\S+?):(\d+):(\d+)\)?\s*$`)
	// SpiderMonkey and JavaScriptCore (Firefox, Safari): "fn@url:1:2", "@url:1:2".
	geckoFrame = regexp.MustCompile(`^\s*([^@\s]*)@(\S+?):(\d+):(\d+)\s*$`)
)

// ParseFrame parses one stack line; ok is false for lines that are not a
// frame with a position (the "TypeError: x" header, "at native", eval frames).
func ParseFrame(line string) (RawFrame, bool) {
	m := v8Frame.FindStringSubmatch(line)
	if m == nil {
		m = geckoFrame.FindStringSubmatch(line)
	}
	if m == nil || strings.HasPrefix(m[2], "eval") {
		return RawFrame{}, false
	}
	ln, err1 := strconv.Atoi(m[3])
	col, err2 := strconv.Atoi(m[4])
	if err1 != nil || err2 != nil || ln < 1 {
		return RawFrame{}, false
	}
	fn := strings.TrimPrefix(m[1], "async ")
	return RawFrame{Function: fn, URL: m[2], Line: ln, Column: col}, true
}
