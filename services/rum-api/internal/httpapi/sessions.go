package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/ZiadMansourM/ouo/services/rum-api/internal/loki"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/replay"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/session"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/tempo"
	"github.com/ZiadMansourM/ouo/services/rum-api/internal/timerange"
)

const (
	defaultListRange = time.Hour
	defaultLimit     = 100
	maxLimit         = 1000
	// traceRangePad widens the Tempo search window around the session so
	// spans exported slightly before session.start or after the last event
	// are still found.
	traceRangePad = 2 * time.Minute
)

// listResponse is GET /v1/sessions.
type listResponse struct {
	Sessions []session.Record `json:"sessions"`
	Count    int              `json:"count"`
	From     time.Time        `json:"from"`
	To       time.Time        `json:"to"`
}

// timelineItem is one entry of the session detail timeline.
type timelineItem struct {
	TS    time.Time         `json:"ts"`
	Type  session.Type      `json:"type"`
	Name  string            `json:"name"`
	Attrs map[string]string `json:"attrs"`
}

// detailResponse is GET /v1/sessions/{id}.
type detailResponse struct {
	session.Record
	Timeline []timelineItem `json:"timeline"`
	Traces   []tempo.Trace  `json:"traces"`
}

type tracesResponse struct {
	SessionID string        `json:"session_id"`
	Traces    []tempo.Trace `json:"traces"`
	Count     int           `json:"count"`
}

type statsResponse struct {
	session.HealthStats
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}

type listQuery struct {
	from, to time.Time
	filters  loki.Filters
	status   session.Status
	limit    int
}

func (s *Server) parseListQuery(r *http.Request) (listQuery, error) {
	q := r.URL.Query()
	now := s.opts.Now()
	from, to, err := timerange.Range(q.Get("from"), q.Get("to"), now, defaultListRange)
	if err != nil {
		return listQuery{}, badRequest{err}
	}
	lq := listQuery{
		from: from, to: to,
		filters: loki.Filters{
			Platform: q.Get("platform"),
			Service:  q.Get("service"),
			Version:  q.Get("version"),
			User:     q.Get("user"),
		},
		limit: defaultLimit,
	}
	if st := q.Get("status"); st != "" {
		switch session.Status(st) {
		case session.StatusHealthy, session.StatusErrored, session.StatusCrashed:
			lq.status = session.Status(st)
		default:
			return lq, errorf("status must be healthy, errored or crashed")
		}
	}
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n <= 0 {
			return lq, errorf("limit must be a positive integer")
		}
		lq.limit = min(n, maxLimit)
	}
	return lq, nil
}

// badRequest marks client errors (400) as opposed to upstream failures (502).
type badRequest struct{ error }

func errorf(s string) error { return badRequest{errors.New(s)} }

// foldRange queries Loki for the window and returns the sessions that
// started inside [from, to] (ADR-0004: percentages are over sessions whose
// started_at is in the range). Loki is queried from from-lookback so a
// session that started before `from` is folded with all of its events and
// then excluded, instead of showing up with a wrong started_at.
func (s *Server) foldRange(r *http.Request, lq listQuery) ([]session.Record, error) {
	evs, err := s.events.Events(r.Context(), lq.filters, lq.from.Add(-s.opts.ListLookback), lq.to)
	if err != nil {
		return nil, err
	}
	all := session.Fold(evs, s.opts.Now(), s.opts.SessionOptions)
	out := all[:0]
	for _, rec := range all {
		if rec.StartedAt.Before(lq.from) || rec.StartedAt.After(lq.to) {
			continue
		}
		if lq.status != "" && rec.Status != lq.status {
			continue
		}
		out = append(out, rec)
	}
	return out, nil
}

func (s *Server) listSessions(w http.ResponseWriter, r *http.Request) {
	lq, err := s.parseListQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	recs, err := s.foldRange(r, lq)
	if err != nil {
		slog.Error("list sessions: loki", "error", err)
		writeError(w, http.StatusBadGateway, "loki: "+err.Error())
		return
	}
	if len(recs) > lq.limit {
		recs = recs[:lq.limit]
	}
	s.decorate(r, recs)
	if recs == nil {
		recs = []session.Record{}
	}
	writeJSON(w, http.StatusOK, listResponse{Sessions: recs, Count: len(recs), From: lq.from, To: lq.to})
}

// decorate fills trace_count (best effort, concurrent, -1 on Tempo error)
// and has_replay.
func (s *Server) decorate(r *http.Request, recs []session.Record) {
	var wg sync.WaitGroup
	for i := range recs {
		recs[i].HasReplay = s.store.Has(r.Context(), recs[i].SessionID)
		wg.Add(1)
		go func(rec *session.Record) {
			defer wg.Done()
			start, end := s.traceWindow(rec)
			traces, err := s.traces.SessionTraces(r.Context(), rec.SessionID, start, end)
			if err != nil {
				slog.Warn("tempo search failed", "session_id", rec.SessionID, "error", err)
				rec.TraceCount = -1
				return
			}
			rec.TraceCount = len(traces)
		}(&recs[i])
	}
	wg.Wait()
}

// traceWindow is the Tempo search range of a session, rounded to whole
// minutes so the Tempo cache key stays stable while a session is active.
func (s *Server) traceWindow(rec *session.Record) (time.Time, time.Time) {
	start := rec.StartedAt.Add(-traceRangePad).Truncate(time.Minute)
	end := rec.LastSignalAt
	if rec.State == session.StateActive {
		end = s.opts.Now()
	}
	end = end.Add(traceRangePad).Truncate(time.Minute).Add(time.Minute)
	return start, end
}

// lookupSession finds one session's record (events included) in Loki.
func (s *Server) lookupSession(r *http.Request, id string) (*session.Record, error) {
	q := r.URL.Query()
	now := s.opts.Now()
	from, to, err := timerange.Range(q.Get("from"), q.Get("to"), now, s.opts.DetailLookback)
	if err != nil {
		return nil, badRequest{err}
	}
	evs, err := s.events.Events(r.Context(), loki.Filters{SessionID: id}, from, to)
	if err != nil {
		return nil, err
	}
	var own []session.Event
	for _, ev := range evs {
		if ev.SessionID == id {
			own = append(own, ev)
		}
	}
	if len(own) == 0 {
		return nil, nil
	}
	rec := session.FoldOne(id, own, now, s.opts.SessionOptions)
	return &rec, nil
}

func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !replay.ValidSessionID(id) {
		writeError(w, http.StatusBadRequest, "invalid session id")
		return
	}
	rec, err := s.lookupSession(r, id)
	if err != nil {
		s.lokiError(w, err)
		return
	}
	if rec == nil {
		writeError(w, http.StatusNotFound, "session not found: "+id)
		return
	}
	timeline := make([]timelineItem, 0, len(rec.Events))
	for _, ev := range rec.Events {
		timeline = append(timeline, timelineItem{TS: ev.TS, Type: ev.Type(), Name: ev.Name, Attrs: ev.Attrs})
	}
	rec.HasReplay = s.store.Has(r.Context(), id)
	start, end := s.traceWindow(rec)
	traces, err := s.traces.SessionTraces(r.Context(), id, start, end)
	if err != nil {
		slog.Warn("tempo search failed", "session_id", id, "error", err)
		rec.TraceCount = -1
	} else {
		rec.TraceCount = len(traces)
	}
	if traces == nil {
		traces = []tempo.Trace{}
	}
	writeJSON(w, http.StatusOK, detailResponse{Record: *rec, Timeline: timeline, Traces: traces})
}

func (s *Server) getSessionTraces(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !replay.ValidSessionID(id) {
		writeError(w, http.StatusBadRequest, "invalid session id")
		return
	}
	rec, err := s.lookupSession(r, id)
	if err != nil {
		s.lokiError(w, err)
		return
	}
	var start, end time.Time
	if rec != nil {
		start, end = s.traceWindow(rec)
	} else {
		// No events in Loki: fall back to the requested or default range.
		now := s.opts.Now()
		if start, end, err = timerange.Range(r.URL.Query().Get("from"), r.URL.Query().Get("to"), now, s.opts.DetailLookback); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	traces, err := s.traces.SessionTraces(r.Context(), id, start, end)
	if err != nil {
		slog.Error("session traces: tempo", "session_id", id, "error", err)
		writeError(w, http.StatusBadGateway, "tempo: "+err.Error())
		return
	}
	if traces == nil {
		traces = []tempo.Trace{}
	}
	writeJSON(w, http.StatusOK, tracesResponse{SessionID: id, Traces: traces, Count: len(traces)})
}

func (s *Server) statsHealth(w http.ResponseWriter, r *http.Request) {
	lq, err := s.parseListQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	recs, err := s.foldRange(r, lq)
	if err != nil {
		slog.Error("stats: loki", "error", err)
		writeError(w, http.StatusBadGateway, "loki: "+err.Error())
		return
	}
	stats := session.Health(recs)
	if stats.Buckets == nil {
		stats.Buckets = []session.Bucket{}
	}
	writeJSON(w, http.StatusOK, statsResponse{HealthStats: stats, From: lq.from, To: lq.to})
}

func (s *Server) lokiError(w http.ResponseWriter, err error) {
	var br badRequest
	if errors.As(err, &br) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	slog.Error("loki query failed", "error", err)
	writeError(w, http.StatusBadGateway, "loki: "+err.Error())
}
