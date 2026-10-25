package httpapi

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/sourcemap"
)

const (
	uploadToken = "ut_dev_demo_00000000000000"
	mapDebugID  = "c0ffee00-0000-4000-8000-000000000001"
	bundleURL   = "https://shop.example/assets/app.min.js"
)

func smFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "sourcemap", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// newSourceMapServer is the test server with source maps on, read token set,
// and one exception with a minified stack in realSession.
func newSourceMapServer(t *testing.T) (*httptest.Server, *SourceMaps) {
	t.Helper()
	objs, err := sourcemap.NewFSObjects(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st := &sourcemap.Store{Objects: objs}
	sm := &SourceMaps{Store: st, Symbolicator: sourcemap.NewSymbolicator(st, sourcemap.Options{}),
		UploadTokens: map[string]string{testProject: uploadToken, otherProject: "ut_dev_other_0000000000000"}}
	ts, fe, _ := newTestServerWith(t, func(o *Options) {
		o.SourceMaps = sm
		o.ReadToken = readToken
		o.IngestToken = ingestToken
	})
	var last session.Event
	for _, ev := range fe.events {
		if ev.SessionID == realSession {
			last = ev
		}
	}
	fe.events = append(fe.events, session.Event{
		TS: last.TS, Name: "exception", SessionID: realSession, UserID: last.UserID, Platform: last.Platform,
		ServiceName: last.ServiceName, ServiceVersion: "1.4.2",
		Attrs: map[string]string{
			"exception_type": "RangeError", "exception_message": "negative price",
			"exception_stacktrace":    string(smFixture(t, "stack-v8.txt")),
			"ouo_project_id":          testProject,
			"ouo_exception_debug_ids": `{"` + bundleURL + `":"` + mapDebugID + `"}`,
		},
	})
	return ts, sm
}

func putMap(t *testing.T, url, token string, body []byte, gz bool) *http.Response {
	t.Helper()
	if gz {
		var b bytes.Buffer
		zw := gzip.NewWriter(&b)
		zw.Write(body)
		zw.Close()
		body = b.Bytes()
	}
	req, _ := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if gz {
		req.Header.Set("Content-Encoding", "gzip")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func TestSourceMapUploadAuth(t *testing.T) {
	ts, _ := newSourceMapServer(t)
	m := smFixture(t, "app.min.js.map")
	u := ts.URL + "/v1/sourcemaps?debug_id=" + mapDebugID
	for name, tok := range map[string]string{"none": "", "read token": readToken, "ingest token": ingestToken, "wrong": "ut_nope_000000000000000"} {
		if resp := putMap(t, u, tok, m, false); resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, resp.StatusCode)
		}
	}
	if resp := putMap(t, u+"&project="+otherProject, uploadToken, m, false); resp.StatusCode != http.StatusForbidden {
		t.Errorf("other project: status %d, want 403", resp.StatusCode)
	}
	if resp := putMap(t, u, uploadToken, []byte("not a map"), false); resp.StatusCode != http.StatusBadRequest {
		t.Errorf("invalid map: status %d, want 400", resp.StatusCode)
	}
	resp := putMap(t, u+"&release=1.4.2&file=/assets/app.min.js", uploadToken, m, true)
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("upload: status %d: %s", resp.StatusCode, b)
	}
	var meta sourcemap.Meta
	json.NewDecoder(resp.Body).Decode(&meta)
	if meta.ProjectID != testProject || meta.DebugID != mapDebugID || meta.File != "/assets/app.min.js" {
		t.Errorf("meta = %+v", meta)
	}

	// Listing is a read: the read token, not the upload token.
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/sourcemaps?project="+testProject, nil)
	req.Header.Set("Authorization", "Bearer "+uploadToken)
	if r, _ := http.DefaultClient.Do(req); r.StatusCode != http.StatusUnauthorized {
		t.Errorf("list with the upload token: %d", r.StatusCode)
	}
	var list struct{ Count int }
	getJSONAuth(t, ts.URL+"/v1/sourcemaps?project="+testProject, &list, readToken)
	if list.Count != 2 {
		t.Errorf("list count = %d, want 2 (debug id and release index)", list.Count)
	}
}

func TestSymbolicateEndpointAndReadPaths(t *testing.T) {
	ts, _ := newSourceMapServer(t)
	if resp := putMap(t, ts.URL+"/v1/sourcemaps?debug_id="+mapDebugID, uploadToken, smFixture(t, "app.min.js.map"), false); resp.StatusCode != http.StatusCreated {
		t.Fatalf("upload: %d", resp.StatusCode)
	}

	body, _ := json.Marshal(sourcemap.Request{ProjectID: testProject, Stacktrace: string(smFixture(t, "stack-v8.txt")),
		DebugIDs: map[string]string{bundleURL: mapDebugID}})
	post := func(token string) *http.Response {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/symbolicate", bytes.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		return resp
	}
	if resp := post(""); resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("symbolicate without the read token: %d", resp.StatusCode)
	}
	resp := post(readToken)
	var res sourcemap.Result
	json.NewDecoder(resp.Body).Decode(&res)
	if resp.StatusCode != http.StatusOK || res.Status != sourcemap.StatusOK || !strings.Contains(res.Stacktrace, "at totalOf (src/app.ts:10:") {
		t.Fatalf("symbolicate: %d %+v", resp.StatusCode, res)
	}

	// Session detail: the exception carries symbolicated, the raw stack stays.
	var detail struct {
		Timeline []timelineItem `json:"timeline"`
	}
	getJSONAuth(t, ts.URL+"/v1/sessions/"+realSession, &detail, readToken)
	found := false
	for _, it := range detail.Timeline {
		if it.Name != "exception" || it.Attrs["exception_type"] != "RangeError" {
			continue
		}
		found = true
		if it.Symbolicated == nil || it.Symbolicated.Frames[0].Original == nil || it.Symbolicated.Frames[0].Original.File != "src/app.ts" {
			t.Errorf("timeline exception symbolicated = %+v", it.Symbolicated)
		}
		if !strings.Contains(it.Attrs["exception_stacktrace"], "app.min.js:1:64") {
			t.Errorf("raw stack changed: %q", it.Attrs["exception_stacktrace"])
		}
	}
	if !found {
		t.Fatal("no RangeError in the timeline")
	}
	for _, it := range detail.Timeline {
		if it.Name != "exception" && it.Symbolicated != nil {
			t.Errorf("%s has symbolicated", it.Name)
		}
	}

	// Session logs: same field on the exception line.
	var logs logsResponse
	getJSONAuth(t, ts.URL+"/v1/sessions/"+realSession+"/logs", &logs, readToken)
	ok := false
	for _, l := range logs.Logs {
		if l.EventName == "exception" && l.Attrs["exception_type"] == "RangeError" {
			ok = l.Symbolicated != nil && l.Symbolicated.Mapped == 3
		}
	}
	if !ok {
		t.Error("logs: RangeError line without a symbolicated stack")
	}
}

func TestSourceMapsDisabled(t *testing.T) {
	ts, _, _ := newTestServer(t)
	if resp := putMap(t, ts.URL+"/v1/sourcemaps?debug_id="+mapDebugID, uploadToken, []byte("{}"), false); resp.StatusCode != http.StatusNotFound {
		t.Errorf("upload with source maps off: %d", resp.StatusCode)
	}
}

func getJSONAuth(t *testing.T, url string, v any, token string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode %s: %v", url, err)
	}
}
