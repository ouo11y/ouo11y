package ouogo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Tempo searches a session's traces through Tempo's HTTP API (TraceQL on the span attribute
// session.id, which the SDKs set on every span, SIG-24).
type Tempo struct {
	URL  string // base URL, e.g. http://tempo:3200
	HTTP *http.Client
	// OrgID is sent as X-Scope-OrgID when set (multi-tenant Tempo).
	OrgID string
}

// TraceSummary is one trace of a session, as Tempo's search returns it: no span attributes,
// so every field is timeline-level (c1).
type TraceSummary struct {
	TraceID     string `json:"trace_id"`
	RootService string `json:"root_service"`
	RootName    string `json:"root_name"`
	Start       int64  `json:"start"` // ms since the epoch
	DurationMs  int64  `json:"duration_ms"`
}

// search finds the traces with a span whose session.id is session (a validated 32-hex id).
func (t *Tempo) search(ctx context.Context, session string, from, to time.Time) ([]TraceSummary, error) {
	q := url.Values{
		"q":     {`{ span.session.id = "` + session + `" }`},
		"start": {strconv.FormatInt(from.Unix(), 10)},
		"end":   {strconv.FormatInt(to.Unix()+1, 10)},
		"limit": {"100"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.URL+"/api/search?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if t.OrgID != "" {
		req.Header.Set("X-Scope-OrgID", t.OrgID)
	}
	resp, err := client(t.HTTP).Do(req)
	if err != nil {
		return nil, &BackendError{Backend: "tempo", Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, &BackendError{Backend: "tempo", Err: err}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &BackendError{Backend: "tempo", Err: fmt.Errorf("%s: %s", resp.Status, truncate(string(body), 300))}
	}
	var a struct {
		Traces []struct {
			TraceID           string `json:"traceID"`
			RootServiceName   string `json:"rootServiceName"`
			RootTraceName     string `json:"rootTraceName"`
			StartTimeUnixNano string `json:"startTimeUnixNano"`
			DurationMs        int64  `json:"durationMs"`
		} `json:"traces"`
	}
	if err := json.Unmarshal(body, &a); err != nil {
		return nil, &BackendError{Backend: "tempo", Err: fmt.Errorf("decode: %w", err)}
	}
	out := make([]TraceSummary, 0, len(a.Traces))
	for _, tr := range a.Traces {
		ns, _ := strconv.ParseInt(tr.StartTimeUnixNano, 10, 64)
		out = append(out, TraceSummary{TraceID: tr.TraceID, RootService: tr.RootServiceName, RootName: tr.RootTraceName, Start: ns / 1e6, DurationMs: tr.DurationMs})
	}
	return out, nil
}
