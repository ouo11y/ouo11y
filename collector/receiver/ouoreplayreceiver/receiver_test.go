package ouoreplayreceiver

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componenttest"
	"go.opentelemetry.io/collector/config/configauth"
	"go.opentelemetry.io/collector/config/confighttp"
	"go.opentelemetry.io/collector/config/configoptional"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.opentelemetry.io/collector/consumer/consumertest"
	"go.opentelemetry.io/collector/extension/extensionauth"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/receiver/receivertest"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/ouo11y/ouo11y/collector/receiver/ouoreplayreceiver/internal/metadata"
)

const (
	testProject = "demo"
	testToken   = "pt_dev_demo_0000000000000000"
	testSession = "11111111-2222-3333-4444-555555555555"
)

// tinyJPEG is a base64 JPEG header (FF D8 FF E0 ...), enough for validateFrame.
var tinyJPEG = base64.StdEncoding.EncodeToString([]byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00})

func rrwebChunk(seq int) []byte {
	b, _ := json.Marshal(map[string]any{
		"session_id": testSession, "seq": seq, "started_at": 1760000000000, "ended_at": 1760000005000,
		"events": []any{map[string]any{"type": 4, "data": map[string]any{"href": "http://localhost/"}, "timestamp": 1760000000000}},
	})
	return b
}

func framesChunk(seq int) []byte {
	b, _ := json.Marshal(map[string]any{
		"kind": "frames", "schema_version": 1, "session_id": testSession, "seq": seq,
		"started_at": 1760000000000, "ended_at": 1760000005000, "platform": "ios",
		"viewport": map[string]any{"width": 393, "height": 852, "scale": 0.5},
		"frames":   []any{map[string]any{"ts": 1760000000100, "jpeg": tinyJPEG, "reason": "timer"}},
		"touches":  []any{map[string]any{"ts": 1760000001200, "x": 120.5, "y": 640.0, "phase": "began"}},
		"masked":   true,
	})
	return b
}

func TestConfigValidate(t *testing.T) {
	cfg := createDefaultConfig().(*Config)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("default config invalid: %v", err)
	}
	if cfg.ServerConfig.NetAddr.Endpoint != DefaultEndpoint || cfg.ServerConfig.MaxRequestBodySize != DefaultMaxRequestBodySize || cfg.MaxRRWebChunkBytes != DefaultMaxRRWebChunkBytes {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	bad := createDefaultConfig().(*Config)
	bad.MaxRRWebChunkBytes = bad.ServerConfig.MaxRequestBodySize + 1
	if err := bad.Validate(); err == nil {
		t.Fatal("expected error when rrweb limit exceeds body limit")
	}
	bad = createDefaultConfig().(*Config)
	bad.ServerConfig.NetAddr.Endpoint = ""
	if err := bad.Validate(); err == nil {
		t.Fatal("expected error for empty endpoint")
	}
}

func TestParseChunk(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantErr string
		kind    string
	}{
		{"rrweb", string(rrwebChunk(3)), "", KindRRWeb},
		{"frames", string(framesChunk(0)), "", KindFrames},
		{"not object", `[1,2]`, "JSON object", ""},
		{"bad session", `{"session_id":"../x","seq":0,"events":[]}`, "session_id", ""},
		{"seq range", `{"session_id":"abc","seq":1000000,"events":[]}`, "seq", ""},
		{"events missing", `{"session_id":"abc","seq":0}`, "events missing", ""},
		{"unknown kind", `{"kind":"video","session_id":"abc","seq":0}`, "kind must be", ""},
		{"frames no schema", `{"kind":"frames","session_id":"abc","seq":0,"started_at":1,"ended_at":2,"viewport":{"width":1,"height":1},"frames":[]}`, "schema_version missing", ""},
		{"frames bad jpeg", `{"kind":"frames","schema_version":1,"session_id":"abc","seq":0,"started_at":1,"ended_at":2,"viewport":{"width":1,"height":1},"frames":[{"ts":1,"jpeg":"aGVsbG8="}]}`, "JPEG marker", ""},
		{"touch phase", `{"kind":"frames","schema_version":1,"session_id":"abc","seq":0,"started_at":1,"ended_at":2,"viewport":{"width":1,"height":1},"frames":[],"touches":[{"ts":1,"x":1,"y":1,"phase":"tap"}]}`, "phase", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, err := parseChunk([]byte(tc.body))
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if c.Kind != tc.kind {
					t.Fatalf("kind = %q, want %q", c.Kind, tc.kind)
				}
				return
			}
			if err == nil || !errors.Is(err, errInvalid) || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantErr)
			}
		})
	}
	if peekKind(framesChunk(0)) != KindFrames || peekKind(rrwebChunk(0)) != KindRRWeb || peekKind([]byte("nope")) != KindRRWeb {
		t.Fatal("peekKind mismatch")
	}
}

type fakeAuth struct{ username string }

func (f fakeAuth) GetAttribute(name string) any {
	if name == AuthUsernameAttribute {
		return f.username
	}
	return nil
}
func (f fakeAuth) GetAttributeNames() []string { return []string{AuthUsernameAttribute} }

func authedCtx(project string) context.Context {
	return client.NewContext(context.Background(), client.Info{Auth: fakeAuth{project}})
}

func newTestReceiver(t *testing.T, next consumer.Logs) *replayReceiver {
	t.Helper()
	cfg := createDefaultConfig().(*Config)
	r, err := newReceiver(receivertest.NewNopSettings(metadata.Type), cfg, next)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func do(r *replayReceiver, ctx context.Context, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, DefaultPath, bytes.NewReader(body)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.handleChunk(rec, req)
	return rec
}

func TestHandleChunk(t *testing.T) {
	sink := new(consumertest.LogsSink)
	r := newTestReceiver(t, sink)

	// No auth in context: 401 even though no authenticator is configured.
	if rec := do(r, context.Background(), rrwebChunk(0)); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no auth: status %d body %s", rec.Code, rec.Body)
	}
	// Project id rum-api would refuse.
	if rec := do(r, authedCtx("Bad Project"), rrwebChunk(0)); rec.Code != http.StatusForbidden {
		t.Fatalf("bad project id: status %d body %s", rec.Code, rec.Body)
	}
	// Wrong method.
	req := httptest.NewRequest(http.MethodGet, DefaultPath, nil).WithContext(authedCtx(testProject))
	rec := httptest.NewRecorder()
	r.handleChunk(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: status %d", rec.Code)
	}
	// Invalid chunk.
	if rec := do(r, authedCtx(testProject), []byte(`{"seq":0}`)); rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid: status %d body %s", rec.Code, rec.Body)
	}
	// Valid rrweb chunk.
	body := rrwebChunk(7)
	rec = do(r, authedCtx(testProject), body)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("valid: status %d body %s", rec.Code, rec.Body)
	}
	var resp map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || resp["accepted"] != float64(1) || resp["seq"] != float64(7) {
		t.Fatalf("unexpected response %s (%v)", rec.Body, err)
	}
	if sink.LogRecordCount() != 1 {
		t.Fatalf("sink has %d records", sink.LogRecordCount())
	}
	ld := sink.AllLogs()[0]
	res := ld.ResourceLogs().At(0).Resource().Attributes()
	if v, _ := res.Get(AttrProjectID); v.Str() != testProject {
		t.Fatalf("resource %s = %q", AttrProjectID, v.Str())
	}
	if v, _ := res.Get("service.name"); v.Str() != ResourceServiceName {
		t.Fatalf("service.name = %q", v.Str())
	}
	lr := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0)
	if !bytes.Equal(lr.Body().Bytes().AsRaw(), body) {
		t.Fatal("body bytes differ from chunk")
	}
	attrs := lr.Attributes()
	if v, _ := attrs.Get(AttrSessionID); v.Str() != testSession {
		t.Fatalf("session.id = %q", v.Str())
	}
	if v, _ := attrs.Get(AttrReplaySeq); v.Int() != 7 {
		t.Fatalf("seq = %d", v.Int())
	}
	if v, _ := attrs.Get(AttrReplayKind); v.Str() != KindRRWeb {
		t.Fatalf("kind = %q", v.Str())
	}
	if v, _ := attrs.Get(AttrProjectID); v.Str() != testProject {
		t.Fatalf("record %s = %q", AttrProjectID, v.Str())
	}
	if lr.Timestamp().AsTime().UnixMilli() != 1760000000000 {
		t.Fatalf("timestamp = %v", lr.Timestamp().AsTime())
	}
	// Frames chunk.
	if rec := do(r, authedCtx(testProject), framesChunk(1)); rec.Code != http.StatusAccepted {
		t.Fatalf("frames: status %d body %s", rec.Code, rec.Body)
	}
}

func TestHandleChunkConsumerErrors(t *testing.T) {
	retryInfo := &errdetails.RetryInfo{RetryDelay: durationpb.New(7 * time.Second)}
	st, _ := status.New(codes.ResourceExhausted, "rate limited").WithDetails(retryInfo)
	cases := []struct {
		name       string
		err        error
		status     int
		retryAfter string
	}{
		{"retryable plain", errors.New("queue full"), http.StatusServiceUnavailable, "1"},
		{"permanent", consumererror.NewPermanent(errors.New("bad")), http.StatusInternalServerError, ""},
		{"grpc resource exhausted", st.Err(), http.StatusTooManyRequests, "7"},
		{"grpc unavailable", status.Error(codes.Unavailable, "down"), http.StatusServiceUnavailable, "1"},
		{"grpc invalid", status.Error(codes.InvalidArgument, "nope"), http.StatusBadRequest, ""},
		{"otlp http 429", consumererror.NewOTLPHTTPError(errors.New("x"), http.StatusTooManyRequests), http.StatusTooManyRequests, "1"},
		{"otlp http 409", consumererror.NewOTLPHTTPError(errors.New("x"), http.StatusConflict), http.StatusConflict, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newTestReceiver(t, consumertest.NewErr(tc.err))
			rec := do(r, authedCtx(testProject), rrwebChunk(0))
			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d (body %s)", rec.Code, tc.status, rec.Body)
			}
			if got := rec.Header().Get("Retry-After"); got != tc.retryAfter {
				t.Fatalf("Retry-After %q, want %q", got, tc.retryAfter)
			}
		})
	}
}

// fakeAuthExt is a server authenticator extension: Basic demo:<token>.
type fakeAuthExt struct {
	component.StartFunc
	component.ShutdownFunc
	extensionauth.ServerAuthenticateFunc
}

type extHost struct {
	component.Host
	ext map[component.ID]component.Component
}

func (h extHost) GetExtensions() map[component.ID]component.Component { return h.ext }

func basicAuthenticate(ctx context.Context, sources map[string][]string) (context.Context, error) {
	h := http.Header(sources).Get("Authorization")
	want := "Basic " + base64.StdEncoding.EncodeToString([]byte(testProject+":"+testToken))
	if h != want {
		return ctx, errors.New("invalid credentials")
	}
	ci := client.FromContext(ctx)
	ci.Auth = fakeAuth{testProject}
	return client.NewContext(ctx, ci), nil
}

func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

// TestServer runs the receiver through confighttp: auth, CORS, gzip, limits.
func TestServer(t *testing.T) {
	sink := new(consumertest.LogsSink)
	cfg := createDefaultConfig().(*Config)
	cfg.ServerConfig.NetAddr.Endpoint = freePort(t)
	cfg.ServerConfig.MaxRequestBodySize = 2048
	cfg.MaxRRWebChunkBytes = 1024
	cfg.ServerConfig.IncludeMetadata = true
	authID := component.MustNewIDWithName("basicauth", "server")
	cfg.ServerConfig.Auth = configoptional.Some(confighttp.AuthConfig{Config: configauth.Config{AuthenticatorID: authID}})
	cfg.ServerConfig.CORS = configoptional.Some(confighttp.CORSConfig{
		AllowedOrigins: []string{"http://localhost:*"},
		AllowedHeaders: []string{"Authorization", "Content-Type", "Content-Encoding"},
	})
	r, err := newReceiver(receivertest.NewNopSettings(metadata.Type), cfg, sink)
	if err != nil {
		t.Fatal(err)
	}
	host := extHost{Host: componenttest.NewNopHost(), ext: map[component.ID]component.Component{
		authID: &fakeAuthExt{ServerAuthenticateFunc: basicAuthenticate},
	}}
	if err := r.Start(context.Background(), host); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Shutdown(context.Background()) })
	base := "http://" + cfg.ServerConfig.NetAddr.Endpoint + DefaultPath
	creds := "Basic " + base64.StdEncoding.EncodeToString([]byte(testProject+":"+testToken))

	post := func(body []byte, encoding string, auth bool) *http.Response {
		req, _ := http.NewRequest(http.MethodPost, base, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if encoding != "" {
			req.Header.Set("Content-Encoding", encoding)
		}
		if auth {
			req.Header.Set("Authorization", creds)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	readClose := func(resp *http.Response) string {
		b, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return string(b)
	}
	gz := func(b []byte) []byte {
		var buf bytes.Buffer
		w := gzip.NewWriter(&buf)
		_, _ = w.Write(b)
		_ = w.Close()
		return buf.Bytes()
	}

	// 401 without credentials, JSON body, WWW-Authenticate.
	resp := post(rrwebChunk(0), "", false)
	if body := readClose(resp); resp.StatusCode != http.StatusUnauthorized || !strings.Contains(body, `"error"`) || resp.Header.Get("WWW-Authenticate") == "" {
		t.Fatalf("no auth: %d %s %q", resp.StatusCode, body, resp.Header.Get("WWW-Authenticate"))
	}
	// 202 gzip.
	resp = post(gz(rrwebChunk(1)), "gzip", true)
	if body := readClose(resp); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("gzip: %d %s", resp.StatusCode, body)
	}
	// 202 identity.
	resp = post(rrwebChunk(2), "identity", true)
	if body := readClose(resp); resp.StatusCode != http.StatusAccepted {
		t.Fatalf("identity: %d %s", resp.StatusCode, body)
	}
	// 400 bad gzip.
	resp = post([]byte("not gzip"), "gzip", true)
	if body := readClose(resp); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad gzip: %d %s", resp.StatusCode, body)
	}
	// 413 over max_request_body_size (plain).
	big := []byte(fmt.Sprintf(`{"session_id":"%s","seq":0,"events":[%s]}`, testSession, strings.Repeat(`{"type":3},`, 300)+`{"type":3}`))
	if len(big) <= 2048 {
		t.Fatalf("test body too small: %d", len(big))
	}
	resp = post(big, "", true)
	if body := readClose(resp); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize: %d %s", resp.StatusCode, body)
	}
	// 413 over max_request_body_size after decompression (gzip bomb-ish).
	resp = post(gz(big), "gzip", true)
	if body := readClose(resp); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize gzip: %d %s", resp.StatusCode, body)
	}
	// 413 rrweb above max_rrweb_chunk_bytes but under max_request_body_size.
	mid := []byte(fmt.Sprintf(`{"session_id":"%s","seq":0,"events":[%s]}`, testSession, strings.Repeat(`{"type":3},`, 120)+`{"type":3}`))
	if len(mid) <= 1024 || len(mid) > 2048 {
		t.Fatalf("mid body size %d", len(mid))
	}
	resp = post(mid, "", true)
	if body := readClose(resp); resp.StatusCode != http.StatusRequestEntityTooLarge || !strings.Contains(body, "rrweb chunk larger") {
		t.Fatalf("rrweb oversize: %d %s", resp.StatusCode, body)
	}
	// CORS preflight from an allowed origin.
	req, _ := http.NewRequest(http.MethodOptions, base, nil)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-encoding,content-type")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	readClose(resp)
	if resp.Header.Get("Access-Control-Allow-Origin") != "http://localhost:5173" || !strings.Contains(strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers")), "authorization") {
		t.Fatalf("preflight headers: %v", resp.Header)
	}
	if sink.LogRecordCount() != 2 {
		t.Fatalf("sink has %d records, want 2", sink.LogRecordCount())
	}
	var ld plog.Logs = sink.AllLogs()[0]
	if ld.LogRecordCount() != 1 {
		t.Fatal("expected one record per request")
	}
}
