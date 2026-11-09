package session

import (
	"math"
	"sort"
)

// Bucket is one (platform, service, version, bundle) group of the health stats.
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

	// BundleID is the OTA bundle (Record.BundleID); "" for sessions without
	// one, so web and native buckets are one per version as before.
	BundleID string `json:"bundle_id"`
}

// HealthStats is the /v1/stats/health response.
type HealthStats struct {
	Buckets []Bucket `json:"buckets"`
	Totals  Bucket   `json:"totals"`
}

// Health groups records by platform, service name, version and OTA bundle
// and computes percentages (rounded to 2 decimals; the three raw counts
// always sum to total). Buckets are sorted by platform, service, version,
// bundle.
func Health(records []Record) HealthStats {
	type key struct{ p, s, v, b string }
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
		k := key{r.Platform, r.ServiceName, r.ServiceVersion, r.BundleID}
		b, ok := m[k]
		if !ok {
			b = &Bucket{Platform: r.Platform, ServiceName: r.ServiceName, ServiceVersion: r.ServiceVersion, BundleID: r.BundleID}
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
		if out[i].ServiceVersion != out[j].ServiceVersion {
			return out[i].ServiceVersion < out[j].ServiceVersion
		}
		return out[i].BundleID < out[j].BundleID
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
