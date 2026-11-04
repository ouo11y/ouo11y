// Package loki is a minimal client for Loki's /loki/api/v1/query_range
// endpoint that pages through results and returns flattened session events.
package loki

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
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// Client queries one Loki instance.
type Client struct {
	BaseURL string
	// DeleteURL is the base of POST /loki/api/v1/delete (the compactor)
	// when it differs from BaseURL; empty: BaseURL.
	DeleteURL string
	HTTP      *http.Client
	// PageLimit is the per-request limit (Loki's max_entries_limit_per_query
	// defaults to 5000). Pagination moves start forward when a page is full.
	PageLimit int
	// MaxPages bounds the number of pages fetched for one query.
	MaxPages int
}

// New returns a client with sane defaults.
func New(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: httpClient, PageLimit: 5000, MaxPages: 20}
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
		return fmt.Errorf("loki /ready: %s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	return nil
}

// Filters narrow the session-event query. Platform and Service are stream
// labels; Version, User and SessionID are structured metadata filters.
type Filters struct {
	Platform  string
	Service   string
	Version   string
	User      string
	SessionID string
	// EventNames restricts event_name (regex alternatives). Empty means ".+".
	EventNames []string
}

// Query builds the LogQL for the filters.
func (f Filters) Query() string {
	sel := []string{`service_name=~".+"`}
	if f.Service != "" {
		sel[0] = `service_name=` + quote(f.Service)
	}
	if len(f.EventNames) > 0 {
		sel = append(sel, `event_name=~`+quote(strings.Join(f.EventNames, "|")))
	} else {
		sel = append(sel, `event_name=~".+"`)
	}
	if f.Platform != "" {
		sel = append(sel, `ouo_platform=`+quote(f.Platform))
	}
	q := "{" + strings.Join(sel, ", ") + "}"
	if f.SessionID != "" {
		q += ` | session_id=` + quote(f.SessionID)
	}
	if f.Version != "" {
		q += ` | service_version=` + quote(f.Version)
	}
	if f.User != "" {
		q += ` | user_id=` + quote(f.User)
	}
	return q
}

func quote(s string) string { return strconv.Quote(s) }

// Events runs the query over [start, end] in forward direction, following
// pages until a page is not full, and returns de-duplicated events sorted by
// time.
func (c *Client) Events(ctx context.Context, f Filters, start, end time.Time) ([]session.Event, error) {
	return c.EventsQuery(ctx, f.Query(), start, end)
}

// EventsQuery is Events with a raw LogQL query.
func (c *Client) EventsQuery(ctx context.Context, query string, start, end time.Time) ([]session.Event, error) {
	evs, _, err := c.EventsQueryCapped(ctx, query, start, end)
	return evs, err
}

// EventsQueryCapped is EventsQuery that also reports whether the read was cut
// at PageLimit × MaxPages events: the last page was full and no page was
// left, so events after the last one returned were not read.
func (c *Client) EventsQueryCapped(ctx context.Context, query string, start, end time.Time) ([]session.Event, bool, error) {
	var all []session.Event
	truncated := false
	seen := map[string]bool{}
	cursor := start
	for page := 0; page < c.MaxPages; page++ {
		evs, err := c.page(ctx, query, cursor, end)
		if err != nil {
			return nil, false, err
		}
		for _, ev := range evs {
			k := ev.Key()
			if seen[k] {
				continue
			}
			seen[k] = true
			all = append(all, ev)
		}
		if len(evs) < c.PageLimit {
			break
		}
		if page == c.MaxPages-1 {
			truncated = true
			break
		}
		// Page was full: continue from the last timestamp (inclusive, so
		// entries sharing that nanosecond are not lost; the seen set removes
		// the duplicates).
		last := evs[len(evs)-1].TS
		if !last.After(cursor) {
			last = cursor.Add(time.Nanosecond)
		}
		cursor = last
		slog.Debug("loki page full, continuing", "query", query, "from", cursor)
	}
	session.SortEvents(all)
	return all, truncated, nil
}

func (c *Client) page(ctx context.Context, query string, start, end time.Time) ([]session.Event, error) {
	q := url.Values{}
	q.Set("query", query)
	q.Set("start", strconv.FormatInt(start.UnixNano(), 10))
	q.Set("end", strconv.FormatInt(end.UnixNano(), 10))
	q.Set("limit", strconv.Itoa(c.PageLimit))
	q.Set("direction", "forward")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/loki/api/v1/query_range?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("loki query: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, fmt.Errorf("loki read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("loki query_range: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return session.ParseLokiResponse(body)
}

// Counts runs `sum by (<by>) (count_over_time(<query> [<range>]))` as an
// instant query at end and returns the count per value of `by` (entries
// without the label are dropped).
func (c *Client) Counts(ctx context.Context, query, by string, start, end time.Time) (map[string]int, error) {
	secs := max(int64(end.Sub(start).Seconds()), 1)
	q := url.Values{}
	q.Set("query", fmt.Sprintf("sum by (%s) (count_over_time(%s [%ds]))", by, query, secs))
	q.Set("time", strconv.FormatInt(end.UnixNano(), 10))
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
		return nil, fmt.Errorf("loki read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("loki query: %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return parseCounts(body, by)
}

func parseCounts(body []byte, by string) (map[string]int, error) {
	var r struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return nil, fmt.Errorf("decode loki response: %w", err)
	}
	if r.Status != "success" {
		return nil, fmt.Errorf("loki status %q", r.Status)
	}
	out := map[string]int{}
	for _, s := range r.Data.Result {
		k := s.Metric[by]
		v, _ := s.Value[1].(string)
		n, err := strconv.ParseFloat(v, 64)
		if k == "" || err != nil {
			continue
		}
		out[k] += int(n)
	}
	return out, nil
}

// ReadLimit is the most events one EventsQuery returns: PageLimit × MaxPages.
func (c *Client) ReadLimit() int { return c.PageLimit * c.MaxPages }
