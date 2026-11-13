package bff

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/grafana/grafana-plugin-sdk-go/backend"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

const sess = "0123456789abcdef0123456789abcdef"

// call sends a resource request through the same path Grafana uses.
func call(t *testing.T, a *App, user *backend.User, path string) (int, map[string]any) {
	t.Helper()
	return callWith(t, a, user, path, nil)
}

// callWith adds request headers: what Grafana forwards, or what a browser sent.
func callWith(t *testing.T, a *App, user *backend.User, path string, headers map[string][]string) (int, map[string]any) {
	t.Helper()
	var got *backend.CallResourceResponse
	err := a.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: backend.PluginContext{User: user},
		Path:          strings.SplitN(path, "?", 2)[0],
		Method:        http.MethodGet,
		URL:           path,
		Headers:       headers,
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

	a := New(Settings{LokiURL: loki.URL, MuninnURL: muninn.URL},
		mustClearance(t, `{"mode":"roles","roles":{"Viewer":1,"Admin":5}}`), "tok")
	viewer := &backend.User{Login: "v", Role: "Viewer"}
	admin := &backend.User{Login: "a", Role: "Admin"}
	none := &backend.User{Login: "n", Role: "Editor"} // not in the roles map: level 0

	if st, b := call(t, a, viewer, "/v1/me"); st != 200 || b["level"] != 1.0 || b["can"].(map[string]any)["replay"] != false {
		t.Errorf("me viewer: %d %v", st, b)
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
	a := New(Settings{LokiURL: down.URL, MuninnURL: down.URL}, mustClearance(t, `{"mode":"roles","roles":{"Admin":5}}`), "tok")
	admin := &backend.User{Login: "a", Role: "Admin"}
	for _, p := range []string{"/v1/sessions", "/v1/projects/demo/sessions/" + sess + "/replays/" + sess} {
		st, b := call(t, a, admin, p)
		msg, _ := b["error"].(string)
		if st != 502 || strings.Contains(msg, "secret-host") || strings.Contains(msg, down.URL) || !strings.HasSuffix(msg, "could not be read") {
			t.Errorf("%s: %d %q", p, st, msg)
		}
	}
}

// TestGroupsMode: the level comes from the groups of a verified ID token in X-Id-Token,
// and from nothing else: not the login, not the org role, not a token that fails a check.
func TestGroupsMode(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	jwks := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	}))
	defer jwks.Close()
	token := func(k *rsa.PrivateKey, change func(map[string]any), groups ...string) map[string][]string {
		c := map[string]any{"iss": "https://idp.test", "aud": "grafana", "exp": time.Now().Add(time.Minute).Unix(), "groups": groups}
		if change != nil {
			change(c)
		}
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: k}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
		if err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(c)
		jws, _ := signer.Sign(payload)
		tok, _ := jws.CompactSerialize()
		return map[string][]string{"X-Id-Token": {tok}}
	}
	oidc := func() *ouogo.OIDC {
		return &ouogo.OIDC{Issuer: "https://idp.test", Audience: "grafana", JWKSURL: jwks.URL}
	}
	clearance := mustClearance(t, `{"mode":"groups","groups":{"support":1,"engineers":3,"privacy":4},"roles":{"Admin":5}}`)
	a := New(Settings{OIDC: oidc()}, clearance, "tok")
	viewer := &backend.User{Login: "lena", Role: "Viewer"}
	admin := &backend.User{Login: "admin", Role: "Admin"}

	cases := []struct {
		name    string
		user    *backend.User
		headers map[string][]string
		want    float64
	}{
		{"one group", viewer, token(key, nil, "support"), 1},
		{"highest group wins", viewer, token(key, nil, "support", "privacy", "engineers"), 4},
		{"unknown group", viewer, token(key, nil, "finance"), 0},
		{"no token", viewer, nil, 0},
		{"no token, Grafana Admin: the role is not read", admin, nil, 0},
		{"expired token", viewer, token(key, func(c map[string]any) { c["exp"] = time.Now().Add(-time.Hour).Unix() }, "privacy"), 0},
		{"wrong issuer", viewer, token(key, func(c map[string]any) { c["iss"] = "https://evil.test" }, "privacy"), 0},
		{"wrong audience", viewer, token(key, func(c map[string]any) { c["aud"] = "other" }, "privacy"), 0},
		{"bad signature", viewer, token(other, nil, "privacy"), 0},
		{"forged header, no signature", viewer, map[string][]string{"X-Id-Token": {"eyJhbGciOiJub25lIn0.eyJncm91cHMiOlsicHJpdmFjeSJdfQ."}}, 0},
		{"groups in a header of their own", viewer, map[string][]string{"X-Groups": {"privacy"}, "X-Grafana-Groups": {"privacy"}}, 0},
		{"a login that names a group", &backend.User{Login: "privacy", Role: "Viewer"}, nil, 0},
	}
	for _, c := range cases {
		if _, b := callWith(t, a, c.user, "/v1/me", c.headers); b["level"] != c.want || b["mode"] != "groups" {
			t.Errorf("%s: %v, want level %v", c.name, b, c.want)
		}
	}
	// Groups mode without OIDC settings verifies nothing: level 0 even with a good token.
	if _, b := callWith(t, New(Settings{}, clearance, "tok"), viewer, "/v1/me", token(key, nil, "privacy")); b["level"] != 0.0 {
		t.Errorf("no oidc settings: %v", b)
	}
	// Roles mode does not read the token.
	roles := New(Settings{OIDC: oidc()}, mustClearance(t, `{"mode":"roles","roles":{"Viewer":1},"groups":{"privacy":4}}`), "tok")
	if _, b := callWith(t, roles, viewer, "/v1/me", token(key, nil, "privacy")); b["level"] != 1.0 {
		t.Errorf("roles mode with a token: %v", b)
	}
	// No clearance settings at all: level 0 for everyone.
	if st, b := call(t, New(Settings{}, ouogo.ClearanceConfig{}, "tok"), admin, "/v1/me"); st != 200 || b["level"] != 0.0 {
		t.Errorf("no clearance: %d %v", st, b)
	}
}

func TestNewDatasource(t *testing.T) {
	inst, err := NewDatasource(context.Background(), backend.DataSourceInstanceSettings{
		JSONData:                []byte(`{"oauthPassThru":true,"oidc":{"issuer":"i","audience":"a","jwksUrl":"u"}}`),
		DecryptedSecureJSONData: map[string]string{"clearance": `{"mode":"groups","groups":{"g":3}}`},
	})
	if err != nil {
		t.Fatal(err)
	}
	a := inst.(*App)
	if a.oidc == nil || a.oidc.Issuer != "i" || a.clearance.Groups["g"] != ouogo.C3 {
		t.Errorf("got %+v %+v", a.oidc, a.clearance)
	}
	_, err = NewDatasource(context.Background(), backend.DataSourceInstanceSettings{
		DecryptedSecureJSONData: map[string]string{"clearance": `{"mode":"groups","groups":{"secret-group":9}}`},
	})
	if err == nil || strings.Contains(err.Error(), "secret-group") {
		t.Errorf("bad clearance: %v, want an error that does not quote the value", err)
	}
}
