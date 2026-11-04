package httpapi

import (
	"net/url"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// scope is the project and app (service.name) a read is narrowed to: the
// Grafana plugin's selector, sent as ?project= and ?service= on every read
// (docs/specs/rum-api-scope.md). Empty fields mean "all". The project is the
// ouo_project_id Loki label, the same one funnels filter on.
//
// A scope narrows what a reader sees; it is not an access boundary. The read
// token is global, so any reader may ask for any project (per-project tokens
// are Phase 11).
type scope struct {
	project string
	service string
}

// parseScope reads ?project= and ?service=. An invalid project id is a 400.
func parseScope(q url.Values) (scope, error) {
	sc := scope{project: q.Get("project"), service: q.Get("service")}
	if sc.project != "" && !ValidProjectID(sc.project) {
		return sc, errorf("invalid project id")
	}
	return sc, nil
}

func (sc scope) all() bool { return sc.project == "" && sc.service == "" }

// contains reports whether an event belongs to the scope (Loki filters on the
// labels already; this keeps the contract when a source returns more).
func (sc scope) contains(ev session.Event) bool {
	return (sc.project == "" || ev.ProjectID == sc.project) && (sc.service == "" || ev.ServiceName == sc.service)
}

// replayInScope reports whether a replay recorded for metaProject may be
// served under the scope. Only the project is checked (a replay carries no
// service.name); replays stored before Phase 8a have no project and are
// served to every scope.
func (sc scope) replayInScope(metaProject string) bool {
	return sc.project == "" || metaProject == "" || metaProject == sc.project
}
