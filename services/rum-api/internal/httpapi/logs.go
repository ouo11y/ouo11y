package httpapi

import (
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/replay"
	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

const (
	// maxLogLines bounds one response; the Explore link has the full query.
	maxLogLines = 2000
	// maxLogTraces bounds the trace ids put into the LogQL regex.
	maxLogTraces = 200
)

// timelineOnly are session events that are not log lines: they are the
// session's timeline (navigation, requests, lifecycle), not something an
// engineer reads as a log.
var timelineOnly = map[string]bool{
	"session.start": true, "session.end": true, "navigation": true, "http.request": true,
	"http.request.failed": true, "web_vital": true, "app.lifecycle": true, "ui.tap": true, "breadcrumb": true,
}

var hexID = regexp.MustCompile(`^[0-9a-f]{1,32}$`)

// logLine is one entry of GET /v1/sessions/{id}/logs.
type logLine struct {
	TS        time.Time `json:"ts"`
	Service   string    `json:"service"`
	Level     string    `json:"level"`
	Body      string    `json:"body"`
	EventName string    `json:"event_name,omitempty"`
	TraceID   string    `json:"trace_id,omitempty"`
	SpanID    string    `json:"span_id,omitempty"`
	// Source is "session" (the record carries the session id) or "trace" (it
	// shares a trace with the session, e.g. a backend log line).
	Source   string            `json:"source"`
	TraceURL string            `json:"trace_url,omitempty"`
	Attrs    map[string]string `json:"attrs"`
}

type logsResponse struct {
	SessionID  string    `json:"session_id"`
	Logs       []logLine `json:"logs"`
	Count      int       `json:"count"`
	Truncated  bool      `json:"truncated"`
	TraceCount int       `json:"trace_count"` // traces whose logs were included; -1 when Tempo failed
	Query      string    `json:"query"`
	ExploreURL string    `json:"explore_url,omitempty"`
}

// normTraceID pads a Tempo trace id to 32 hex characters (Tempo search drops
// leading zeros, Loki stores the full id).
func normTraceID(id string) string {
	id = strings.ToLower(id)
	if len(id) < 32 {
		id = strings.Repeat("0", 32-len(id)) + id
	}
	return id
}

// sessionLogsQuery selects the session's own records and every record that
// shares one of its traces.
func sessionLogsQuery(id string, traceIDs []string) string {
	q := `{service_name=~".+"} | session_id=` + strconv.Quote(id)
	if len(traceIDs) > 0 {
		q += ` or trace_id=~` + strconv.Quote(strings.Join(traceIDs, "|"))
	}
	return q
}

func (s *Server) getSessionLogs(w http.ResponseWriter, r *http.Request) {
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
	start, end := s.traceWindow(rec)

	resp := logsResponse{SessionID: id, Logs: []logLine{}}
	traceSet := map[string]bool{}
	var traceIDs []string
	traces, err := s.traces.SessionTraces(r.Context(), id, start, end)
	if err != nil {
		// Still useful without Tempo: the session's own lines.
		slog.Warn("session logs: tempo search failed", "session_id", id, "error", err)
		resp.TraceCount = -1
	}
	for _, t := range traces {
		tid := normTraceID(t.TraceID)
		if !hexID.MatchString(tid) || traceSet[tid] || len(traceIDs) >= maxLogTraces {
			continue
		}
		traceSet[tid] = true
		traceIDs = append(traceIDs, tid)
	}
	if resp.TraceCount == 0 {
		resp.TraceCount = len(traceIDs)
	}

	resp.Query = sessionLogsQuery(id, traceIDs)
	evs, err := s.events.EventsQuery(r.Context(), resp.Query, start, end)
	if err != nil {
		s.lokiError(w, err)
		return
	}
	for _, ev := range evs {
		tid := ev.Attrs["trace_id"]
		var source string
		switch {
		case ev.SessionID == id:
			source = "session"
		case tid != "" && traceSet[tid]:
			source = "trace"
		default:
			continue // Loki matched more than asked (or a fake did); keep the contract
		}
		if timelineOnly[ev.Name] {
			continue
		}
		if len(resp.Logs) >= maxLogLines {
			resp.Truncated = true
			break
		}
		resp.Logs = append(resp.Logs, s.logLineOf(ev, source))
	}
	resp.Count = len(resp.Logs)
	if s.opts.LokiLinks != nil {
		resp.ExploreURL = s.opts.LokiLinks.QueryURL(resp.Query, start, end)
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) logLineOf(ev session.Event, source string) logLine {
	l := logLine{
		TS: ev.TS, Service: ev.ServiceName, Body: ev.Line, EventName: ev.Name, Source: source,
		TraceID: ev.Attrs["trace_id"], SpanID: ev.Attrs["span_id"], Attrs: map[string]string{},
	}
	l.Level = strings.ToLower(ev.Attrs["severity_text"])
	if l.Level == "" && ev.Name == "exception" {
		l.Level = "error"
	}
	for k, v := range ev.Attrs {
		switch k {
		case "trace_id", "span_id", "severity_text", "message":
			continue
		}
		l.Attrs[k] = v
	}
	if l.TraceID != "" && s.opts.TraceLinks != nil {
		l.TraceURL = s.opts.TraceLinks.TraceURL(l.TraceID, ev.TS, 0)
	}
	return l
}
