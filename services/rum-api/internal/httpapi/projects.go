package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/loki"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/timerange"
)

// GET /v1/projects lists the projects and their apps (service.name) that
// started sessions in the range: the options of the plugin's project and app
// selector (docs/specs/rum-api-scope.md).

const (
	defaultProjectsRange = 7 * 24 * time.Hour
	// maxProjectsRange stays under Loki's default max_query_length (721h).
	maxProjectsRange = 30 * 24 * time.Hour
	// projectsTimeGrain rounds from down and to up (a superset of the range)
	// so the Loki query results cache hits and a session that just started
	// is not cut off.
	projectsTimeGrain = time.Minute
)

// GroupCountSource is the optional Loki capability GET /v1/projects uses
// (loki.Client implements it).
type GroupCountSource interface {
	CountsBy(ctx context.Context, query string, by []string, start, end time.Time) ([]loki.GroupCount, error)
}

type projectApp struct {
	ServiceName string   `json:"service_name"`
	Platforms   []string `json:"platforms"`
	Sessions    int      `json:"sessions"`
}

type projectEntry struct {
	ProjectID string       `json:"project_id"`
	Sessions  int          `json:"sessions"`
	Apps      []projectApp `json:"apps"`
}

type projectsResponse struct {
	Projects []projectEntry `json:"projects"`
	// Unscoped counts sessions without ouo.project.id (ingested before the
	// collector stamped it); the selector cannot narrow to them.
	Unscoped int       `json:"unscoped_sessions"`
	From     time.Time `json:"from"`
	To       time.Time `json:"to"`
}

// projectsQuery counts session.start per project, app and platform.
const projectsQuery = `{service_name=~".+", event_name="session.start"}`

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	counter, ok := s.events.(GroupCountSource)
	if !ok {
		writeError(w, http.StatusNotImplemented, "the project list needs a Loki client")
		return
	}
	q := r.URL.Query()
	from, to, err := timerange.Range(q.Get("from"), q.Get("to"), s.opts.Now(), defaultProjectsRange)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	from = from.Truncate(projectsTimeGrain)
	if t := to.Truncate(projectsTimeGrain); !t.Equal(to) {
		to = t.Add(projectsTimeGrain)
	}
	if to.Sub(from) > maxProjectsRange {
		writeError(w, http.StatusBadRequest, "range is at most 720h")
		return
	}
	groups, err := counter.CountsBy(r.Context(), projectsQuery, []string{"ouo_project_id", "service_name", "ouo_platform"}, from, to)
	if err != nil {
		slog.Error("projects: loki", "error", err)
		writeError(w, http.StatusBadGateway, "loki: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, buildProjects(groups, from, to))
}

func buildProjects(groups []loki.GroupCount, from, to time.Time) projectsResponse {
	resp := projectsResponse{Projects: []projectEntry{}, From: from, To: to}
	type appKey struct{ project, service string }
	apps := map[appKey]*projectApp{}
	projects := map[string]*projectEntry{}
	for _, g := range groups {
		if g.Count <= 0 {
			continue
		}
		project, service, platform := g.Labels["ouo_project_id"], g.Labels["service_name"], g.Labels["ouo_platform"]
		if project == "" {
			resp.Unscoped += g.Count
			continue
		}
		p := projects[project]
		if p == nil {
			p = &projectEntry{ProjectID: project}
			projects[project] = p
		}
		p.Sessions += g.Count
		k := appKey{project, service}
		a := apps[k]
		if a == nil {
			a = &projectApp{ServiceName: service, Platforms: []string{}}
			apps[k] = a
		}
		a.Sessions += g.Count
		if platform != "" && !slices.Contains(a.Platforms, platform) {
			a.Platforms = append(a.Platforms, platform)
		}
	}
	for k, a := range apps {
		sort.Strings(a.Platforms)
		projects[k.project].Apps = append(projects[k.project].Apps, *a)
	}
	for _, p := range projects {
		sort.Slice(p.Apps, func(i, j int) bool { return p.Apps[i].ServiceName < p.Apps[j].ServiceName })
		resp.Projects = append(resp.Projects, *p)
	}
	sort.Slice(resp.Projects, func(i, j int) bool { return resp.Projects[i].ProjectID < resp.Projects[j].ProjectID })
	return resp
}
