package session

import (
	"math"
	"sort"
)

// Bucket is one (platform, service, version) group of the health stats.
type Bucket struct {
	Platform       string  `json:"platform"`
	ServiceName    string  `json:"service_name"`
	ServiceVersion string  `json:"service_version"`
	Total          int     `json:"total"`
	Healthy        int     `json:"healthy"`
	Errored        int     `json:"errored"`
	Crashed        int     `json:"crashed"`
	HealthyPct     float64 `json:"healthy_pct"`
	ErroredPct     float64 `json:"errored_pct"`
	CrashedPct     float64 `json:"crashed_pct"`
}

// HealthStats is the /v1/stats/health response.
type HealthStats struct {
	Buckets []Bucket `json:"buckets"`
	Totals  Bucket   `json:"totals"`
}

// Health groups records by platform, service name and version and computes
// percentages (rounded to 2 decimals; the three raw counts always sum to
// total). Buckets are sorted by platform, service, version.
func Health(records []Record) HealthStats {
	type key struct{ p, s, v string }
	m := map[key]*Bucket{}
	totals := Bucket{}
	add := func(b *Bucket, st Status) {
		b.Total++
		switch st {
		case StatusCrashed:
			b.Crashed++
		case StatusErrored:
			b.Errored++
		default:
			b.Healthy++
		}
	}
	for _, r := range records {
		k := key{r.Platform, r.ServiceName, r.ServiceVersion}
		b, ok := m[k]
		if !ok {
			b = &Bucket{Platform: r.Platform, ServiceName: r.ServiceName, ServiceVersion: r.ServiceVersion}
			m[k] = b
		}
		add(b, r.Status)
		add(&totals, r.Status)
	}
	out := make([]Bucket, 0, len(m))
	for _, b := range m {
		b.finish()
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Platform != out[j].Platform {
			return out[i].Platform < out[j].Platform
		}
		if out[i].ServiceName != out[j].ServiceName {
			return out[i].ServiceName < out[j].ServiceName
		}
		return out[i].ServiceVersion < out[j].ServiceVersion
	})
	totals.finish()
	return HealthStats{Buckets: out, Totals: totals}
}

func (b *Bucket) finish() {
	if b.Total == 0 {
		return
	}
	pct := func(n int) float64 { return math.Round(float64(n)/float64(b.Total)*10000) / 100 }
	b.HealthyPct = pct(b.Healthy)
	b.ErroredPct = pct(b.Errored)
	b.CrashedPct = pct(b.Crashed)
}
