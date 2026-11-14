package erase

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

const (
	s1 = "11111111111111111111111111111111"
	s2 = "22222222222222222222222222222222"
	s3 = "33333333333333333333333333333333"
)

// fakes holds httptest fakes of Loki, Tempo and Muninn and what they were asked.
type fakes struct {
	mu sync.Mutex
	// Loki: series answered for a query containing the key.
	series      map[string][]map[string]string
	lokiDeletes []string
	lokiFail    bool
	lokiOrg     []string
	// Tempo: trace ids per session.
	traces   map[string][]string
	tempoReq int
	// Muninn: replay byte sizes per project/session.
	replays        map[string][]int64
	muninnDeletes  []string
	project        ouogo.ProjectDeleteCounts
	audit          map[string][]byte
	auditOrder     []string
	failStarted    bool
	conflictStatus string
}

func newFakes() *fakes {
	return &fakes{
		series: map[string][]map[string]string{
			`user_id="u1"`: {
				{"ouo_project_id": "demo", "session_id": s1},
				{"ouo_project_id": "demo", "session_id": s2},
				{"ouo_project_id": "shop", "session_id": s3},
				{"ouo_project_id": "demo", "session_id": "not-a-muninn-id"},
			},
		},
		traces:  map[string][]string{s1: {"t1", "t2"}, s2: {"t2", "t3"}},
		replays: map[string][]int64{"demo/" + s1: {100, 50}, "shop/" + s3: {7}},
		project: ouogo.ProjectDeleteCounts{Replays: 4, DebugFiles: 2},
		audit:   map[string][]byte{},
	}
}

func (f *fakes) loki(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lokiOrg = append(f.lokiOrg, r.Header.Get("X-Scope-OrgID"))
	switch r.URL.Path {
	case "/loki/api/v1/query":
		q := r.URL.Query().Get("query")
		result := []map[string]any{}
		for k, ss := range f.series {
			if !strings.Contains(q, k) {
				continue
			}
			if p := projectOf(q); p != "" {
				for _, s := range ss {
					if s["ouo_project_id"] == p {
						result = append(result, map[string]any{"metric": s, "value": []any{1, "3"}})
					}
				}
				continue
			}
			for _, s := range ss {
				result = append(result, map[string]any{"metric": s, "value": []any{1, "3"}})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "success",
			"data": map[string]any{"resultType": "vector", "result": result}})
	case "/loki/api/v1/delete":
		if r.Method != http.MethodPost {
			http.Error(w, "method", http.StatusMethodNotAllowed)
			return
		}
		if f.lokiFail {
			http.Error(w, "compactor unavailable", http.StatusServiceUnavailable)
			return
		}
		f.lokiDeletes = append(f.lokiDeletes, r.URL.Query().Get("query"))
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}

func projectOf(q string) string {
	const p = `ouo_project_id="`
	i := strings.Index(q, p)
	if i < 0 {
		return ""
	}
	rest := q[i+len(p):]
	return rest[:strings.Index(rest, `"`)]
}

func (f *fakes) tempo(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tempoReq++
	q := r.URL.Query().Get("q")
	type tr struct {
		TraceID string `json:"traceID"`
	}
	out := []tr{}
	for s, ids := range f.traces {
		if strings.Contains(q, s) {
			for _, id := range ids {
				out = append(out, tr{id})
			}
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"traces": out})
}

func (f *fakes) muninn(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("X-Scope-OrgID") != "acme" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/"), "/")
	switch {
	case parts[0] == "audit" && r.Method == http.MethodPut:
		key := parts[1] + "/" + parts[2]
		if f.failStarted && parts[2] == "started" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if parts[2] == f.conflictStatus {
			w.WriteHeader(http.StatusConflict)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if old, ok := f.audit[key]; ok {
			if !bytes.Equal(old, body) {
				w.WriteHeader(http.StatusConflict)
			}
			return
		}
		f.audit[key] = body
		f.auditOrder = append(f.auditOrder, key)
		w.WriteHeader(http.StatusCreated)
	case parts[0] == "audit" && r.Method == http.MethodGet:
		out := []ouogo.AuditRecord{}
		for _, k := range f.auditOrder {
			e, s, _ := strings.Cut(k, "/")
			if want := r.URL.Query().Get("entry"); want == "" || want == e {
				out = append(out, ouogo.AuditRecord{Entry: e, Status: s, Record: f.audit[k]})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"entries": out})
	case parts[0] == "projects" && len(parts) == 2 && r.Method == http.MethodDelete:
		f.muninnDeletes = append(f.muninnDeletes, parts[1])
		_ = json.NewEncoder(w).Encode(f.project)
	case parts[0] == "projects" && len(parts) == 5 && parts[4] == "replays":
		key := parts[1] + "/" + parts[3]
		if r.Method == http.MethodDelete {
			f.muninnDeletes = append(f.muninnDeletes, key)
			delete(f.replays, key)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		list := []ouogo.ReplaySummary{}
		for _, b := range f.replays[key] {
			list = append(list, ouogo.ReplaySummary{ReplayID: strings.Repeat("a", 32), ByteSize: b})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"session_id": parts[3], "replays": list})
	default:
		http.NotFound(w, r)
	}
}

// stored returns the record stored under entry/status.
func (f *fakes) stored(t *testing.T, entry, status string) *Record {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.audit[entry+"/"+status]
	if !ok {
		t.Fatalf("no %s record for %s (have %v)", status, entry, f.auditOrder)
	}
	var r Record
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return &r
}

var now = time.Date(2026, 11, 14, 10, 15, 0, 0, time.UTC)

func newEraser(t *testing.T, f *fakes) *Eraser {
	lk := httptest.NewServer(http.HandlerFunc(f.loki))
	tp := httptest.NewServer(http.HandlerFunc(f.tempo))
	mn := httptest.NewServer(http.HandlerFunc(f.muninn))
	t.Cleanup(func() { lk.Close(); tp.Close(); mn.Close() })
	return &Eraser{
		Loki:       &ouogo.Loki{URL: lk.URL, OrgID: "acme"},
		LokiDelete: true,
		Tempo:      &ouogo.Tempo{URL: tp.URL},
		Muninn:     &ouogo.Muninn{URL: mn.URL, Tenant: "acme", ReadToken: "tok"},
		Now:        func() time.Time { return now },
		Rand:       bytes.NewReader(bytes.Repeat([]byte{0xab}, 64)),
	}
}

const entryID = "20261114T101500Z-abababab"

func TestUserAcrossSessions(t *testing.T) {
	f := newFakes()
	e := newEraser(t, f)
	r, err := e.User(context.Background(), Request{UserID: "u1", Actor: "dpo", Reason: "GDPR-17 #88"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Entry != entryID || r.Status != ouogo.AuditCompleted || r.Action != ActionDeleteUser {
		t.Fatalf("record %+v", r)
	}
	if r.SessionCount != 4 || r.Sessions[0] != "demo/"+s1 {
		t.Fatalf("sessions %d %v", r.SessionCount, r.Sessions)
	}
	if *r.Replays != (Count{Deleted: 3, Bytes: 157}) || r.Muninn.Status != BackendDeleted {
		t.Fatalf("replays %+v muninn %+v", r.Replays, r.Muninn)
	}
	// Every valid session is deleted, across projects; the non-Muninn id is not sent.
	if want := []string{"demo/" + s1, "demo/" + s2, "shop/" + s3}; !reflect.DeepEqual(f.muninnDeletes, want) {
		t.Fatalf("muninn deletes %v", f.muninnDeletes)
	}
	if !reflect.DeepEqual(r.Tempo.TraceIDs, []string{"t1", "t2", "t3"}) || r.Tempo.Status != BackendManual {
		t.Fatalf("tempo %+v", r.Tempo)
	}
	wantQ := `{service_name=~".+"} | ouo_project_id!="" | enduser_id="u1" or user_id="u1"`
	if r.Loki.Status != BackendSubmitted || !reflect.DeepEqual(f.lokiDeletes, []string{wantQ}) {
		t.Fatalf("loki %+v %v", r.Loki, f.lokiDeletes)
	}
	for _, o := range f.lokiOrg {
		if o != "acme" {
			t.Fatalf("loki tenant %q", o)
		}
	}
	// Started first, then completed, under one entry id.
	if want := []string{entryID + "/started", entryID + "/completed"}; !reflect.DeepEqual(f.auditOrder, want) {
		t.Fatalf("audit %v", f.auditOrder)
	}
	if st := f.stored(t, entryID, "started"); st.Status != "started" || st.UserID != "u1" || st.Replays != nil {
		t.Fatalf("started %+v", st)
	}
	if c := f.stored(t, entryID, "completed"); c.Replays.Deleted != 3 || c.Loki.Query != wantQ {
		t.Fatalf("completed %+v", c)
	}
	if r.From == nil || !(r.To.Sub(*r.From) == 720*time.Hour) {
		t.Fatalf("window %v %v", r.From, r.To)
	}
}

func TestUserInProject(t *testing.T) {
	f := newFakes()
	e := newEraser(t, f)
	r, err := e.User(context.Background(), Request{UserID: "u1", Project: "shop", Actor: "dpo"})
	if err != nil {
		t.Fatal(err)
	}
	if r.SessionCount != 1 || !reflect.DeepEqual(f.muninnDeletes, []string{"shop/" + s3}) {
		t.Fatalf("sessions %v deletes %v", r.Sessions, f.muninnDeletes)
	}
	if f.lokiDeletes[0] != `{service_name=~".+"} | ouo_project_id="shop" | enduser_id="u1" or user_id="u1"` {
		t.Fatalf("loki %v", f.lokiDeletes)
	}
}

func TestStartedFailureDeletesNothing(t *testing.T) {
	for _, action := range []string{"user", "project"} {
		f := newFakes()
		f.failStarted = true
		e := newEraser(t, f)
		var err error
		if action == "user" {
			_, err = e.User(context.Background(), Request{UserID: "u1", Actor: "dpo"})
		} else {
			_, err = e.Project(context.Background(), Request{Project: "demo", Actor: "dpo"})
		}
		if !errors.Is(err, ErrAudit) {
			t.Fatalf("%s: err %v", action, err)
		}
		if len(f.muninnDeletes)+len(f.lokiDeletes)+f.tempoReq != 0 || len(f.lokiOrg) != 0 || len(f.auditOrder) != 0 {
			t.Fatalf("%s: touched backends: muninn %v loki %v tempo %d", action, f.muninnDeletes, f.lokiDeletes, f.tempoReq)
		}
	}
}

func TestProject(t *testing.T) {
	f := newFakes()
	e := newEraser(t, f)
	r, err := e.Project(context.Background(), Request{Project: "demo", UserID: "ignored", Actor: "ops"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Status != ouogo.AuditCompleted || r.Action != ActionDeleteProject || r.UserID != "" {
		t.Fatalf("record %+v", r)
	}
	if !reflect.DeepEqual(f.muninnDeletes, []string{"demo"}) || r.Replays.Deleted != 4 || r.DebugFiles.Deleted != 2 {
		t.Fatalf("muninn %v %+v %+v", f.muninnDeletes, r.Replays, r.DebugFiles)
	}
	if r.Tempo.Status != BackendUnsupported || f.tempoReq != 0 {
		t.Fatalf("tempo %+v", r.Tempo)
	}
	if !reflect.DeepEqual(f.lokiDeletes, []string{`{service_name=~".+"} | ouo_project_id="demo"`}) {
		t.Fatalf("loki %v", f.lokiDeletes)
	}
	if got := r.To.Sub(*r.From); got != 744*time.Hour {
		t.Fatalf("loki window %v", got)
	}
	if c := f.stored(t, r.Entry, "completed"); c.DebugFiles.Deleted != 2 {
		t.Fatalf("stored %+v", c)
	}
}

func TestDryRunDeletesNothing(t *testing.T) {
	f := newFakes()
	e := newEraser(t, f)
	r, err := e.User(context.Background(), Request{UserID: "u1", Actor: "dpo", DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if !r.DryRun || r.Replays.Deleted != 3 || r.Muninn.Status != BackendSkipped || r.Loki.Status != BackendSkipped {
		t.Fatalf("user dry run %+v muninn %+v loki %+v", r, r.Muninn, r.Loki)
	}
	if len(r.Tempo.TraceIDs) != 3 {
		t.Fatalf("dry run still lists traces: %+v", r.Tempo)
	}
	e.Rand = bytes.NewReader(bytes.Repeat([]byte{0xcd}, 4))
	p, err := e.Project(context.Background(), Request{Project: "demo", Actor: "ops", DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	if p.Muninn.Status != BackendSkipped || p.Loki.Status != BackendSkipped {
		t.Fatalf("project dry run %+v %+v", p.Muninn, p.Loki)
	}
	if len(f.muninnDeletes) != 0 || len(f.lokiDeletes) != 0 {
		t.Fatalf("dry run deleted: muninn %v loki %v", f.muninnDeletes, f.lokiDeletes)
	}
	// Both dry runs are audited, marked dry_run.
	if len(f.auditOrder) != 4 || !f.stored(t, entryID, "started").DryRun || !f.stored(t, p.Entry, "completed").DryRun {
		t.Fatalf("audit %v", f.auditOrder)
	}
}

func TestLokiFailureKeepsOtherResults(t *testing.T) {
	f := newFakes()
	f.lokiFail = true
	e := newEraser(t, f)
	r, err := e.User(context.Background(), Request{UserID: "u1", Actor: "dpo"})
	if err == nil || !strings.Contains(err.Error(), "loki") {
		t.Fatalf("err %v", err)
	}
	if r.Status != ouogo.AuditFailed || r.Loki.Status != BackendFailed || !strings.Contains(r.Loki.Error, "503") {
		t.Fatalf("record %+v loki %+v", r, r.Loki)
	}
	if r.Muninn.Status != BackendDeleted || r.Replays.Deleted != 3 || r.Tempo.Status != BackendManual {
		t.Fatalf("other backends lost: muninn %+v tempo %+v", r.Muninn, r.Tempo)
	}
	c := f.stored(t, r.Entry, "failed")
	if c.Error == "" || c.Replays.Deleted != 3 || len(c.Tempo.TraceIDs) != 3 {
		t.Fatalf("stored failed record %+v", c)
	}
}

func TestSessionLookupFailure(t *testing.T) {
	f := newFakes()
	e := newEraser(t, f)
	e.Loki.URL += "/broken"
	r, err := e.User(context.Background(), Request{UserID: "u1", Actor: "dpo"})
	if err == nil || r.Status != ouogo.AuditFailed || len(f.muninnDeletes) != 0 || f.tempoReq != 0 {
		t.Fatalf("err %v record %+v deletes %v", err, r, f.muninnDeletes)
	}
	f.stored(t, r.Entry, "failed")
}

func TestAuditConflictSurfaced(t *testing.T) {
	f := newFakes()
	f.conflictStatus = "completed"
	e := newEraser(t, f)
	r, err := e.Project(context.Background(), Request{Project: "demo", Actor: "ops"})
	var conflict *ouogo.AuditConflictError
	if !errors.As(err, &conflict) || conflict.Entry != r.Entry || conflict.Status != "completed" {
		t.Fatalf("err %v", err)
	}
	// The deletion ran; the record says so even though Muninn kept the other bytes.
	if r.Muninn.Status != BackendDeleted {
		t.Fatalf("record %+v", r.Muninn)
	}
	f.failStarted, f.conflictStatus = false, "started"
	e.Rand = bytes.NewReader([]byte{1, 2, 3, 4})
	_, err = e.Project(context.Background(), Request{Project: "demo", Actor: "ops"})
	if !errors.Is(err, ErrAudit) || !errors.As(err, &conflict) {
		t.Fatalf("started conflict: %v", err)
	}
}

func TestFitTruncates(t *testing.T) {
	r := &Record{Entry: entryID, Status: "completed", Tempo: &Backend{Status: BackendManual}}
	for i := 0; i < MaxSessionIDs; i++ {
		r.Sessions = append(r.Sessions, "demo/"+s1)
	}
	for i := 0; i < 2000; i++ {
		r.Tempo.TraceIDs = append(r.Tempo.TraceIDs, s2)
	}
	c := fit(r)
	b, _ := json.Marshal(c)
	if len(b) > ouogo.MaxAuditRecord || !c.Truncated || len(r.Tempo.TraceIDs) != 2000 || len(r.Sessions) != MaxSessionIDs {
		t.Fatalf("fit: %d bytes, truncated %v, original kept %d/%d", len(b), c.Truncated, len(r.Sessions), len(r.Tempo.TraceIDs))
	}
}

func TestNewEntryID(t *testing.T) {
	id, err := NewEntryID(time.Date(2026, 1, 2, 3, 4, 5, 0, time.FixedZone("x", 3600)), bytes.NewReader([]byte{0, 1, 0xfe, 0xff}))
	if err != nil || id != "20260102T020405Z-0001feff" {
		t.Fatalf("%q %v", id, err)
	}
}

func TestValidation(t *testing.T) {
	e := &Eraser{}
	if _, err := e.User(context.Background(), Request{}); err == nil {
		t.Fatal("empty user accepted")
	}
	if _, err := e.User(context.Background(), Request{UserID: "u", Project: "Bad/P"}); err == nil {
		t.Fatal("bad project accepted")
	}
	if _, err := e.Project(context.Background(), Request{Project: ""}); err == nil {
		t.Fatal("empty project accepted")
	}
}

func TestSubjectFilterQuotes(t *testing.T) {
	got := subjectFilter(`a"b\c`, "")
	if got != `{service_name=~".+"} | ouo_project_id!="" | enduser_id="a\"b\\c" or user_id="a\"b\\c"` {
		t.Fatal(got)
	}
}
