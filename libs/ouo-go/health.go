package ouogo

import (
	"context"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Session health % (ADR-0004, docs/specs/session-lifecycle.md): every session is healthy,
// errored or crashed, and the percentages are over the sessions that started in the
// range. Ported from rum-api's internal/session (Fold, classify, Health) and
// GET /v1/stats/health.

// HealthStatus is a session's ADR-0004 class.
type HealthStatus string

const (
	Healthy HealthStatus = "healthy"
	Errored HealthStatus = "errored"
	Crashed HealthStatus = "crashed"
)

// classify applies ADR-0004 to one session's records: crashed > errored > healthy. A
// fatal exception (ouo.exception.fatal) or a session.end with reason "crash" (a mobile
// crash marker found on the next launch: the fatal exception itself may never have been
// exported) is a crash; any other exception or an http.request.failed is an error.
func classify(lines []LokiLine) HealthStatus {
	status := Healthy
	for _, l := range lines {
		switch l.Labels["event_name"] {
		case "exception":
			if isTrue(l.Labels["ouo_exception_fatal"]) {
				return Crashed
			}
			status = Errored
		case "http.request.failed":
			status = Errored
		case "session.end":
			if l.Labels["ouo_session_end_reason"] == "crash" {
				return Crashed
			}
		}
	}
	return status
}

func isTrue(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "1", "yes":
		return true
	}
	return false
}

// sessionStart is when a session started: its session.start record, else its first
// record, moved earlier to the SDK's own ouo.session.started_at (on session.start, else
// on session.end) when that is earlier by less than an hour (export lag; a crash in the
// first second can lose session.start). lines are sorted.
func sessionStart(lines []LokiLine) time.Time {
	start := lines[0].Time
	var startEv, endEv *LokiLine
	for i := range lines {
		switch lines[i].Labels["event_name"] {
		case "session.start":
			if startEv == nil {
				startEv = &lines[i]
			}
		case "session.end":
			endEv = &lines[i]
		}
	}
	ev := startEv
	if ev != nil {
		start = ev.Time
	} else {
		ev = endEv
	}
	if ev != nil {
		if ms, err := strconv.ParseInt(ev.Labels["ouo_session_started_at"], 10, 64); err == nil && ms > 0 {
			if t := time.UnixMilli(ms); t.Before(start) && start.Sub(t) < time.Hour {
				start = t
			}
		}
	}
	return start
}

// HealthBucket is one (platform, service, version) group, or the totals.
type HealthBucket struct {
	Platform       string  `json:"platform"`
	ServiceName    string  `json:"service_name"`
	ServiceVersion string  `json:"service_version"`
	Total          int     `json:"total"`
	Healthy        int     `json:"healthy"`
	Errored        int     `json:"errored"`
	Crashed        int     `json:"crashed"`
	HealthyPct     float64 `json:"healthy_pct"` // 2 decimals; the counts sum to Total
	ErroredPct     float64 `json:"errored_pct"`
	CrashedPct     float64 `json:"crashed_pct"`
}

func (b *HealthBucket) add(s HealthStatus) {
	b.Total++
	switch s {
	case Crashed:
		b.Crashed++
	case Errored:
		b.Errored++
	default:
		b.Healthy++
	}
}

func (b *HealthBucket) finish() {
	if b.Total == 0 {
		return
	}
	pct := func(n int) float64 { return math.Round(float64(n)/float64(b.Total)*10000) / 100 }
	b.HealthyPct, b.ErroredPct, b.CrashedPct = pct(b.Healthy), pct(b.Errored), pct(b.Crashed)
}

// HealthStats is the answer of Loki.Health.
type HealthStats struct {
	Buckets []HealthBucket `json:"buckets"` // by platform, service, version
	Totals  HealthBucket   `json:"totals"`
	From    time.Time      `json:"from"`
	To      time.Time      `json:"to"`
	// Truncated: the read hit FunnelEventLimit, so sessions may be missing or misclassified.
	Truncated bool `json:"truncated"`
}

// HealthQuery scopes Loki.Health.
type HealthQuery struct {
	TimeRange
	Filters Filters
	// Lookback is how far before From records are read, so a session that started
	// shortly before the range is folded whole and then left out instead of counted with
	// a wrong start. Default 4 hours (the session lifecycle's MAX_DURATION).
	Lookback time.Duration
}

// Health classifies every session that started in the range and returns the percentages
// per platform, service and version, and in total.
func (l *Loki) Health(ctx context.Context, q HealthQuery) (*HealthStats, error) {
	if err := q.Filters.check(); err != nil {
		return nil, err
	}
	from, to, err := q.window(l.Now)
	if err != nil {
		return nil, err
	}
	lookback := q.Lookback
	if lookback <= 0 {
		lookback = 4 * time.Hour
	}
	lines, trunc, err := l.queryAll(ctx, q.Filters.selector(`=~".+"`), from.Add(-lookback), to)
	if err != nil {
		return nil, err
	}
	return healthOf(bySession(lines), from, to, trunc), nil
}

func healthOf(sessions map[string][]LokiLine, from, to time.Time, trunc bool) *HealthStats {
	type key struct{ p, s, v string }
	m := map[key]*HealthBucket{}
	out := &HealthStats{Buckets: []HealthBucket{}, From: from, To: to, Truncated: trunc}
	for _, lines := range sessions {
		if st := sessionStart(lines); st.Before(from) || st.After(to) {
			continue
		}
		var k key
		for _, l := range lines {
			if k.p == "" {
				k.p = l.Labels["ouo_platform"]
			}
			if k.s == "" {
				k.s = l.Labels["service_name"]
			}
			if k.v == "" {
				k.v = l.Labels["service_version"]
			}
		}
		b := m[k]
		if b == nil {
			b = &HealthBucket{Platform: k.p, ServiceName: k.s, ServiceVersion: k.v}
			m[k] = b
		}
		status := classify(lines)
		b.add(status)
		out.Totals.add(status)
	}
	for _, b := range m {
		b.finish()
		out.Buckets = append(out.Buckets, *b)
	}
	sort.Slice(out.Buckets, func(i, j int) bool {
		a, b := out.Buckets[i], out.Buckets[j]
		if a.Platform != b.Platform {
			return a.Platform < b.Platform
		}
		if a.ServiceName != b.ServiceName {
			return a.ServiceName < b.ServiceName
		}
		return a.ServiceVersion < b.ServiceVersion
	})
	out.Totals.finish()
	return out
}
