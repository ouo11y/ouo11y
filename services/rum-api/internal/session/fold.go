package session

import (
	"sort"
	"strconv"
	"time"
)

// Status is the ADR-0004 health classification.
type Status string

const (
	StatusHealthy Status = "healthy"
	StatusErrored Status = "errored"
	StatusCrashed Status = "crashed"
)

// State is active or ended.
type State string

const (
	StateActive State = "active"
	StateEnded  State = "ended"
)

// Record is the server-side session record from the spec.
type Record struct {
	SessionID          string     `json:"session_id"`
	UserID             string     `json:"user_id"`
	Platform           string     `json:"platform"`
	ServiceName        string     `json:"service_name"`
	ServiceVersion     string     `json:"service_version"`
	StartedAt          time.Time  `json:"started_at"`
	LastSignalAt       time.Time  `json:"last_signal_at"`
	EndedAt            *time.Time `json:"ended_at"`
	EndReason          *string    `json:"end_reason"`
	State              State      `json:"state"`
	Status             Status     `json:"status"`
	ErrorCount         int        `json:"error_count"`
	CrashCount         int        `json:"crash_count"`
	FailedRequestCount int        `json:"failed_request_count"`
	EventCount         int        `json:"event_count"`
	TraceCount         int        `json:"trace_count"`
	HasReplay          bool       `json:"has_replay"`

	// Events is the session's events in time order (not serialised; the
	// API builds the timeline from it).
	Events []Event `json:"-"`
}

// Options control end inference.
type Options struct {
	// Inactivity is the server-side inactivity timeout (spec default 30 min).
	Inactivity time.Duration
	// MaxDuration is the spec MAX_DURATION (default 4 h), used to pick the
	// inferred end reason.
	MaxDuration time.Duration
}

// DefaultOptions are the spec defaults.
var DefaultOptions = Options{Inactivity: 30 * time.Minute, MaxDuration: 4 * time.Hour}

func (o Options) withDefaults() Options {
	if o.Inactivity <= 0 {
		o.Inactivity = DefaultOptions.Inactivity
	}
	if o.MaxDuration <= 0 {
		o.MaxDuration = DefaultOptions.MaxDuration
	}
	return o
}

// Fold groups events by session id and builds one Record per session.
// Events without a session id are ignored. Output is sorted by started_at
// descending (ties broken by session id for determinism).
func Fold(events []Event, now time.Time, opts Options) []Record {
	opts = opts.withDefaults()
	groups := map[string][]Event{}
	var order []string
	for _, ev := range events {
		if ev.SessionID == "" {
			continue
		}
		if _, ok := groups[ev.SessionID]; !ok {
			order = append(order, ev.SessionID)
		}
		groups[ev.SessionID] = append(groups[ev.SessionID], ev)
	}
	out := make([]Record, 0, len(order))
	for _, id := range order {
		out = append(out, FoldOne(id, groups[id], now, opts))
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].StartedAt.After(out[j].StartedAt)
		}
		return out[i].SessionID < out[j].SessionID
	})
	return out
}

// FoldOne builds the record of a single session from its events.
func FoldOne(id string, events []Event, now time.Time, opts Options) Record {
	opts = opts.withDefaults()
	evs := make([]Event, len(events))
	copy(evs, events)
	SortEvents(evs)

	rec := Record{SessionID: id, Events: evs, EventCount: len(evs)}
	var startEv, endEv *Event
	for i := range evs {
		ev := &evs[i]
		if rec.Platform == "" {
			rec.Platform = ev.Platform
		}
		if rec.ServiceName == "" {
			rec.ServiceName = ev.ServiceName
		}
		if rec.ServiceVersion == "" {
			rec.ServiceVersion = ev.ServiceVersion
		}
		// Latest non-empty user id wins: setUser() can arrive after session.start.
		if ev.UserID != "" {
			rec.UserID = ev.UserID
		}
		switch ev.Type() {
		case TypeSessionStart:
			if startEv == nil {
				startEv = ev
			}
		case TypeSessionEnd:
			endEv = ev // last one wins
		case TypeException:
			if ev.Fatal() {
				rec.CrashCount++
			} else {
				rec.ErrorCount++
			}
		case TypeRequestFailed:
			rec.FailedRequestCount++
		}
	}

	if len(evs) > 0 {
		rec.StartedAt = evs[0].TS
		rec.LastSignalAt = evs[len(evs)-1].TS
	}
	if startEv != nil {
		rec.StartedAt = startEv.TS
		// The SDK reports its own clock in ouo.session.started_at (epoch ms);
		// prefer it when it is earlier than the log timestamp (export lag).
		if ms, err := strconv.ParseInt(startEv.Attrs["ouo_session_started_at"], 10, 64); err == nil && ms > 0 {
			if t := time.UnixMilli(ms).UTC(); t.Before(rec.StartedAt) && rec.StartedAt.Sub(t) < time.Hour {
				rec.StartedAt = t
			}
		}
	}

	// End inference (spec: the server must not depend on session.end).
	switch {
	case endEv != nil:
		rec.State = StateEnded
		t := endEv.TS
		rec.EndedAt = &t
		reason := endEv.EndReason()
		if reason == "" {
			reason = "unknown"
		}
		rec.EndReason = &reason
	case now.Sub(rec.LastSignalAt) > opts.Inactivity:
		rec.State = StateEnded
		t := rec.LastSignalAt
		rec.EndedAt = &t
		reason := "inactivity"
		if rec.LastSignalAt.Sub(rec.StartedAt) >= opts.MaxDuration {
			reason = "max_duration"
		}
		rec.EndReason = &reason
	default:
		rec.State = StateActive
	}

	rec.Status = Classify(evs)
	return rec
}

// Classify applies ADR-0004: crashed > errored > healthy. A session.end with
// reason "crash" (mobile crash marker found on the next launch) also counts
// as crashed, because the fatal exception itself may never have been
// exported before the process died.
func Classify(events []Event) Status {
	status := StatusHealthy
	for _, ev := range events {
		switch ev.Type() {
		case TypeException:
			if ev.Fatal() {
				return StatusCrashed
			}
			status = StatusErrored
		case TypeRequestFailed:
			status = StatusErrored
		case TypeSessionEnd:
			if ev.EndReason() == "crash" {
				return StatusCrashed
			}
		}
	}
	return status
}
