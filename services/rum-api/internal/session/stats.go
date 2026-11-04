package session

import (
	"math"
	"slices"
	"sort"
)

// Counts are the health counts and percentages of a group of sessions.
type Counts struct {
	Total      int     `json:"total"`
	Healthy    int     `json:"healthy"`
	Errored    int     `json:"errored"`
	Crashed    int     `json:"crashed"`
	HealthyPct float64 `json:"healthy_pct"`
	ErroredPct float64 `json:"errored_pct"`
	CrashedPct float64 `json:"crashed_pct"`
}

// Bucket is one (project, platform, service, version) group of the health
// stats.
type Bucket struct {
	ProjectID      string `json:"project_id"`
	Platform       string `json:"platform"`
	ServiceName    string `json:"service_name"`
	ServiceVersion string `json:"service_version"`
	Counts
}

// App is one (project, service) group of the health stats: an app of a
// project across its versions and platforms, for the cross-project overview.
type App struct {
	ProjectID   string   `json:"project_id"`
	ServiceName string   `json:"service_name"`
	Platforms   []string `json:"platforms"`
	Counts
}

// HealthStats is the /v1/stats/health response.
type HealthStats struct {
	Buckets []Bucket `json:"buckets"`
	Apps    []App    `json:"apps"`
	Totals  Bucket   `json:"totals"`
}

// Health groups records by project, platform, service name and version (and,
// for Apps, by project and service name) and computes percentages (rounded to
// 2 decimals; the three raw counts always sum to total). Buckets are sorted by
// project, platform, service, version; apps by project, service.
func Health(records []Record) HealthStats {
	type key struct{ proj, p, s, v string }
	type appKey struct{ proj, s string }
	m := map[key]*Bucket{}
	apps := map[appKey]*App{}
	totals := Bucket{}
	for _, r := range records {
		k := key{r.ProjectID, r.Platform, r.ServiceName, r.ServiceVersion}
		b, ok := m[k]
		if !ok {
			b = &Bucket{ProjectID: r.ProjectID, Platform: r.Platform, ServiceName: r.ServiceName, ServiceVersion: r.ServiceVersion}
			m[k] = b
		}
		ak := appKey{r.ProjectID, r.ServiceName}
		a, ok := apps[ak]
		if !ok {
			a = &App{ProjectID: r.ProjectID, ServiceName: r.ServiceName, Platforms: []string{}}
			apps[ak] = a
		}
		if r.Platform != "" && !slices.Contains(a.Platforms, r.Platform) {
			a.Platforms = append(a.Platforms, r.Platform)
		}
		b.add(r.Status)
		a.add(r.Status)
		totals.add(r.Status)
	}
	out := make([]Bucket, 0, len(m))
	for _, b := range m {
		b.finish()
		out = append(out, *b)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ProjectID != out[j].ProjectID {
			return out[i].ProjectID < out[j].ProjectID
		}
		if out[i].Platform != out[j].Platform {
			return out[i].Platform < out[j].Platform
		}
		if out[i].ServiceName != out[j].ServiceName {
			return out[i].ServiceName < out[j].ServiceName
		}
		return out[i].ServiceVersion < out[j].ServiceVersion
	})
	appList := make([]App, 0, len(apps))
	for _, a := range apps {
		a.finish()
		sort.Strings(a.Platforms)
		appList = append(appList, *a)
	}
	sort.Slice(appList, func(i, j int) bool {
		if appList[i].ProjectID != appList[j].ProjectID {
			return appList[i].ProjectID < appList[j].ProjectID
		}
		return appList[i].ServiceName < appList[j].ServiceName
	})
	totals.finish()
	return HealthStats{Buckets: out, Apps: appList, Totals: totals}
}

func (c *Counts) add(st Status) {
	c.Total++
	switch st {
	case StatusCrashed:
		c.Crashed++
	case StatusErrored:
		c.Errored++
	default:
		c.Healthy++
	}
}

func (c *Counts) finish() {
	if c.Total == 0 {
		return
	}
	pct := func(n int) float64 { return math.Round(float64(n)/float64(c.Total)*10000) / 100 }
	c.HealthyPct = pct(c.Healthy)
	c.ErroredPct = pct(c.Errored)
	c.CrashedPct = pct(c.Crashed)
}
