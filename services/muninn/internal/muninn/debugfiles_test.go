package muninn

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/muninn/internal/config"
	"github.com/ouo11y/ouo11y/services/muninn/internal/store"
)

const (
	upTok   = "ut-shop"
	otherUp = "ut-other"
	dbgID   = "0f1e2d3c-4b5a-4968-8776-655443322110"
)

func withUploadTokens(c *config.Config) {
	c.DebugFiles.UploadTokens = []config.UploadToken{
		{Project: proj, Tenant: "acme", Token: upTok},
		{Project: "other", Tenant: "acme", Token: otherUp},
	}
}

func dbgPath(kind, id, query string) string {
	p := fmt.Sprintf("/api/v1/projects/%s/debug-files/%s/%s", proj, kind, id)
	if query != "" {
		p += "?" + query
	}
	return p
}

func (h *harness) upload(path, token string, body []byte, gzipped bool) (int, string) {
	hdr := map[string]string{"Authorization": "Bearer " + token}
	if gzipped {
		hdr["Content-Encoding"] = "gzip"
	}
	w := h.do("PUT", path, body, hdr)
	return w.Code, w.Body.String()
}

func TestDebugFileUploadWriteOnce(t *testing.T) {
	h := newHarness(t, withUploadTokens)
	m := `{"version":3,"mappings":"AAAA"}`
	q := "release=1.2.0&file=https://shop.example/assets/app.js?v=1"
	if code, body := h.upload(dbgPath("sourcemap", dbgID, q), upTok, gz(m), true); code != 201 {
		t.Fatalf("first upload: %d %s", code, body)
	}
	// Same content, other gzip framing (plain this time): 200, nothing replaced.
	if code, body := h.upload(dbgPath("sourcemap", strings.ToUpper(strings.ReplaceAll(dbgID, "-", "")), q), upTok, []byte(m), false); code != 200 {
		t.Fatalf("repeat: %d %s", code, body)
	}
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, q), upTok, []byte(`{"version":3,"mappings":"BBBB"}`), false); code != 409 {
		t.Fatalf("other content: %d", code)
	}
	w := h.get(dbgPath("sourcemap", dbgID, ""))
	if w.Code != 200 || w.Body.String() != m {
		t.Fatalf("read: %d %q", w.Code, w.Body.String())
	}
	w = h.get(dbgPath("sourcemap", dbgID, ""), map[string]string{"Accept-Encoding": "gzip"})
	if w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip read: %v", w.Header())
	}
	var meta debugMeta
	w = h.get(dbgPath("sourcemap", dbgID, "") + "/meta")
	if err := json.Unmarshal(w.Body.Bytes(), &meta); err != nil || meta.Bytes != int64(len(m)) || meta.File != "/assets/app.js" || meta.Release != "1.2.0" {
		t.Fatalf("meta %d %s %v", w.Code, w.Body.String(), err)
	}
	// Pointer lookup by release and the URL in any spelling of the same path.
	w = h.get(fmt.Sprintf("/api/v1/projects/%s/debug-files/sourcemap?release=1.2.0&file=/assets/./app.js", proj))
	if !strings.Contains(w.Body.String(), `"debug_ids":["`+dbgID+`"]`) {
		t.Fatalf("pointer list: %s", w.Body.String())
	}
	w = h.get(fmt.Sprintf("/api/v1/projects/%s/debug-files/sourcemap?release=9.9.9&file=/assets/app.js", proj))
	if !strings.Contains(w.Body.String(), `"debug_ids":[]`) {
		t.Fatalf("other release: %s", w.Body.String())
	}
	w = h.get(fmt.Sprintf("/api/v1/projects/%s/debug-files/sourcemap", proj))
	if !strings.Contains(w.Body.String(), dbgID) || strings.Contains(w.Body.String(), ".json") {
		t.Fatalf("list: %s", w.Body.String())
	}
}

func TestDebugFileAuth(t *testing.T) {
	h := newHarness(t, withUploadTokens)
	p := dbgPath("sourcemap", dbgID, "")
	for name, tok := range map[string]string{"read token": rdTok, "ingest token": ingTok, "other project": otherUp, "none": ""} {
		if code, _ := h.upload(p, tok, []byte("{}"), false); code != 401 {
			t.Errorf("%s: %d, want 401", name, code)
		}
	}
	// The upload token opens nothing else.
	w := h.do("GET", p, nil, map[string]string{"Authorization": "Bearer " + upTok})
	if w.Code != 401 {
		t.Errorf("upload token read: %d", w.Code)
	}
	w = h.do("DELETE", "/api/v1/projects/"+proj, nil, map[string]string{"Authorization": "Bearer " + upTok})
	if w.Code != 401 {
		t.Errorf("upload token delete: %d", w.Code)
	}
	if code, _ := h.upload(dbgPath("sourcemap", "not-a-uuid", ""), upTok, []byte("{}"), false); code != 400 {
		t.Errorf("bad id: %d", code)
	}
	if code, _ := h.upload(dbgPath("elf", dbgID, ""), upTok, []byte("{}"), false); code != 400 {
		t.Errorf("bad kind: %d", code)
	}
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, "file=/a.js"), upTok, []byte("{}"), false); code != 400 {
		t.Errorf("file without release: %d", code)
	}
	if code, _ := h.upload(p, upTok, nil, false); code != 400 {
		t.Errorf("empty: %d", code)
	}
}

func TestDebugFileTenantFromToken(t *testing.T) {
	h := newHarness(t, withUploadTokens, func(c *config.Config) { c.MultitenancyEnabled = true })
	hdr := map[string]string{"Authorization": "Bearer " + upTok, "X-Scope-OrgID": "evil"}
	if w := h.do("PUT", dbgPath("sourcemap", dbgID, ""), []byte("{}"), hdr); w.Code != 201 {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	if w := h.get(dbgPath("sourcemap", dbgID, ""), map[string]string{"X-Scope-OrgID": "evil"}); w.Code != 404 {
		t.Fatalf("written into the header's tenant: %d", w.Code)
	}
	if w := h.get(dbgPath("sourcemap", dbgID, ""), map[string]string{"X-Scope-OrgID": "acme"}); w.Code != 200 {
		t.Fatalf("token's tenant: %d", w.Code)
	}
}

func TestDebugFileTooLarge(t *testing.T) {
	h := newHarness(t, withUploadTokens, func(c *config.Config) { c.DebugFiles.MaxBytes.Sourcemap = 16 })
	big := strings.Repeat("a", 17)
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, ""), upTok, gz(big), true); code != 413 {
		t.Fatalf("gzip bomb-ish: %d", code)
	}
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, ""), upTok, []byte(big), false); code != 413 {
		t.Fatalf("plain: %d", code)
	}
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, ""), upTok, []byte(strings.Repeat("a", 16)), false); code != 201 {
		t.Fatalf("at the limit: %d", code)
	}
}

func TestDebugFileRace(t *testing.T) {
	h := newHarness(t, withUploadTokens)
	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for codes[i] = 503; codes[i] == 503; { // more than maxUploads at once: retried, as the CLI does
				codes[i], _ = h.upload(dbgPath("dsym", dbgID, ""), upTok, []byte("same"), false)
			}
		}()
	}
	wg.Wait()
	created := 0
	for _, c := range codes {
		switch c {
		case 201:
			created++
		case 200:
		default:
			t.Fatalf("code %d", c)
		}
	}
	if created != 1 {
		t.Fatalf("%d creates", created)
	}
}

func TestDebugFileRetentionAndProjectDelete(t *testing.T) {
	h := newHarness(t, withUploadTokens, func(c *config.Config) {
		c.DebugFiles.Retention.PerProject = map[string]time.Duration{"other": 0}
	})
	q := "release=1&file=/a.js"
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, q), upTok, []byte("{}"), false); code != 201 {
		t.Fatal(code)
	}
	op := fmt.Sprintf("/api/v1/projects/other/debug-files/sourcemap/%s", dbgID)
	if code, _ := h.upload(op, otherUp, []byte("{}"), false); code != 201 {
		t.Fatal(code)
	}
	h.now = time.Now().Add(8759 * time.Hour)
	if err := h.srv.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w := h.get(dbgPath("sourcemap", dbgID, "")); w.Code != 200 {
		t.Fatalf("swept early: %d", w.Code)
	}
	h.now = time.Now().Add(8761 * time.Hour)
	if err := h.srv.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w := h.get(dbgPath("sourcemap", dbgID, "")); w.Code != 404 {
		t.Fatalf("not swept: %d", w.Code)
	}
	if objs, _ := h.st.List(context.Background(), h.srv.keys.debugProject("anonymous", proj)); len(objs) != 0 {
		t.Fatalf("left behind: %v", objs)
	}
	if w := h.get(op); w.Code != 200 {
		t.Fatalf("retention 0 swept: %d", w.Code)
	}
	// Re-upload after retention is allowed.
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, q), upTok, []byte("{}"), false); code != 201 {
		t.Fatalf("re-upload: %d", code)
	}

	// Project delete: replays and debug files.
	h.mustStore(chunk(strm, 0, "rrweb/2", "gzip", gz("a")))
	// The read token never deletes a project (MUN-45).
	if w := h.do("DELETE", "/api/v1/projects/"+proj, nil, map[string]string{"Authorization": "Bearer " + rdTok}); w.Code != 401 {
		t.Fatalf("read token deleted a project: %d", w.Code)
	}
	w := h.do("DELETE", "/api/v1/projects/"+proj, nil, map[string]string{"Authorization": "Bearer " + admTok})
	if w.Code != 200 || w.Body.String() != `{"debug_files":1,"replays":1}`+"\n" {
		t.Fatalf("delete project: %d %s", w.Code, w.Body.String())
	}
	if code, _ := h.manifest(rep); code != 404 {
		t.Fatalf("replay kept: %d", code)
	}
	if w := h.get(dbgPath("sourcemap", dbgID, "")); w.Code != 404 {
		t.Fatalf("debug file kept: %d", w.Code)
	}
	if w := h.get(op); w.Code != 200 {
		t.Fatalf("other project touched: %d", w.Code)
	}
	// Idempotent.
	w = h.do("DELETE", "/api/v1/projects/"+proj, nil, map[string]string{"Authorization": "Bearer " + admTok})
	if w.Code != 200 || w.Body.String() != `{"debug_files":0,"replays":0}`+"\n" {
		t.Fatalf("second delete: %d %s", w.Code, w.Body.String())
	}
}

func TestAuditEntries(t *testing.T) {
	h := newHarness(t)
	put := func(entry, status, body string) int {
		return h.do("PUT", "/api/v1/audit/"+entry+"/"+status, []byte(body), map[string]string{"Authorization": "Bearer " + admTok}).Code
	}
	e1, e2 := "20261114T100000Z-0000aaaa", "20261114T090000Z-0000bbbb"
	if c := put(e1, "started", `{"user":"u1"}`); c != 201 {
		t.Fatal(c)
	}
	if c := put(e1, "started", `{"user":"u1"}`); c != 200 {
		t.Fatal(c)
	}
	if c := put(e1, "started", `{"user":"u2"}`); c != 409 {
		t.Fatal(c)
	}
	if c := put(e1, "completed", `{"ok":true}`); c != 201 {
		t.Fatal(c)
	}
	if c := put(e2, "started", `{}`); c != 201 {
		t.Fatal(c)
	}
	for _, bad := range [][3]string{{"nope", "started", "{}"}, {e1, "deleted", "{}"}, {e2, "failed", "[1]"}, {e2, "failed", "x"}} {
		if c := put(bad[0], bad[1], bad[2]); c != 400 {
			t.Errorf("%v: %d", bad, c)
		}
	}
	for _, tok := range []string{"", rdTok, ingTok} {
		if w := h.do("PUT", "/api/v1/audit/"+e2+"/failed", []byte("{}"), map[string]string{"Authorization": "Bearer " + tok}); w.Code != 401 {
			t.Errorf("token %q put: %d", tok, w.Code)
		}
		if w := h.do("GET", "/api/v1/audit", nil, map[string]string{"Authorization": "Bearer " + tok}); w.Code != 401 {
			t.Errorf("token %q list: %d", tok, w.Code)
		}
	}
	adm := map[string]string{"Authorization": "Bearer " + admTok}
	var out struct {
		Entries []struct {
			Entry, Status string
			Record        json.RawMessage
		}
	}
	w := h.get("/api/v1/audit", adm)
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, e := range out.Entries {
		got = append(got, e.Entry+"/"+e.Status)
	}
	want := []string{e2 + "/started", e1 + "/started", e1 + "/completed"}
	if fmt.Sprint(got) != fmt.Sprint(want) || string(out.Entries[1].Record) != `{"user":"u1"}` {
		t.Fatalf("got %v, want %v (%s)", got, want, w.Body.String())
	}
	w = h.get("/api/v1/audit?entry="+e2, adm)
	if strings.Contains(w.Body.String(), e1) {
		t.Fatalf("entry filter: %s", w.Body.String())
	}
	// The sweeper never touches audit objects.
	h.now = time.Now().Add(100000 * time.Hour)
	if err := h.srv.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w := h.get("/api/v1/audit", adm); !strings.Contains(w.Body.String(), e1) {
		t.Fatal("audit swept")
	}
}

func TestDebugFileUploadCap(t *testing.T) {
	h := newHarness(t, withUploadTokens)
	for range maxUploads {
		h.srv.uploads <- struct{}{}
	}
	w := h.do("PUT", dbgPath("sourcemap", dbgID, ""), []byte("{}"), map[string]string{"Authorization": "Bearer " + upTok})
	if w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Fatalf("over the cap: %d %q", w.Code, w.Header().Get("Retry-After"))
	}
	<-h.srv.uploads
	if code, body := h.upload(dbgPath("sourcemap", dbgID, ""), upTok, []byte("{}"), false); code != 201 {
		t.Fatalf("a slot free: %d %s", code, body)
	}
}

// DBG-20: a re-upload of the same content restarts the file's retention.
func TestDebugFileReuploadRestartsRetention(t *testing.T) {
	dir := t.TempDir()
	st, err := store.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.Auth.ReadToken = rdTok
	withUploadTokens(&cfg)
	h := newHarnessStore(t, cfg, st)
	q := "release=1&file=/a.js"
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, q), upTok, []byte("{}"), false); code != 201 {
		t.Fatal(code)
	}
	// The first upload was 400 days ago; the CI uploads the same map again now.
	fk := filepath.Join(dir, filepath.FromSlash(h.srv.keys.debugFile("anonymous", proj, "sourcemap", dbgID)))
	old := time.Now().Add(-400 * 24 * time.Hour)
	for _, f := range []string{fk, fk + ".json"} {
		if err := os.Chtimes(f, old, old); err != nil {
			t.Fatal(err)
		}
	}
	if code, _ := h.upload(dbgPath("sourcemap", dbgID, q), upTok, []byte("{}"), false); code != 200 {
		t.Fatal(code)
	}
	h.now = time.Now()
	if err := h.srv.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w := h.get(dbgPath("sourcemap", dbgID, "")); w.Code != 200 {
		t.Fatalf("swept after a re-upload: %d", w.Code)
	}
	if w := h.get(fmt.Sprintf("/api/v1/projects/%s/debug-files/sourcemap", proj)); strings.Count(w.Body.String(), "debug_id") != 1 {
		t.Fatalf("list shows .seen: %s", w.Body.String())
	}
	// A year after the re-upload it goes, with its meta, pointer and .seen.
	h.now = time.Now().Add(8761 * time.Hour)
	if err := h.srv.Sweep(context.Background()); err != nil {
		t.Fatal(err)
	}
	if objs, _ := h.st.List(context.Background(), h.srv.keys.debugProject("anonymous", proj)); len(objs) != 0 {
		t.Fatalf("left behind: %v", objs)
	}
}

func TestDeleteProjectCountsLiveReplaysOnly(t *testing.T) {
	h := newHarness(t)
	h.mustStore(chunk(strm, 0, "rrweb/2", "gzip", gz("a")))
	second := chunk(strm, 0, "rrweb/2", "gzip", gz("b"))
	second.attrs["ouo.replay.id"] = sv("dddddddddddddddddddddddddddddddd")
	h.mustStore(second)
	del := fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays/%s", proj, sess, rep)
	if w := h.do("DELETE", del, nil, map[string]string{"Authorization": "Bearer " + rdTok}); w.Code != 204 {
		t.Fatal(w.Code)
	}
	w := h.do("DELETE", "/api/v1/projects/"+proj, nil, map[string]string{"Authorization": "Bearer " + admTok})
	if w.Code != 200 || w.Body.String() != `{"debug_files":0,"replays":1}`+"\n" {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	// The admin token also opens the reads.
	if w := h.get(fmt.Sprintf("/api/v1/projects/%s/sessions/%s/replays", proj, sess), map[string]string{"Authorization": "Bearer " + admTok}); w.Code != 200 {
		t.Fatalf("admin read: %d", w.Code)
	}
}
