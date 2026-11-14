package ouogo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Tempo reads a session's traces from Tempo's search API ({ span.session.id = "<id>" }).
// Ported from rum-api's internal/tempo and GET /v1/sessions/{id}/traces.
type Tempo struct {
	URL  string       // base URL, e.g. http://tempo:3200
	HTTP *http.Client // nil: a client with a 30 second timeout
	// OrgID is sent as X-Scope-OrgID when set (Tempo with multitenancy).
	OrgID string
	// Token is sent as a bearer token when set (Tempo behind an authenticating proxy).
	Token string
	// Limit is the traces one search returns (default 1000).
	Limit int
	// Now is the clock for default time ranges; time.Now when nil.
	Now func() time.Time
}

// Trace is one trace of a session.
type Trace struct {
	TraceID     string    `json:"trace_id"`
	RootName    string    `json:"root_name"`
	RootService string    `json:"root_service"`
	Start       time.Time `json:"start"`
	DurationMs  int64     `json:"duration_ms"`
	SpanCount   int       `json:"span_count"`
	HasError    bool      `json:"has_error"`
	// RootURLPath is the root span's url.path when the root has a generic HTTP client
	// name ("HTTP GET", as the ouo SDKs name fetches); empty otherwise.
	RootURLPath string `json:"root_url_path,omitempty"`
}

// genericHTTPName matches root span names that carry no route: the HTTP semantic
// conventions' fallback "HTTP {method}" and a bare method.
var genericHTTPName = regexp.MustCompile(`^(HTTP )?[A-Z]+$`)

// TraceWindow is the range to search a session's traces in: its records' span widened
// by 2 minutes on each side, so spans exported slightly before the first record or after
// the last are found, rounded to whole minutes.
func TraceWindow(s Session) TimeRange {
	start := time.UnixMilli(s.Start).Add(-2 * time.Minute).Truncate(time.Minute)
	end := time.UnixMilli(s.End).Add(2 * time.Minute).Truncate(time.Minute).Add(time.Minute)
	return TimeRange{From: start, To: end}
}

type tempoSearch struct {
	Traces []struct {
		TraceID           string `json:"traceID"`
		RootServiceName   string `json:"rootServiceName"`
		RootTraceName     string `json:"rootTraceName"`
		StartTimeUnixNano string `json:"startTimeUnixNano"`
		DurationMs        int64  `json:"durationMs"`
		ServiceStats      map[string]struct {
			SpanCount  int `json:"spanCount"`
			ErrorCount int `json:"errorCount"`
		} `json:"serviceStats"`
		SpanSet *struct {
			Matched int `json:"matched"`
			Spans   []struct {
				Attributes []struct {
					Key   string `json:"key"`
					Value struct {
						StringValue string `json:"stringValue"`
					} `json:"value"`
				} `json:"attributes"`
			} `json:"spans"`
		} `json:"spanSet"`
	} `json:"traces"`
}

func (t *Tempo) search(ctx context.Context, traceql string, from, to time.Time) (*tempoSearch, error) {
	q := url.Values{
		"q":     {traceql},
		"start": {strconv.FormatInt(from.Unix(), 10)},
		"end":   {strconv.FormatInt(to.Unix(), 10)},
		"limit": {strconv.Itoa(orDefault(t.Limit, 1000))},
		"spss":  {"1"}, // spans per span set: only trace-level fields are read
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(t.URL, "/")+"/api/search?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if t.OrgID != "" {
		req.Header.Set("X-Scope-OrgID", t.OrgID)
	}
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	resp, err := httpClient(t.HTTP).Do(req)
	if err != nil {
		return nil, &BackendError{Backend: "tempo", Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, &BackendError{Backend: "tempo", Err: err}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &BackendError{Backend: "tempo", Err: fmt.Errorf("%s: %s", resp.Status, truncate(string(body), 300))}
	}
	var sr tempoSearch
	if err := json.Unmarshal(body, &sr); err != nil {
		return nil, &BackendError{Backend: "tempo", Err: fmt.Errorf("decode: %w", err)}
	}
	return &sr, nil
}

func tracesOf(sr *tempoSearch) []Trace {
	out := make([]Trace, 0, len(sr.Traces))
	for _, t := range sr.Traces {
		ns, _ := strconv.ParseInt(t.StartTimeUnixNano, 10, 64)
		tr := Trace{TraceID: t.TraceID, RootName: t.RootTraceName, RootService: t.RootServiceName, Start: time.Unix(0, ns).UTC(), DurationMs: t.DurationMs}
		for _, s := range t.ServiceStats {
			tr.SpanCount += s.SpanCount
			if s.ErrorCount > 0 {
				tr.HasError = true
			}
		}
		if tr.SpanCount == 0 && t.SpanSet != nil {
			tr.SpanCount = t.SpanSet.Matched
		}
		out = append(out, tr)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start.After(out[j].Start) })
	return out
}

// TraceIDs returns the ids of the traces with a span of the session in the range, in
// Tempo's order, never nil: one search, no root names or errors. ouo-erase lists them
// before a deletion, because Tempo cannot delete by attribute.
func (t *Tempo) TraceIDs(ctx context.Context, session string, r TimeRange) ([]string, error) {
	if err := checkID("session", session); err != nil {
		return nil, err
	}
	from, to, err := r.window(t.Now)
	if err != nil {
		return nil, err
	}
	sr, err := t.search(ctx, `{ span.session.id = "`+session+`" }`, from, to)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(sr.Traces))
	for _, tr := range sr.Traces {
		if tr.TraceID != "" {
			ids = append(ids, tr.TraceID)
		}
	}
	return ids, nil
}

// SessionTraces returns the traces with a span of the session in the range, newest
// first, never nil. TraceWindow(session) is the range rum-api searched. HasError also
// comes from a second search with `&& status = error`, and RootURLPath from a third for
// generic HTTP root names; both are best effort: when they fail, the traces are still
// answered without them. The search is by session id alone, across projects: a caller that
// scopes by project checks the session's project first (Loki.SessionEvents).
func (t *Tempo) SessionTraces(ctx context.Context, session string, r TimeRange) ([]Trace, error) {
	if err := checkID("session", session); err != nil {
		return nil, err
	}
	from, to, err := r.window(t.Now)
	if err != nil {
		return nil, err
	}
	sel := `span.session.id = "` + session + `"`
	sr, err := t.search(ctx, "{ "+sel+" }", from, to)
	if err != nil {
		return nil, err
	}
	traces := tracesOf(sr)
	if len(traces) == 0 {
		return traces, nil
	}
	if errSr, err := t.search(ctx, "{ "+sel+" && status = error }", from, to); err == nil {
		ids := map[string]bool{}
		for _, e := range errSr.Traces {
			ids[e.TraceID] = true
		}
		for i := range traces {
			traces[i].HasError = traces[i].HasError || ids[traces[i].TraceID]
		}
	}
	t.addRootPaths(ctx, sel, from, to, traces)
	return traces, nil
}

func (t *Tempo) addRootPaths(ctx context.Context, sel string, from, to time.Time, traces []Trace) {
	generic := false
	for _, tr := range traces {
		generic = generic || genericHTTPName.MatchString(tr.RootName)
	}
	if !generic {
		return
	}
	sr, err := t.search(ctx, "{ "+sel+" && nestedSetParent < 0 } | select(span.url.path, span.url.full)", from, to)
	if err != nil {
		return
	}
	paths := map[string]string{}
	for _, tr := range sr.Traces {
		if tr.SpanSet == nil {
			continue
		}
		var path, full string
		for _, sp := range tr.SpanSet.Spans {
			for _, a := range sp.Attributes {
				v := a.Value.StringValue
				if v == "" || v == "nil" { // Tempo answers "nil" for a selected attribute the span lacks
					continue
				}
				switch a.Key {
				case "url.path":
					path = v
				case "url.full":
					full = v
				}
			}
		}
		if path == "" && full != "" {
			if u, err := url.Parse(full); err == nil {
				path = u.Path
			}
		}
		if path != "" {
			paths[tr.TraceID] = path
		}
	}
	for i := range traces {
		if genericHTTPName.MatchString(traces[i].RootName) {
			traces[i].RootURLPath = paths[traces[i].TraceID]
		}
	}
}
