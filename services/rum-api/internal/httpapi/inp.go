package httpapi

import (
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/funnel"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/timerange"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/vitals"
)

// INP by element (docs/specs/web-vitals.md, "Slowest interactions").

const (
	defaultINPLimit = 50
	maxINPLimit     = 500
)

type inpTargetsResponse struct {
	Groups    []vitals.InteractionGroup `json:"groups"`
	Total     int                       `json:"total"`      // groups before the limit
	PageViews int                       `json:"page_views"` // page views with an INP, all groups
	From      time.Time                 `json:"from"`
	To        time.Time                 `json:"to"`
}

// getINPTargets: GET /v1/vitals/inp/targets. p75 INP per interaction target
// and page over a range, slowest first, with the p75 of each phase and the
// Long Animation Frame script seen most often.
func (s *Server) getINPTargets(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := FunnelFilters{Service: q.Get("service"), Environment: q.Get("environment"), Release: q.Get("release"), Platform: q.Get("platform"), Project: q.Get("project")}
	if f.Project != "" && !ValidProjectID(f.Project) {
		writeError(w, http.StatusBadRequest, "invalid project id")
		return
	}
	from, to, err := timerange.Range(q.Get("from"), q.Get("to"), s.opts.Now(), defaultFunnelRange)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	from, to = from.Truncate(funnelTimeGrain), to.Truncate(funnelTimeGrain)
	if to.Sub(from) > funnel.MaxRange {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("range is at most %s", funnel.MaxRange))
		return
	}
	limit := defaultINPLimit
	if v := q.Get("limit"); v != "" {
		if limit, err = strconv.Atoi(v); err != nil || limit <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = min(limit, maxINPLimit)
	}
	query := f.selector(`="web_vital"`) + ` | ` + vitals.AttrName + `="INP"`
	if page := q.Get("page"); page != "" {
		query += ` | (` + vitals.AttrRoute + `=` + strconv.Quote(page) + ` or ` + vitals.AttrPath + `=` + strconv.Quote(page) + `)`
	}
	events, err := s.events.EventsQuery(r.Context(), query, from, to)
	if err != nil {
		slog.Error("inp targets: loki", "error", err)
		writeError(w, http.StatusBadGateway, "loki: "+err.Error())
		return
	}
	groups := vitals.INPByTarget(events)
	resp := inpTargetsResponse{Groups: groups, Total: len(groups), From: from, To: to}
	for _, g := range groups {
		resp.PageViews += g.Count
	}
	if len(resp.Groups) > limit {
		resp.Groups = resp.Groups[:limit]
	}
	writeJSON(w, http.StatusOK, resp)
}
