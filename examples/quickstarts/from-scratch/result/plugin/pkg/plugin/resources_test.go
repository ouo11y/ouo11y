package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// A fake Loki that answers one session of user alice, the way Loki answers a query_range.
func fakeLoki(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/query") { // the "has replay" hint: none
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[{"stream":{
			"ouo_project_id":"demo","session_id":"0123456789abcdef0123456789abcdef",
			"service_name":"tiny-shop-web","event_name":"session.start","enduser_id":"alice"},
			"values":[["1794699403167000000",""]]}]}}`))
	}))
}

func call(t *testing.T, app *App, role, path string) (int, string) {
	t.Helper()
	var status int
	var body []byte
	err := app.CallResource(
		context.Background(),
		&backend.CallResourceRequest{
			PluginContext: backend.PluginContext{User: &backend.User{Login: "u", Role: role}}, // what Grafana sends
			Method:        http.MethodGet, Path: path, URL: path,
		},
		backend.CallResourceResponseSenderFunc(func(res *backend.CallResourceResponse) error {
			status, body = res.Status, res.Body
			return nil
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	return status, string(body)
}

func newApp(t *testing.T, lokiURL string) *App {
	t.Helper()
	jsonData, _ := json.Marshal(Settings{LokiURL: lokiURL, MuninnURL: "http://muninn.invalid"})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatal(err)
	}
	return inst.(*App)
}

func TestSessionsShowTheUserToEditorsOnly(t *testing.T) {
	loki := fakeLoki(t)
	defer loki.Close()
	app := newApp(t, loki.URL)

	status, body := call(t, app, "Editor", "sessions")
	if status != http.StatusOK || !strings.Contains(body, `"user":"alice"`) {
		t.Fatalf("editor: %d %s", status, body)
	}
	status, body = call(t, app, "Viewer", "sessions")
	if status != http.StatusOK || strings.Contains(body, "alice") {
		t.Fatalf("viewer: %d %s", status, body)
	}
}

func TestBadIdsNeverReachTheStores(t *testing.T) {
	app := newApp(t, "http://loki.invalid")
	if status, _ := call(t, app, "Admin", "sessions/demo/not-a-session-id"); status != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", status)
	}
}
