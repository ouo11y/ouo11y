package bff

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

const sess = "0123456789abcdef0123456789abcdef"

// call sends a resource request through the same path Grafana uses.
func call(t *testing.T, a *App, user *backend.User, path string) (int, map[string]any) {
	t.Helper()
	var got *backend.CallResourceResponse
	err := a.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{User: user},
		Path:          strings.SplitN(path, "?", 2)[0],
		Method:        http.MethodGet,
		URL:           path,
	}, backend.CallResourceResponseSenderFunc(func(r *backend.CallResourceResponse) error { got = r; return nil }))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	_ = json.Unmarshal(got.Body, &body)
	return got.Status, body
}

func TestClearanceAtTheEndpoints(t *testing.T) {
	loki := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/loki/api/v1/query" {
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"ouo_project_id":"demo","session_id":"` + sess + `","event_name":"session.start","enduser_id":"u-1","browser_document_url_full":"https://x/"},"values":[["1794400000000000000",""]]}]}}`))
	}))
	defer loki.Close()
	muninnCalls := 0
	muninn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		muninnCalls++
		_, _ = w.Write([]byte(`{"replays":[]}`))
	}))
	defer muninn.Close()

	a := New(Settings{LokiURL: loki.URL, MuninnURL: muninn.URL,
		Clearance: mustClearance(t, `{"roles":{"Viewer":1,"Admin":5},"users":{"cleared":4}}`)}, "tok")
	viewer := &backend.User{Login: "v", Role: "Viewer"}
	admin := &backend.User{Login: "a", Role: "Admin"}
	none := &backend.User{Login: "n", Role: "Editor"} // not in the roles map: level 0

	if st, b := call(t, a, viewer, "/v1/me"); st != 200 || b["level"] != 1.0 || b["can"].(map[string]any)["replay"] != false {
		t.Errorf("me viewer: %d %v", st, b)
	}
	if _, b := call(t, a, &backend.User{Login: "cleared", Role: "Viewer"}, "/v1/me"); b["level"] != 4.0 {
		t.Errorf("me user override: %v", b)
	}
	if st, _ := call(t, a, none, "/v1/sessions"); st != 403 {
		t.Errorf("level 0 list: %d, want 403", st)
	}
	if st, _ := call(t, a, nil, "/v1/sessions"); st != 403 {
		t.Errorf("no user: %d, want 403", st)
	}

	st, b := call(t, a, viewer, "/v1/sessions?from=1794399000000&to=1794401000000")
	s := b["sessions"].([]any)[0].(map[string]any)
	if st != 200 || s["user"] != nil {
		t.Errorf("viewer list: %d %v", st, b)
	}
	st, b = call(t, a, viewer, "/v1/projects/demo/sessions/"+sess)
	ev := b["events"].([]any)[0].(map[string]any)
	if st != 200 || ev["attributes"] != nil || b["replays"] != nil || muninnCalls != 0 {
		t.Errorf("viewer session: %d %v (muninn calls %d)", st, b, muninnCalls)
	}
	for _, p := range []string{
		"/v1/projects/demo/sessions/" + sess + "/replays/" + sess,
		"/v1/projects/demo/sessions/" + sess + "/replays/" + sess + "/streams/" + sess + "/chunks/0",
	} {
		if st, _ := call(t, a, viewer, p); st != 403 {
			t.Errorf("viewer %s: %d, want 403", p, st)
		}
	}
	if muninnCalls != 0 {
		t.Errorf("Muninn called for a viewer")
	}

	st, b = call(t, a, admin, "/v1/projects/demo/sessions/"+sess)
	ev = b["events"].([]any)[0].(map[string]any)
	attrs, _ := ev["attributes"].(map[string]any)
	if st != 200 || attrs["enduser_id"] != "u-1" || b["session"].(map[string]any)["user"] != "u-1" || b["replays"] == nil {
		t.Errorf("admin session: %d %v", st, b)
	}

	for p, want := range map[string]int{
		"/v1/projects/demo/sessions/nothex":                                    400,
		"/v1/sessions?from=abc":                                                400,
		"/v1/projects/demo/sessions/" + sess + "/replays/x/streams/y/chunks/z": 400,
	} {
		if st, _ := call(t, a, admin, p); st != want {
			t.Errorf("%s: %d, want %d", p, st, want)
		}
	}
}

func mustClearance(t *testing.T, s string) ouogo.ClearanceConfig {
	t.Helper()
	var c ouogo.ClearanceConfig
	if err := json.Unmarshal([]byte(s), &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestBackendErrorsStayInTheLog(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "internal detail http://secret-host:9000", http.StatusInternalServerError)
	}))
	defer down.Close()
	a := New(Settings{LokiURL: down.URL, MuninnURL: down.URL}, "tok")
	admin := &backend.User{Login: "a", Role: "Admin"}
	for _, p := range []string{"/v1/sessions", "/v1/projects/demo/sessions/" + sess + "/replays/" + sess} {
		st, b := call(t, a, admin, p)
		msg, _ := b["error"].(string)
		if st != 502 || strings.Contains(msg, "secret-host") || strings.Contains(msg, down.URL) || !strings.HasSuffix(msg, "could not be read") {
			t.Errorf("%s: %d %q", p, st, msg)
		}
	}
}
