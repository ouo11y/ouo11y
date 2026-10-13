// Command sentrytap records Sentry SDK traffic for the Sentry bridge
// (ADR-0008, docs/specs/sentry-bridge.md section 14).
//
// Three modes:
//
//	sentrytap -listen :4400 -dir caps/A -forward http://localhost:4342   record, then forward raw bytes and record the response
//	sentrytap -listen :4401 -dir caps/B -sink                            record and answer like Sentry (200 {"id":...})
//	sentrytap compare caps/A caps/B                                      prove B received exactly what A saw
//
// The sink can impersonate Sentry's throttling: -status 429 -rate-limits "60::organization" -retry-after 60.
//
// Each request is stored as <dir>/<NNNNNN>/request.json (method, path, raw
// query, headers, body length and sha256), body.bin (raw bytes as received,
// still compressed when the client compressed them) and response.json.
// Standard library only.
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type recordedRequest struct {
	Seq        int64               `json:"seq"`
	Time       time.Time           `json:"time"`
	Method     string              `json:"method"`
	Path       string              `json:"path"`
	RawQuery   string              `json:"raw_query"`
	Header     map[string][]string `json:"header"`
	BodyLen    int                 `json:"body_len"`
	BodySHA256 string              `json:"body_sha256"`
}

type recordedResponse struct {
	Status     int                 `json:"status"`
	Header     map[string][]string `json:"header"`
	Body       string              `json:"body"`
	DurationMS float64             `json:"duration_ms"`
	Error      string              `json:"error,omitempty"`
}

type tap struct {
	dir        string
	forward    string
	sink       bool
	status     int
	rateLimits string
	retryAfter string
	client     *http.Client
	seq        atomic.Int64
	mu         sync.Mutex
}

// hopHeaders are not forwarded (RFC 9110 section 7.6.1) and not compared.
var hopHeaders = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Connection": true, "Te": true,
	"Trailer": true, "Transfer-Encoding": true, "Upgrade": true,
	"Proxy-Authenticate": true, "Proxy-Authorization": true,
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "compare" {
		os.Exit(compare(os.Args[2:]))
	}
	listen := flag.String("listen", ":4400", "listen address")
	dir := flag.String("dir", "captures", "capture directory")
	forward := flag.String("forward", "", "forward to this base URL (scheme://host:port), keeping path and query")
	sink := flag.Bool("sink", false, "answer requests like Sentry instead of forwarding")
	status := flag.Int("status", 200, "sink: status code to answer")
	rateLimits := flag.String("rate-limits", "", "sink: X-Sentry-Rate-Limits header value")
	retryAfter := flag.String("retry-after", "", "sink: Retry-After header value")
	flag.Parse()
	if (*forward == "") == !*sink {
		log.Fatal("exactly one of -forward or -sink is required")
	}
	if err := os.MkdirAll(*dir, 0o755); err != nil {
		log.Fatal(err)
	}
	t := &tap{dir: *dir, forward: strings.TrimRight(*forward, "/"), sink: *sink, status: *status,
		rateLimits: *rateLimits, retryAfter: *retryAfter,
		client: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	// Continue numbering after an existing capture so restarts do not overwrite.
	if entries, err := os.ReadDir(*dir); err == nil {
		t.seq.Store(int64(len(entries)))
	}
	log.Printf("sentrytap listening on %s, dir %s, %s", *listen, *dir, map[bool]string{true: "sink", false: "forward " + t.forward}[t.sink])
	log.Fatal(http.ListenAndServe(*listen, t))
}

func (t *tap) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	seq := t.seq.Add(1)
	sum := sha256.Sum256(body)
	req := recordedRequest{Seq: seq, Time: start.UTC(), Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery,
		Header: cleanHeader(r.Header), BodyLen: len(body), BodySHA256: hex.EncodeToString(sum[:])}
	reqDir := filepath.Join(t.dir, fmt.Sprintf("%06d", seq))
	t.write(reqDir, "request.json", mustJSON(req))
	t.write(reqDir, "body.bin", body)

	var resp recordedResponse
	if t.sink {
		resp = t.answer(w, body)
	} else {
		resp = t.proxy(w, r, body)
	}
	resp.DurationMS = float64(time.Since(start).Microseconds()) / 1000
	t.write(reqDir, "response.json", mustJSON(resp))
	log.Printf("#%d %s %s?%s %dB -> %d (%.1f ms)", seq, r.Method, r.URL.Path, r.URL.RawQuery, len(body), resp.Status, resp.DurationMS)
}

func (t *tap) answer(w http.ResponseWriter, body []byte) recordedResponse {
	h := w.Header()
	h.Set("Content-Type", "application/json")
	if t.rateLimits != "" {
		h.Set("X-Sentry-Rate-Limits", t.rateLimits)
	}
	if t.retryAfter != "" {
		h.Set("Retry-After", t.retryAfter)
	}
	out := fmt.Sprintf(`{"id":%q}`, envelopeEventID(body))
	if t.status >= 400 {
		out = `{"detail":"sentrytap sink configured to fail"}`
	}
	w.WriteHeader(t.status)
	_, _ = w.Write([]byte(out))
	return recordedResponse{Status: t.status, Header: cleanHeader(h), Body: out}
}

func (t *tap) proxy(w http.ResponseWriter, r *http.Request, body []byte) recordedResponse {
	url := t.forward + r.URL.Path
	if r.URL.RawQuery != "" {
		url += "?" + r.URL.RawQuery
	}
	out, err := http.NewRequestWithContext(r.Context(), r.Method, url, bytes.NewReader(body))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return recordedResponse{Status: http.StatusBadGateway, Error: err.Error()}
	}
	for k, vs := range r.Header {
		if !hopHeaders[k] {
			out.Header[k] = vs
		}
	}
	out.Host = r.Host
	// Go would add its own Accept-Encoding and transparently gunzip the reply,
	// which hides what the upstream really sent; ask for exactly what the client asked for.
	if r.Header.Get("Accept-Encoding") == "" {
		out.Header.Set("Accept-Encoding", "identity")
	}
	resp, err := t.client.Do(out)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return recordedResponse{Status: http.StatusBadGateway, Error: err.Error()}
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	for k, vs := range resp.Header {
		if !hopHeaders[k] {
			w.Header()[k] = vs
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(rb)
	return recordedResponse{Status: resp.StatusCode, Header: cleanHeader(resp.Header), Body: string(rb)}
}

func (t *tap) write(dir, name string, b []byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Print(err)
		return
	}
	if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
		log.Print(err)
	}
}

func cleanHeader(h http.Header) map[string][]string {
	out := map[string][]string{}
	for k, vs := range h {
		if !hopHeaders[k] {
			out[k] = append([]string(nil), vs...)
		}
	}
	return out
}

func mustJSON(v any) []byte {
	b, _ := json.MarshalIndent(v, "", "  ")
	return b
}

// envelopeEventID returns the envelope header event_id, or a random one, so
// the sink answers like Sentry ({"id": "..."}). Compressed bodies get a random id.
func envelopeEventID(body []byte) string {
	line, _, _ := bytes.Cut(body, []byte("\n"))
	var hdr struct {
		EventID string `json:"event_id"`
	}
	if json.Unmarshal(line, &hdr) == nil && hdr.EventID != "" {
		return hdr.EventID
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---- compare ---------------------------------------------------------------

type capture struct {
	req  recordedRequest
	resp recordedResponse
	dir  string
}

func load(dir string) ([]capture, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []capture
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		var c capture
		c.dir = filepath.Join(dir, e.Name())
		b, err := os.ReadFile(filepath.Join(c.dir, "request.json"))
		if err != nil {
			continue
		}
		if err := json.Unmarshal(b, &c.req); err != nil {
			return nil, fmt.Errorf("%s: %w", c.dir, err)
		}
		if b, err := os.ReadFile(filepath.Join(c.dir, "response.json")); err == nil {
			_ = json.Unmarshal(b, &c.resp)
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].req.Seq < out[j].req.Seq })
	return out, nil
}

// comparedHeaders are the request headers Sentry's ingest reads; they must
// arrive unchanged. X-Forwarded-For is expected to be added by the bridge.
var comparedHeaders = []string{"Content-Type", "Content-Encoding", "Content-Length", "X-Sentry-Auth", "User-Agent", "Authorization"}

// comparedRespHeaders are the response headers the SDK acts on.
var comparedRespHeaders = []string{"X-Sentry-Rate-Limits", "Retry-After", "Content-Type"}

// compare checks that every request in A (what the SDK sent, seen before the
// bridge) reached B (what the upstream received) with the same method, path,
// query, Sentry-relevant headers and body bytes, and that the response A
// returned to the SDK is the one B answered. Exit 0 when everything matches.
func compare(args []string) int {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: sentrytap compare <dir A: before bridge> <dir B: upstream>")
		return 2
	}
	a, err := load(args[0])
	if err == nil && len(a) == 0 {
		err = errors.New("no requests in " + args[0])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	b, err := load(args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	byKey := map[string][]capture{}
	for _, c := range b {
		k := c.req.Method + " " + c.req.Path + "?" + c.req.RawQuery + " " + c.req.BodySHA256
		byKey[k] = append(byKey[k], c)
	}
	problems := 0
	matched := 0
	for _, ca := range a {
		k := ca.req.Method + " " + ca.req.Path + "?" + ca.req.RawQuery + " " + ca.req.BodySHA256
		list := byKey[k]
		if len(list) == 0 {
			fmt.Printf("MISSING  A#%d %s %s (%d B, sha256 %s…) never reached the upstream byte-identical\n", ca.req.Seq, ca.req.Method, ca.req.Path, ca.req.BodyLen, ca.req.BodySHA256[:12])
			problems++
			continue
		}
		cb := list[0]
		byKey[k] = list[1:]
		matched++
		for _, h := range comparedHeaders {
			va, vb := strings.Join(ca.req.Header[h], ","), strings.Join(cb.req.Header[h], ",")
			if va != vb {
				fmt.Printf("HEADER   A#%d vs B#%d %s: %q != %q\n", ca.req.Seq, cb.req.Seq, h, va, vb)
				problems++
			}
		}
		if ca.resp.Status != cb.resp.Status || ca.resp.Body != cb.resp.Body {
			fmt.Printf("RESPONSE A#%d vs B#%d: SDK got %d %q, upstream answered %d %q\n", ca.req.Seq, cb.req.Seq, ca.resp.Status, ca.resp.Body, cb.resp.Status, cb.resp.Body)
			problems++
		}
		for _, h := range comparedRespHeaders {
			va, vb := strings.Join(ca.resp.Header[h], ","), strings.Join(cb.resp.Header[h], ",")
			if va != vb {
				fmt.Printf("RESPHDR  A#%d vs B#%d %s: %q != %q\n", ca.req.Seq, cb.req.Seq, h, va, vb)
				problems++
			}
		}
	}
	extra := 0
	for _, l := range byKey {
		extra += len(l)
	}
	fmt.Printf("requests before bridge: %d, at upstream: %d, matched byte-identical: %d, extra at upstream: %d, problems: %d\n", len(a), len(b), matched, extra, problems)
	if problems > 0 || extra > 0 {
		return 1
	}
	return 0
}
