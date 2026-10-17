package ouoreplayexporter

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/config/configcompression"
	"go.opentelemetry.io/collector/config/configopaque"
	"go.opentelemetry.io/collector/config/configoptional"
	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.opentelemetry.io/collector/exporter/exporterhelper"
	"go.opentelemetry.io/collector/exporter/exportertest"
	"go.opentelemetry.io/collector/pdata/plog"

	"github.com/ouo11y/ouo11y/collector/exporter/ouoreplayexporter/internal/metadata"
)

func TestConfigValidate(t *testing.T) {
	cfg := createDefaultConfig().(*Config)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default config invalid: %v", err)
	}
	if cfg.ClientConfig.Endpoint != DefaultEndpoint || cfg.ClientConfig.Compression != configcompression.TypeGzip || !cfg.QueueConfig.HasValue() || !cfg.RetryConfig.Enabled {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	for _, bad := range []string{"", "rum-api:8080", "ftp://x", "http://"} {
		c := createDefaultConfig().(*Config)
		c.ClientConfig.Endpoint = bad
		if err := c.Validate(); err == nil {
			t.Fatalf("endpoint %q should be invalid", bad)
		}
	}
}

func record(project, session string, seq int64, body string) plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr(AttrProjectID, project)
	rl.Resource().Attributes().PutStr("service.name", "ouo-replay")
	lr := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	lr.Body().SetEmptyBytes().FromRaw([]byte(body))
	lr.Attributes().PutStr(AttrProjectID, project)
	lr.Attributes().PutStr(AttrSessionID, session)
	lr.Attributes().PutInt(AttrReplaySeq, seq)
	lr.Attributes().PutStr(AttrReplayKind, "rrweb")
	return ld
}

type captured struct {
	headers http.Header
	body    string
}

// newStub is an httptest sink that records requests and answers with the
// status taken from the queue (200 when exhausted).
func newStub(t *testing.T, statuses ...int) (*httptest.Server, *[]captured, *atomic.Int32) {
	t.Helper()
	var got []captured
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var rd io.Reader = r.Body
		if r.Header.Get("Content-Encoding") == "gzip" {
			gz, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Errorf("bad gzip: %v", err)
				w.WriteHeader(400)
				return
			}
			rd = gz
		}
		b, _ := io.ReadAll(rd)
		got = append(got, captured{headers: r.Header.Clone(), body: string(b)})
		i := int(n.Add(1)) - 1
		status := http.StatusAccepted
		if i < len(statuses) {
			status = statuses[i]
		}
		if status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "3")
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"error":"stub"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &got, &n
}

func newTestExporter(t *testing.T, endpoint, token string) *replayExporter {
	t.Helper()
	cfg := createDefaultConfig().(*Config)
	cfg.ClientConfig.Endpoint = endpoint
	cfg.IngestToken = configopaque.String(token)
	e := newExporter(cfg, exportertest.NewNopSettings(metadata.Type))
	if err := e.start(context.Background(), componenttest.NewNopHost()); err != nil {
		t.Fatal(err)
	}
	return e
}

func TestPushLogsHeadersAndBody(t *testing.T) {
	srv, got, _ := newStub(t)
	e := newTestExporter(t, srv.URL+"/", "it_secret")
	body := `{"session_id":"s1","seq":4,"events":[]}`
	if err := e.pushLogs(context.Background(), record("demo", "s1", 4, body)); err != nil {
		t.Fatal(err)
	}
	if len(*got) != 1 {
		t.Fatalf("stub got %d requests", len(*got))
	}
	c := (*got)[0]
	if c.body != body {
		t.Fatalf("body %q", c.body)
	}
	if c.headers.Get(HeaderProjectID) != "demo" || c.headers.Get(HeaderSessionID) != "s1" || c.headers.Get(HeaderSeq) != "4" {
		t.Fatalf("headers %v", c.headers)
	}
	if c.headers.Get("Authorization") != "Bearer it_secret" || c.headers.Get("Content-Type") != "application/json" || c.headers.Get("Content-Encoding") != "gzip" {
		t.Fatalf("headers %v", c.headers)
	}
}

func TestPushLogsNoToken(t *testing.T) {
	srv, got, _ := newStub(t)
	e := newTestExporter(t, srv.URL, "")
	if err := e.pushLogs(context.Background(), record("demo", "s1", 0, `{}`)); err != nil {
		t.Fatal(err)
	}
	if (*got)[0].headers.Get("Authorization") != "" {
		t.Fatal("unexpected Authorization header")
	}
}

func TestPushLogsStatusMapping(t *testing.T) {
	cases := []struct {
		status    int
		permanent bool
		throttle  bool
	}{
		{400, true, false}, {401, true, false}, {403, true, false}, {409, true, false}, {413, true, false},
		{429, false, true}, {500, false, false}, {502, false, false}, {503, false, false},
	}
	for _, tc := range cases {
		srv, _, _ := newStub(t, tc.status)
		e := newTestExporter(t, srv.URL, "")
		err := e.pushLogs(context.Background(), record("demo", "s1", 0, `{}`))
		if err == nil {
			t.Fatalf("%d: expected error", tc.status)
		}
		if consumererror.IsPermanent(err) != tc.permanent {
			t.Fatalf("%d: permanent = %v, want %v (%v)", tc.status, consumererror.IsPermanent(err), tc.permanent, err)
		}
		if tc.throttle {
			// The stub sends Retry-After: 3 with 429 only, so only 429 becomes a throttle error here.
			var terr interface{ Unwrap() error }
			if !errors.As(err, &terr) {
				t.Fatalf("%d: expected a wrapped throttle error, got %T %v", tc.status, err, err)
			}
		}
	}
	// Network error: retryable.
	e := newTestExporter(t, "http://127.0.0.1:1", "")
	e.client.Timeout = 2 * time.Second
	if err := e.pushLogs(context.Background(), record("demo", "s1", 0, `{}`)); err == nil || consumererror.IsPermanent(err) {
		t.Fatalf("network error should be retryable, got %v", err)
	}
	// Missing project id: permanent.
	srv, _, _ := newStub(t)
	e = newTestExporter(t, srv.URL, "")
	ld := record("", "s1", 0, `{}`)
	ld.ResourceLogs().At(0).Resource().Attributes().Remove(AttrProjectID)
	ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes().Remove(AttrProjectID)
	if err := e.pushLogs(context.Background(), ld); err == nil || !consumererror.IsPermanent(err) {
		t.Fatalf("missing project should be permanent, got %v", err)
	}
}

func TestPushLogsPartialRetry(t *testing.T) {
	// Second of three records fails with 503: the error carries the two undelivered records.
	srv, got, _ := newStub(t, 202, 503)
	e := newTestExporter(t, srv.URL, "")
	ld := record("demo", "s1", 0, `{"seq":0}`)
	lrs := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords()
	for i := int64(1); i <= 2; i++ {
		lr := lrs.AppendEmpty()
		lr.Body().SetEmptyBytes().FromRaw([]byte(`{"seq":` + string(rune('0'+i)) + `}`))
		lr.Attributes().PutStr(AttrProjectID, "demo")
		lr.Attributes().PutStr(AttrSessionID, "s1")
		lr.Attributes().PutInt(AttrReplaySeq, i)
	}
	err := e.pushLogs(context.Background(), ld)
	if err == nil || consumererror.IsPermanent(err) {
		t.Fatalf("expected retryable error, got %v", err)
	}
	if len(*got) != 2 {
		t.Fatalf("stub got %d requests, want 2 (stop at first failure)", len(*got))
	}
	var le consumererror.Logs
	if !errors.As(err, &le) {
		t.Fatalf("expected consumererror.Logs, got %T", err)
	}
	if n := le.Data().LogRecordCount(); n != 2 {
		t.Fatalf("retry payload has %d records, want 2", n)
	}
	if v, _ := le.Data().ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes().Get(AttrReplaySeq); v.Int() != 1 {
		t.Fatalf("first retried record seq = %d, want 1", v.Int())
	}
}

func TestFactory(t *testing.T) {
	f := NewFactory()
	if f.Type() != metadata.Type {
		t.Fatalf("type %s", f.Type())
	}
	cfg := f.CreateDefaultConfig().(*Config)
	cfg.QueueConfig = configoptional.None[exporterhelper.QueueBatchConfig]()
	exp, err := f.CreateLogs(context.Background(), exportertest.NewNopSettings(metadata.Type), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := exp.Start(context.Background(), componenttest.NewNopHost()); err != nil {
		t.Fatal(err)
	}
	if err := exp.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
