package ouogo

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
)

// Debug file kinds (Muninn spec 13.1).
const (
	DebugFileSourceMap = "sourcemap"
	DebugFileDSYM      = "dsym"
	DebugFileProguard  = "proguard"
)

// debugFileMaxBytes bounds a decompressed debug file per kind: Muninn's own upload
// limits (spec 13.5), so a file Muninn accepted is never refused on the way back.
var debugFileMaxBytes = map[string]int64{
	DebugFileSourceMap: 64 << 20,
	DebugFileDSYM:      512 << 20,
	DebugFileProguard:  256 << 20,
}

// maxRelease bounds the release a candidate list is asked for (service.version).
const maxRelease = 256

var reDebugID = regexp.MustCompile(`^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`)

// NormalizeDebugID returns a debug id as Muninn stores it: a UUID, lowercase with dashes.
// It accepts the 32-hex and the uppercase spellings; ok is false for anything else.
func NormalizeDebugID(id string) (string, bool) {
	if !reDebugID.MatchString(id) {
		return "", false
	}
	h := strings.ToLower(strings.ReplaceAll(id, "-", ""))
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], true
}

// DebugFilePath is the file key of a script URL in Muninn's release index (spec 13.1):
// a full URL loses scheme, host, query and fragment; a bare name gets a leading "/";
// then path.Clean. "https://shop.example/assets/app.js?v=2" is "/assets/app.js".
func DebugFilePath(raw string) string {
	p := raw
	if u, err := url.Parse(raw); err == nil && (u.Scheme != "" || u.Host != "") {
		p = u.Path
	} else {
		p, _, _ = strings.Cut(p, "?")
		p, _, _ = strings.Cut(p, "#")
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return path.Clean(p)
}

func checkKind(kind string) error {
	if _, ok := debugFileMaxBytes[kind]; !ok {
		return &BadRequestError{Msg: "kind must be sourcemap, dsym or proguard"}
	}
	return nil
}

func debugFilesPath(project, kind string) string {
	return "/api/v1/projects/" + project + "/debug-files/" + kind
}

// DebugFile returns one debug file, decompressed (Muninn spec 13.3): a source map's
// JSON, one Mach-O DWARF slice of a dSYM, an R8 mapping. The debug id may be spelled
// 32-hex or uppercase. ErrNotFound when Muninn has no such file for the project.
func (m *Muninn) DebugFile(ctx context.Context, project, kind, debugID string) ([]byte, error) {
	if err := checkProject(project); err != nil {
		return nil, err
	}
	if err := checkKind(kind); err != nil {
		return nil, err
	}
	id, ok := NormalizeDebugID(debugID)
	if !ok {
		return nil, &BadRequestError{Msg: "debug id must be a UUID (32 hex characters, dashes optional)"}
	}
	resp, err := m.do(ctx, debugFilesPath(project, kind)+"/"+id)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := decodedUpTo(resp, debugFileMaxBytes[kind])
	if err != nil {
		return nil, &BackendError{Backend: "muninn", Err: err}
	}
	return body, nil
}

// DebugFileIDs lists the debug ids uploaded for a release and file (Muninn spec 13.3,
// DBG-11), sorted and never nil. file is normalised with DebugFilePath, so a script URL
// can be passed as recorded. What one, none or several candidates mean is the caller's
// decision (the symbolicate package maps only with exactly one).
func (m *Muninn) DebugFileIDs(ctx context.Context, project, kind, release, file string) ([]string, error) {
	if err := checkProject(project); err != nil {
		return nil, err
	}
	if err := checkKind(kind); err != nil {
		return nil, err
	}
	if release == "" || len(release) > maxRelease {
		return nil, &BadRequestError{Msg: fmt.Sprintf("release must be 1 to %d bytes", maxRelease)}
	}
	if file == "" {
		return nil, &BadRequestError{Msg: "file must not be empty"}
	}
	q := url.Values{"release": {release}, "file": {DebugFilePath(file)}}
	var a struct {
		DebugIDs []string `json:"debug_ids"`
	}
	if err := m.getJSON(ctx, debugFilesPath(project, kind)+"?"+q.Encode(), &a); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(a.DebugIDs))
	for _, id := range a.DebugIDs {
		if n, ok := NormalizeDebugID(id); ok {
			ids = append(ids, n)
		}
	}
	return ids, nil
}

// decodedUpTo is decoded with a per-kind limit: a dSYM slice can be larger than the
// 64 MiB a replay answer is held to.
func decodedUpTo(resp *http.Response, limit int64) ([]byte, error) {
	var r io.Reader = resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		r = zr
	}
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("debug file larger than %d bytes decompressed", limit)
	}
	return b, nil
}
