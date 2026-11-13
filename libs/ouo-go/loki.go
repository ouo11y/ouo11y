package ouogo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"time"
)

// Loki reads the spec wire from Loki's HTTP API. Attributes come back as labels with "."
// written "_": the deployment promotes a few resource attributes and event.name to stream
// labels and keeps the rest as structured metadata, which Loki merges into the stream
// labels of a query answer.
type Loki struct {
	URL  string // base URL, e.g. http://loki:3100
	HTTP *http.Client
	// OrgID is sent as X-Scope-OrgID when set (Loki with auth_enabled).
	OrgID string
}

// lokiLine is one log line of a query answer.
type lokiLine struct {
	Time   time.Time
	Labels map[string]string
	Body   string
}

type lokiAnswer struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string          `json:"resultType"`
		Result     json.RawMessage `json:"result"`
	} `json:"data"`
	Error string `json:"error"`
}

func (l *Loki) get(ctx context.Context, path string, q url.Values) (*lokiAnswer, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, l.URL+path+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if l.OrgID != "" {
		req.Header.Set("X-Scope-OrgID", l.OrgID)
	}
	resp, err := client(l.HTTP).Do(req)
	if err != nil {
		return nil, &BackendError{Backend: "loki", Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	if err != nil {
		return nil, &BackendError{Backend: "loki", Err: err}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("%s: %s", resp.Status, truncate(string(body), 300))}
	}
	var a lokiAnswer
	if err := json.Unmarshal(body, &a); err != nil {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("decode: %w", err)}
	}
	return &a, nil
}

// queryRange runs a log query and returns its lines, oldest first.
func (l *Loki) queryRange(ctx context.Context, logql string, from, to time.Time, limit int, backward bool) ([]lokiLine, error) {
	dir := "forward"
	if backward {
		dir = "backward"
	}
	q := url.Values{
		"query":     {logql},
		"start":     {strconv.FormatInt(from.UnixNano(), 10)},
		"end":       {strconv.FormatInt(to.UnixNano(), 10)},
		"limit":     {strconv.Itoa(limit)},
		"direction": {dir},
	}
	a, err := l.get(ctx, "/loki/api/v1/query_range", q)
	if err != nil {
		return nil, err
	}
	if a.Data.ResultType != "streams" {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("want streams, got %q", a.Data.ResultType)}
	}
	var streams []struct {
		Stream map[string]string `json:"stream"`
		Values [][2]string       `json:"values"`
	}
	if err := json.Unmarshal(a.Data.Result, &streams); err != nil {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("decode streams: %w", err)}
	}
	var out []lokiLine
	for _, s := range streams {
		for _, v := range s.Values {
			ns, err := strconv.ParseInt(v[0], 10, 64)
			if err != nil {
				continue
			}
			out = append(out, lokiLine{Time: time.Unix(0, ns), Labels: s.Stream, Body: v[1]})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time.Before(out[j].Time) })
	return out, nil
}

// queryVector runs an instant metric query and returns each series' labels.
func (l *Loki) queryVector(ctx context.Context, logql string, at time.Time) ([]map[string]string, error) {
	q := url.Values{"query": {logql}, "time": {strconv.FormatInt(at.UnixNano(), 10)}}
	a, err := l.get(ctx, "/loki/api/v1/query", q)
	if err != nil {
		return nil, err
	}
	if a.Data.ResultType != "vector" {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("want vector, got %q", a.Data.ResultType)}
	}
	var series []struct {
		Metric map[string]string `json:"metric"`
	}
	if err := json.Unmarshal(a.Data.Result, &series); err != nil {
		return nil, &BackendError{Backend: "loki", Err: fmt.Errorf("decode vector: %w", err)}
	}
	labels := make([]map[string]string, 0, len(series))
	for _, s := range series {
		labels = append(labels, s.Metric)
	}
	return labels, nil
}

func client(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return http.DefaultClient
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
