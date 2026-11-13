package ouogo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The overview (ADR-0025): session health, sessions over time, top errors, web and mobile vitals
// from Loki, and the backend's request rate, errors and latency from Mimir (Tempo's span
// metrics). Every number is an aggregate, visible from c1; error messages and types are
// attributes (c2 in the error's project).

// OverviewQuery filters GetOverview.
type OverviewQuery struct {
	TimeRange
	Project  string // empty: every project the caller sees
	Platform string // empty: every platform
	// Buckets is the number of points of SessionsOverTime (default 48).
	Buckets int
}

// HealthRow is the session health of one project and platform (or of everything, Totals).
type HealthRow struct {
	Project  string `json:"project,omitempty"`
	Platform string `json:"platform,omitempty"`
	Sessions int    `json:"sessions"`
	// Errored: sessions with at least one exception; Crashed: with a fatal one (or app.crash).
	Errored int `json:"errored"`
	Crashed int `json:"crashed"`
	// Health is the share of sessions with no error or crash, CrashFree with no crash (percent).
	Health    float64 `json:"health"`
	CrashFree float64 `json:"crash_free"`
}

// TimeSeries is one line of a chart: points of [ms since the epoch, value].
type TimeSeries struct {
	Platform string       `json:"platform"`
	Points   [][2]float64 `json:"points"`
}

// TopError is one error group, by fingerprint (else type and message).
type TopError struct {
	Fingerprint string   `json:"fingerprint"`
	Project     string   `json:"project"`
	Platforms   []string `json:"platforms"`
	Count       int      `json:"count"`
	Sessions    int      `json:"sessions"`
	Fatal       bool     `json:"fatal"`
	LastSeen    int64    `json:"last_seen"`
	// Type and Message are attributes: empty below c2 in the project.
	Type    string `json:"type,omitempty"`
	Message string `json:"message,omitempty"`
	// Session is the latest session with this error, for a link to its timeline and replay.
	Session string `json:"session"`
}

// Vital is the p75 of one measurement over the range.
type Vital struct {
	Platform string  `json:"platform"`
	Name     string  `json:"name"`
	Unit     string  `json:"unit"`
	P75      float64 `json:"p75"`
	Count    int     `json:"count"`
}

// ServiceStat is one backend service over the range (server spans).
type ServiceStat struct {
	Service    string   `json:"service"`
	RatePerSec float64  `json:"rate_per_sec"`
	ErrorPct   float64  `json:"error_pct"`
	P95Ms      *float64 `json:"p95_ms"`
}

// Overview is the answer of GetOverview.
type Overview struct {
	From             int64        `json:"from"`
	To               int64        `json:"to"`
	Totals           HealthRow    `json:"totals"`
	Health           []HealthRow  `json:"health"`
	StepMs           int64        `json:"step_ms"`
	SessionsOverTime []TimeSeries `json:"sessions_over_time"`
	TopErrors        []TopError   `json:"top_errors"`
	WebVitals        []Vital      `json:"web_vitals"`
	MobileVitals     []Vital      `json:"mobile_vitals"`
	// Backend comes from Mimir; nil without Mimir or below c1 in the org.
	Backend      []ServiceStat `json:"backend"`
	BackendError string        `json:"backend_error,omitempty"`
	BackendErr   error         `json:"-"`
	Truncated    bool          `json:"truncated"`
	Redacted     []string      `json:"redacted"`
}

// GetOverview computes the overview. Two Loki reads (session starts and errors; vitals) and,
// with Mimir, three PromQL queries. Sessions are those that started in the range.
func (c *Client) GetOverview(ctx context.Context, cl Clearance, q OverviewQuery) (*Overview, error) {
	if !cl.Max().Can().Timeline {
		return nil, ErrForbidden
	}
	from, to, err := c.window(q.TimeRange)
	if err != nil {
		return nil, err
	}
	sel := `ouo_project_id=~".+"`
	if q.Project != "" {
		if err := checkProject(q.Project); err != nil {
			return nil, err
		}
		sel = `ouo_project_id="` + q.Project + `"`
	}
	if q.Platform != "" {
		if err := checkProject(q.Platform); err != nil {
			return nil, &BadRequestError{Msg: "platform must match ^[a-z0-9][a-z0-9._-]{0,63}$"}
		}
	}
	limit := orDefault(c.FunnelLimit, 5000)
	// The platform filter runs here, not in LogQL: web records carry no ouo_platform (PlatformOf).
	visible := func(l lokiLine) bool {
		return cl.For(l.Labels["ouo_project_id"]).Can().Timeline && (q.Platform == "" || PlatformOf(l.Labels) == q.Platform)
	}

	sessLines, err := c.Loki.queryRange(ctx, `{`+sel+`, event_name=~"session[.]start|exception|app[.]crash"} | session_id != ""`, from, to, limit, true)
	if err != nil {
		return nil, err
	}
	vitalLines, err := c.Loki.queryRange(ctx, `{`+sel+`, event_name=~"browser[.]web_vital|ouo[.]app[.]start|ouo[.]screen[.]display|app[.]jank"}`, from, to, limit, true)
	if err != nil {
		return nil, err
	}
	out := &Overview{From: from.UnixMilli(), To: to.UnixMilli(), Truncated: len(sessLines) >= limit || len(vitalLines) >= limit}

	buckets := orDefault(q.Buckets, 48)
	step := max(to.Sub(from)/time.Duration(buckets), time.Second)
	out.StepMs = step.Milliseconds()

	type sessKey struct{ project, platform, id string }
	started := map[sessKey]bool{}
	errored, crashed := map[sessKey]bool{}, map[sessKey]bool{}
	overTime := map[string][]float64{}
	groups := map[string]*TopError{}
	groupSessions := map[string]map[string]bool{}
	redacted := map[string]bool{}
	for _, l := range sessLines {
		if !visible(l) {
			continue
		}
		lb := l.Labels
		k := sessKey{lb["ouo_project_id"], PlatformOf(lb), lb["session_id"]}
		switch lb["event_name"] {
		case "session.start":
			started[k] = true
			if overTime[k.platform] == nil {
				overTime[k.platform] = make([]float64, buckets)
			}
			overTime[k.platform][min(int(l.Time.Sub(from)/step), buckets-1)]++
			continue
		}
		fatal := lb["event_name"] == "app.crash" || lb["ouo_exception_fatal"] == "true"
		errored[k] = true
		if fatal {
			crashed[k] = true
		}
		fp := lb["ouo_exception_fingerprint"]
		if fp == "" {
			fp = lb["exception_type"] + ": " + lb["exception_message"]
		}
		gk := k.project + "\x00" + fp
		g := groups[gk]
		if g == nil {
			g = &TopError{Fingerprint: fp, Project: k.project}
			pc := cl.For(k.project)
			if pc.Can().Attributes {
				g.Type, g.Message = lb["exception_type"], truncate(lb["exception_message"], 300)
			} else {
				redacted[GroupAttributes] = true
				if lb["ouo_exception_fingerprint"] == "" {
					g.Fingerprint = shortHash(fp) // type and message are attributes
				}
			}
			groups[gk] = g
			groupSessions[gk] = map[string]bool{}
		}
		g.Count++
		g.Fatal = g.Fatal || fatal
		if ms := l.Time.UnixMilli(); ms >= g.LastSeen {
			g.LastSeen, g.Session = ms, k.id
		}
		if !containsStr(g.Platforms, k.platform) {
			g.Platforms = append(g.Platforms, k.platform)
		}
		groupSessions[gk][k.id] = true
	}

	rows := map[[2]string]*HealthRow{}
	for k := range started {
		r := rows[[2]string{k.project, k.platform}]
		if r == nil {
			r = &HealthRow{Project: k.project, Platform: k.platform}
			rows[[2]string{k.project, k.platform}] = r
		}
		r.Sessions++
		out.Totals.Sessions++
		if errored[k] {
			r.Errored++
			out.Totals.Errored++
		}
		if crashed[k] {
			r.Crashed++
			out.Totals.Crashed++
		}
	}
	out.Health = []HealthRow{}
	for _, r := range rows {
		r.Health, r.CrashFree = pct(r.Sessions-r.Errored, r.Sessions), pct(r.Sessions-r.Crashed, r.Sessions)
		out.Health = append(out.Health, *r)
	}
	out.Totals.Health = pct(out.Totals.Sessions-out.Totals.Errored, out.Totals.Sessions)
	out.Totals.CrashFree = pct(out.Totals.Sessions-out.Totals.Crashed, out.Totals.Sessions)
	sort.Slice(out.Health, func(i, j int) bool {
		a, b := out.Health[i], out.Health[j]
		if a.Project != b.Project {
			return a.Project < b.Project
		}
		return a.Platform < b.Platform
	})

	out.SessionsOverTime = []TimeSeries{}
	for p, counts := range overTime {
		ts := TimeSeries{Platform: p}
		for i, n := range counts {
			ts.Points = append(ts.Points, [2]float64{float64(from.Add(time.Duration(i) * step).UnixMilli()), n})
		}
		out.SessionsOverTime = append(out.SessionsOverTime, ts)
	}
	sort.Slice(out.SessionsOverTime, func(i, j int) bool { return out.SessionsOverTime[i].Platform < out.SessionsOverTime[j].Platform })

	out.TopErrors = []TopError{}
	for gk, g := range groups {
		g.Sessions = len(groupSessions[gk])
		sort.Strings(g.Platforms)
		out.TopErrors = append(out.TopErrors, *g)
	}
	sort.Slice(out.TopErrors, func(i, j int) bool {
		a, b := out.TopErrors[i], out.TopErrors[j]
		if a.Sessions != b.Sessions {
			return a.Sessions > b.Sessions
		}
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.Fingerprint < b.Fingerprint
	})
	if len(out.TopErrors) > 10 {
		out.TopErrors = out.TopErrors[:10]
	}

	out.WebVitals, out.MobileVitals = vitalsOf(vitalLines, visible)

	if c.Mimir != nil && cl.Can().Timeline {
		out.Backend, out.BackendErr = c.Mimir.services(ctx, from, to)
		if out.BackendErr != nil {
			out.Backend, out.BackendError = nil, "backend metrics could not be read"
		}
	}
	out.Redacted = []string{}
	if redacted[GroupAttributes] {
		out.Redacted = append(out.Redacted, GroupAttributes)
	}
	return out, nil
}

// vitalsOf computes the p75 of each vital per platform. Frame rates are ratios over the range:
// slow and frozen frames per hundred frames drawn.
func vitalsOf(lines []lokiLine, visible func(lokiLine) bool) (web, mobile []Vital) {
	samples := map[[3]string][]float64{} // platform, name, unit
	frames := map[string]*[3]float64{}   // platform -> total, slow, frozen
	num := func(l lokiLine, k string) (float64, bool) {
		v, err := strconv.ParseFloat(l.Labels[k], 64)
		return v, err == nil && !math.IsNaN(v) && !math.IsInf(v, 0)
	}
	for _, l := range lines {
		if !visible(l) {
			continue
		}
		p := PlatformOf(l.Labels)
		switch l.Labels["event_name"] {
		case "browser.web_vital":
			name := strings.ToLower(l.Labels["browser_web_vital_name"])
			if v, ok := num(l, "browser_web_vital_value"); ok && name != "" {
				unit := "ms"
				if name == "cls" {
					unit = ""
				}
				samples[[3]string{p, name, unit}] = append(samples[[3]string{p, name, unit}], v)
			}
		case "ouo.app.start":
			if v, ok := num(l, "ouo_app_start_duration_ms"); ok {
				name := "app_start_" + orStr(l.Labels["ouo_app_start_type"], "cold")
				samples[[3]string{p, name, "ms"}] = append(samples[[3]string{p, name, "ms"}], v)
			}
		case "ouo.screen.display":
			if v, ok := num(l, "ouo_screen_ttid_ms"); ok {
				samples[[3]string{p, "ttid", "ms"}] = append(samples[[3]string{p, "ttid", "ms"}], v)
			}
		case "app.jank":
			f := frames[p]
			if f == nil {
				f = &[3]float64{}
				frames[p] = f
			}
			t, _ := num(l, "ouo_frames_total")
			s, _ := num(l, "ouo_frames_slow")
			z, _ := num(l, "ouo_frames_frozen")
			f[0], f[1], f[2] = f[0]+t, f[1]+s, f[2]+z
		}
	}
	web, mobile = []Vital{}, []Vital{}
	for k, v := range samples {
		sort.Float64s(v)
		rank := min(max(int(0.75*float64(len(v))+0.999999999), 1), len(v))
		vt := Vital{Platform: k[0], Name: k[1], Unit: k[2], P75: math.Round(v[rank-1]*1000) / 1000, Count: len(v)}
		if strings.HasPrefix(k[1], "app_start") || k[1] == "ttid" {
			mobile = append(mobile, vt)
		} else {
			web = append(web, vt)
		}
	}
	for p, f := range frames {
		if f[0] <= 0 {
			continue
		}
		mobile = append(mobile,
			Vital{Platform: p, Name: "slow_frames", Unit: "%", P75: math.Round(f[1]*10000/f[0]) / 100, Count: int(f[0])},
			Vital{Platform: p, Name: "frozen_frames", Unit: "%", P75: math.Round(f[2]*10000/f[0]) / 100, Count: int(f[0])})
	}
	for _, vs := range [][]Vital{web, mobile} {
		sort.Slice(vs, func(i, j int) bool {
			if vs[i].Platform != vs[j].Platform {
				return vs[i].Platform < vs[j].Platform
			}
			return vs[i].Name < vs[j].Name
		})
	}
	return web, mobile
}

func orStr(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func containsStr(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// shortHash names an error group without its type and message (FNV-1a, 8 hex characters).
func shortHash(s string) string {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return fmt.Sprintf("%08x", h)
}

// Mimir reads metrics through the Prometheus HTTP API (Mimir's /prometheus prefix included in URL).
type Mimir struct {
	URL  string // e.g. http://mimir:9009/prometheus
	HTTP *http.Client
	// OrgID is sent as X-Scope-OrgID when set.
	OrgID string
}

// instant runs one PromQL instant query and returns each series' labels and value.
func (m *Mimir) instant(ctx context.Context, promql string, at time.Time) ([]promSample, error) {
	q := url.Values{"query": {promql}, "time": {strconv.FormatInt(at.Unix(), 10)}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, m.URL+"/api/v1/query?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if m.OrgID != "" {
		req.Header.Set("X-Scope-OrgID", m.OrgID)
	}
	resp, err := client(m.HTTP).Do(req)
	if err != nil {
		return nil, &BackendError{Backend: "mimir", Err: err}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return nil, &BackendError{Backend: "mimir", Err: err}
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &BackendError{Backend: "mimir", Err: fmt.Errorf("%s: %s", resp.Status, truncate(string(body), 300))}
	}
	var a struct {
		Data struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &a); err != nil {
		return nil, &BackendError{Backend: "mimir", Err: fmt.Errorf("decode: %w", err)}
	}
	out := make([]promSample, 0, len(a.Data.Result))
	for _, r := range a.Data.Result {
		s, _ := r.Value[1].(string)
		v, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			continue
		}
		out = append(out, promSample{Labels: r.Metric, Value: v})
	}
	return out, nil
}

type promSample struct {
	Labels map[string]string
	Value  float64
}

// services reads server-span rate, error share and p95 per service from Tempo's span metrics
// (metrics_generator span-metrics processor, remote-written to Mimir).
func (m *Mimir) services(ctx context.Context, from, to time.Time) ([]ServiceStat, error) {
	rng := fmt.Sprintf("%ds", max(int(to.Sub(from).Seconds()), 60))
	server := `span_kind="SPAN_KIND_SERVER"`
	rate, err := m.instant(ctx, `sum by (service) (rate(traces_spanmetrics_calls_total{`+server+`}[`+rng+`]))`, to)
	if err != nil {
		return nil, err
	}
	errs, err := m.instant(ctx, `sum by (service) (rate(traces_spanmetrics_calls_total{`+server+`, status_code="STATUS_CODE_ERROR"}[`+rng+`]))`, to)
	if err != nil {
		return nil, err
	}
	p95, err := m.instant(ctx, `histogram_quantile(0.95, sum by (service, le) (rate(traces_spanmetrics_latency_bucket{`+server+`}[`+rng+`])))`, to)
	if err != nil {
		return nil, err
	}
	by := map[string]*ServiceStat{}
	for _, s := range rate {
		by[s.Labels["service"]] = &ServiceStat{Service: s.Labels["service"], RatePerSec: math.Round(s.Value*1000) / 1000}
	}
	for _, s := range errs {
		if st := by[s.Labels["service"]]; st != nil && st.RatePerSec > 0 {
			st.ErrorPct = math.Round(s.Value/st.RatePerSec*10000) / 100
		}
	}
	for _, s := range p95 {
		if st := by[s.Labels["service"]]; st != nil {
			ms := math.Round(s.Value*1000*10) / 10 // span metrics latency is in seconds
			st.P95Ms = &ms
		}
	}
	out := []ServiceStat{}
	for _, st := range by {
		if st.RatePerSec > 0 {
			out = append(out, *st)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RatePerSec > out[j].RatePerSec })
	return out, nil
}
