package loki

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// SubjectFilter is the LogQL of everything one user or one project sent:
// every stream (service_name is on all OTLP streams) filtered by
// ouo_project_id and / or the structured metadata user_id. Delete requests
// and the session lookup use the same expression. Without a project it
// still keeps to lines that came through the ouo collector (it stamps
// ouo.project.id on every resource): in a Loki shared with other senders
// (docs/operations/existing-lgtm.md) their own user_id lines stay.
func SubjectFilter(userID, projectID string) string {
	q := `{service_name=~".+"}`
	if projectID != "" {
		q += ` | ouo_project_id=` + quote(projectID)
	} else {
		q += ` | ouo_project_id!=""`
	}
	if userID != "" {
		q += ` | user_id=` + quote(userID)
	}
	return q
}

// sessionWindow is the range of one count_over_time in SessionIDs: a day
// keeps each instant query below Loki's max_query_length and its series
// below max_query_series for any one user.
const sessionWindow = 24 * time.Hour

// SessionIDs returns the distinct session_id values of the lines matching
// query (a log selector with filters) in [start, end], each with the end of
// the newest day window it was seen in (the session's lines lie in the day
// before it, give or take a session's max duration), with one instant
// `sum by (session_id) (count_over_time(...))` per day.
func (c *Client) SessionIDs(ctx context.Context, query string, start, end time.Time) (map[string]time.Time, error) {
	seen := map[string]time.Time{}
	for t := end; t.After(start); t = t.Add(-sessionWindow) {
		w := sessionWindow
		if t.Add(-w).Before(start) {
			w = t.Sub(start)
		}
		w = w.Round(time.Second)
		if w < time.Second {
			break
		}
		metric := fmt.Sprintf(`sum by (session_id) (count_over_time(%s [%ds]))`, query, int64(w/time.Second))
		ids, err := c.instantLabels(ctx, metric, t, "session_id")
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			if _, ok := seen[id]; !ok && id != "" {
				seen[id] = t
			}
		}
	}
	return seen, nil
}

func (c *Client) instantLabels(ctx context.Context, query string, at time.Time, label string) ([]string, error) {
	q := url.Values{}
	q.Set("query", query)
	q.Set("time", strconv.FormatInt(at.UnixNano(), 10))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/loki/api/v1/query?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("loki query: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("loki query: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var r struct {
		Data struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("loki query: %w", err)
	}
	out := make([]string, 0, len(r.Data.Result))
	for _, s := range r.Data.Result {
		out = append(out, s.Metric[label])
	}
	return out, nil
}

// Delete submits a delete request (POST /loki/api/v1/delete, served by the
// compactor). Loki hides matching lines from queries once the request is
// processed and removes them from chunks when the compactor runs; requests
// can be cancelled during compactor.delete_request_cancel_period.
func (c *Client) Delete(ctx context.Context, query string, start, end time.Time) error {
	q := url.Values{}
	q.Set("query", query)
	q.Set("start", strconv.FormatInt(start.Unix(), 10))
	// end+1 covers the lines of end's last (fractional) second, but Loki
	// refuses an end in the future ("deletes in the future are not
	// allowed"), which end+1 is when end is now: clamp it to this second.
	q.Set("end", strconv.FormatInt(min(end.Unix()+1, time.Now().Unix()), 10))
	base := c.BaseURL
	if c.DeleteURL != "" {
		base = strings.TrimRight(c.DeleteURL, "/")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/loki/api/v1/delete?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
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
