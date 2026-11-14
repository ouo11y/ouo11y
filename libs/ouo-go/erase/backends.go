package erase

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// subjectFilter is the LogQL of everything one user or one project sent: every stream
// (service_name is on all OTLP streams) filtered by ouo_project_id and, for a user, the
// structured metadata enduser_id (browser SDK) or user_id (React Native SDK, Sentry
// bridge). The session lookup and the Loki delete request use the same expression.
// Without a project it keeps to lines that came through the ouo collector (it stamps
// ouo.project.id on every resource), so in a Loki shared with other senders their own
// user_id lines stay.
func subjectFilter(userID, project string) string {
	q := `{service_name=~".+"}`
	if project != "" {
		q += ` | ouo_project_id=` + strconv.Quote(project)
	} else {
		q += ` | ouo_project_id!=""`
	}
	if userID != "" {
		u := strconv.Quote(userID)
		q += ` | enduser_id=` + u + ` or user_id=` + u
	}
	return q
}

// sessionWindow is the range of one count_over_time in sessions: a day keeps each instant
// query below Loki's max_query_length and its series below max_query_series for one user.
const sessionWindow = 24 * time.Hour

// sessionRef is a session found in Loki: its project and the end of the newest day window
// it was seen in (its lines lie in the day before, give or take a session's duration).
type sessionRef struct {
	Project, ID string
	Seen        time.Time
}

// sessions returns the distinct (project, session) pairs of the lines matching query in
// [start, end], one instant `sum by (ouo_project_id, session_id) (count_over_time(...))`
// per day, newest day first. Sorted by project, then session.
func sessions(ctx context.Context, l *ouogo.Loki, query string, start, end time.Time) ([]sessionRef, error) {
	seen := map[[2]string]time.Time{}
	for t := end; t.After(start); t = t.Add(-sessionWindow) {
		w := sessionWindow
		if t.Add(-w).Before(start) {
			w = t.Sub(start)
		}
		w = w.Round(time.Second)
		if w < time.Second {
			break
		}
		metric := fmt.Sprintf(`sum by (ouo_project_id, session_id) (count_over_time(%s [%ds]))`, query, int64(w/time.Second))
		series, err := l.QueryVector(ctx, metric, t)
		if err != nil {
			return nil, err
		}
		for _, m := range series {
			k := [2]string{m["ouo_project_id"], m["session_id"]}
			if _, ok := seen[k]; !ok && k[1] != "" {
				seen[k] = t
			}
		}
	}
	out := make([]sessionRef, 0, len(seen))
	for k, t := range seen {
		out = append(out, sessionRef{Project: k[0], ID: k[1], Seen: t})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Project != out[j].Project {
			return out[i].Project < out[j].Project
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// lokiDelete submits a delete request (POST /loki/api/v1/delete, served by the compactor)
// to base, with l's tenant and HTTP client. Loki hides matching lines once the request is
// processed and removes them from chunks when the compactor runs.
func lokiDelete(ctx context.Context, l *ouogo.Loki, base, query string, start, end, now time.Time) error {
	q := url.Values{}
	q.Set("query", query)
	q.Set("start", strconv.FormatInt(start.Unix(), 10))
	// end+1 covers the lines of end's last (fractional) second, but Loki refuses an end in
	// the future ("deletes in the future are not allowed"): clamp it to this second.
	q.Set("end", strconv.FormatInt(min(end.Unix()+1, now.Unix()), 10))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/loki/api/v1/delete?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	if l.OrgID != "" {
		req.Header.Set("X-Scope-OrgID", l.OrgID)
	}
	resp, err := client(l.HTTP).Do(req)
	if err != nil {
		return fmt.Errorf("loki delete: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("loki delete: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	return nil
}

var defaultHTTP = &http.Client{Timeout: 30 * time.Second}

func client(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return defaultHTTP
}

// Tempo finds a session's trace ids (TraceQL `{ span.session.id = "<id>" }` on
// GET /api/search). Tempo has no delete API: the ids go into the audit record for
// `tempo-cli redact`, or expire with the trace retention.
type Tempo struct {
	URL   string // base URL, e.g. http://tempo:3200
	OrgID string // X-Scope-OrgID when set
	Token string // bearer when set
	HTTP  *http.Client
	// Limit is the per-search trace limit (default 1000).
	Limit int
}

// TraceIDs returns the ids of the traces with a span of the session in [start, end].
func (t *Tempo) TraceIDs(ctx context.Context, session string, start, end time.Time) ([]string, error) {
	limit := t.Limit
	if limit <= 0 {
		limit = 1000
	}
	v := url.Values{}
	v.Set("q", fmt.Sprintf(`{ span.session.id = %s }`, strconv.Quote(session)))
	v.Set("start", strconv.FormatInt(start.Unix(), 10))
	v.Set("end", strconv.FormatInt(end.Unix(), 10))
	v.Set("limit", strconv.Itoa(limit))
	v.Set("spss", "1")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(t.URL, "/")+"/api/search?"+v.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if t.OrgID != "" {
		req.Header.Set("X-Scope-OrgID", t.OrgID)
	}
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	resp, err := client(t.HTTP).Do(req)
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
	var sr struct {
		Traces []struct {
			TraceID string `json:"traceID"`
		} `json:"traces"`
	}
	if err := json.Unmarshal(body, &sr); err != nil {
		return nil, fmt.Errorf("tempo decode: %w", err)
	}
	ids := make([]string, 0, len(sr.Traces))
	for _, tr := range sr.Traces {
		if tr.TraceID != "" {
			ids = append(ids, tr.TraceID)
		}
	}
	return ids, nil
}
