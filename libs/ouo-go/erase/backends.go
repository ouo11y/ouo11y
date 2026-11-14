package erase

import (
	"context"
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
