// Package tempo searches Tempo for the traces of a session
// ({ span.session.id = "<id>" }) and builds Grafana Explore deep links.
package tempo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Trace is one trace of a session as exposed by the API.
type Trace struct {
	TraceID     string    `json:"trace_id"`
	RootName    string    `json:"root_name"`
	RootService string    `json:"root_service"`
	Start       time.Time `json:"start"`
	DurationMs  int64     `json:"duration_ms"`
	SpanCount   int       `json:"span_count"`
	HasError    bool      `json:"has_error"`
	GrafanaURL  string    `json:"grafana_url"`
}

// Client queries one Tempo instance.
type Client struct {
	BaseURL string
	HTTP    *http.Client
	// Limit is the per-search trace limit.
	Limit int
	// Links builds Grafana Explore URLs; nil disables them.
	Links *LinkBuilder

	cacheTTL time.Duration
	mu       sync.Mutex
	cache    map[string]cacheEntry
	sem      chan struct{}
}

type cacheEntry struct {
	traces  []Trace
	expires time.Time
}

// New returns a client with a 60 s result cache and `concurrency` parallel
// searches at most.
func New(baseURL string, httpClient *http.Client, concurrency int, cacheTTL time.Duration) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	if concurrency <= 0 {
		concurrency = 8
	}
	return &Client{
		BaseURL:  strings.TrimRight(baseURL, "/"),
		HTTP:     httpClient,
		Limit:    1000,
		cacheTTL: cacheTTL,
		cache:    map[string]cacheEntry{},
		sem:      make(chan struct{}, concurrency),
	}
}

// Ready probes GET /ready.
func (c *Client) Ready(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/ready", nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("tempo /ready: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	return nil
}

// searchResponse is the subset of GET /api/search this package reads.
type searchResponse struct {
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
		} `json:"spanSet"`
	} `json:"traces"`
}

// SessionTraces returns the traces of a session in [start, end]
// (Tempo requires start/end; without them only a tiny recent window is
// searched). Results are cached per session id + range for the cache TTL.
// has_error comes from a second TraceQL query with `&& status = error`.
func (c *Client) SessionTraces(ctx context.Context, sessionID string, start, end time.Time) ([]Trace, error) {
	key := sessionID + "|" + strconv.FormatInt(start.Unix(), 10) + "|" + strconv.FormatInt(end.Unix(), 10)
	if c.cacheTTL > 0 {
		c.mu.Lock()
		e, ok := c.cache[key]
		c.mu.Unlock()
		if ok && time.Now().Before(e.expires) {
			return e.traces, nil
		}
	}

	select {
	case c.sem <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.sem }()

	q := fmt.Sprintf(`{ span.session.id = %s }`, strconv.Quote(sessionID))
	traces, err := c.search(ctx, q, start, end)
	if err != nil {
		return nil, err
	}
	if len(traces) > 0 {
		errQ := fmt.Sprintf(`{ span.session.id = %s && status = error }`, strconv.Quote(sessionID))
		errored, err := c.search(ctx, errQ, start, end)
		if err != nil {
			slog.Warn("tempo error search failed", "session_id", sessionID, "error", err)
		} else {
			ids := map[string]bool{}
			for _, t := range errored {
				ids[t.TraceID] = true
			}
			for i := range traces {
				traces[i].HasError = ids[traces[i].TraceID]
			}
		}
	}
	if c.Links != nil {
		for i := range traces {
			traces[i].GrafanaURL = c.Links.TraceURL(traces[i].TraceID, traces[i].Start, traces[i].DurationMs)
		}
	}
	if c.cacheTTL > 0 {
		c.mu.Lock()
		c.cache[key] = cacheEntry{traces: traces, expires: time.Now().Add(c.cacheTTL)}
		if len(c.cache) > 4096 {
			for k, e := range c.cache {
				if time.Now().After(e.expires) {
					delete(c.cache, k)
				}
			}
		}
		c.mu.Unlock()
	}
	return traces, nil
}

func (c *Client) search(ctx context.Context, q string, start, end time.Time) ([]Trace, error) {
	v := url.Values{}
	v.Set("q", q)
	v.Set("start", strconv.FormatInt(start.Unix(), 10))
	v.Set("end", strconv.FormatInt(end.Unix(), 10))
	v.Set("limit", strconv.Itoa(c.Limit))
	v.Set("spss", "1") // spans per span set: we only need trace-level fields
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/search?"+v.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tempo search: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("tempo read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("tempo search: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var sr searchResponse
	if err := json.Unmarshal(body, &sr); err != nil {
		return nil, fmt.Errorf("tempo decode: %w", err)
	}
	out := make([]Trace, 0, len(sr.Traces))
	for _, t := range sr.Traces {
		ns, _ := strconv.ParseInt(t.StartTimeUnixNano, 10, 64)
		tr := Trace{
			TraceID:     t.TraceID,
			RootName:    t.RootTraceName,
			RootService: t.RootServiceName,
			Start:       time.Unix(0, ns).UTC(),
			DurationMs:  t.DurationMs,
		}
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
	// Newest first.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Start.After(out[j-1].Start); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

// LinkBuilder builds Grafana Explore deep links to a trace in the Tempo
// datasource.
type LinkBuilder struct {
	GrafanaURL    string // e.g. http://localhost:3000
	DatasourceUID string // e.g. tempo
	OrgID         int
}

// TraceURL returns a Grafana 11+/13 Explore URL (schemaVersion=1, panes JSON)
// that opens the trace by id, with the time range padded around the trace.
func (b LinkBuilder) TraceURL(traceID string, start time.Time, durationMs int64) string {
	from := start.Add(-5 * time.Minute)
	to := start.Add(time.Duration(durationMs)*time.Millisecond + 5*time.Minute)
	if start.IsZero() {
		from, to = time.Now().Add(-time.Hour), time.Now()
	}
	pane := map[string]any{
		"datasource": b.DatasourceUID,
		"queries": []map[string]any{{
			"refId":      "A",
			"datasource": map[string]string{"type": "tempo", "uid": b.DatasourceUID},
			"queryType":  "traceql",
			"query":      traceID,
			"limit":      20,
			"tableType":  "traces",
		}},
		"range": map[string]string{
			"from": strconv.FormatInt(from.UnixMilli(), 10),
			"to":   strconv.FormatInt(to.UnixMilli(), 10),
		},
	}
	panes, _ := json.Marshal(map[string]any{"ouo": pane})
	org := b.OrgID
	if org <= 0 {
		org = 1
	}
	v := url.Values{}
	v.Set("schemaVersion", "1")
	v.Set("orgId", strconv.Itoa(org))
	v.Set("panes", string(panes))
	return strings.TrimRight(b.GrafanaURL, "/") + "/explore?" + v.Encode()
}
