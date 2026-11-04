// Package session folds Loki session events into session records and
// classifies them (docs/specs/session-lifecycle.md, ADR-0004). Everything in
// this package is pure: no I/O, time is passed in.
package session

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Event is one Loki log entry with its stream labels and structured metadata
// flattened into Attrs (Loki merges structured metadata into the stream
// labels of each result and rewrites "." to "_" in names).
type Event struct {
	TS   time.Time
	Name string // raw event_name label, e.g. "session.start", "cart.added"
	Line string // log line body
	// Session identifiers.
	SessionID      string
	UserID         string
	DeviceID       string // device.id (stable per browser or install), empty when the SDK sends none
	Platform       string
	ServiceName    string
	ServiceVersion string
	// Attrs holds every label / metadata key except the identifiers above.
	Attrs map[string]string
	// Context holds the event's device, OS, build and environment keys
	// (ContextKeys), including those dropped from Attrs as noise.
	Context map[string]string
}

// Type is the normalised timeline type of an event.
type Type string

const (
	TypeSessionStart  Type = "session.start"
	TypeSessionEnd    Type = "session.end"
	TypeException     Type = "exception"
	TypeRequestFailed Type = "http.request.failed"
	TypeNavigation    Type = "navigation"
	TypeWebVital      Type = "web_vital"
	// TypeVital is a mobile vital (docs/specs/mobile-vitals.md): ouo.app.start,
	// ouo.screen.display, app.jank or ouo.stall.
	TypeVital  Type = "vital"
	TypeCustom Type = "custom"
)

// KnownNames is the event_name regex used in the Loki selector for the
// session list (custom events are fetched too so event_count is complete, but
// they are classified as TypeCustom).
var KnownNames = []string{
	"session.start", "session.end", "exception", "http.request.failed", "navigation", "web_vital",
	VitalAppStart, VitalScreenDisplay, VitalJank, VitalStall,
}

// TypeOf maps a raw event name to its timeline type.
func TypeOf(name string) Type {
	switch name {
	case "session.start":
		return TypeSessionStart
	case "session.end":
		return TypeSessionEnd
	case "exception":
		return TypeException
	case "http.request.failed":
		return TypeRequestFailed
	case "navigation":
		return TypeNavigation
	case "web_vital":
		return TypeWebVital
	case VitalAppStart, VitalScreenDisplay, VitalJank, VitalStall:
		return TypeVital
	}
	return TypeCustom
}

// identifierKeys are lifted out of Attrs into Event fields.
var identifierKeys = map[string]bool{
	"session_id": true, "user_id": true, "device_id": true, "ouo_platform": true,
	"service_name": true, "service_version": true, "event_name": true,
}

// noiseKeys are per-SDK constants that would bloat every timeline entry.
var noiseKeys = map[string]bool{
	"observed_timestamp": true, "detected_level": true, "scope_name": true, "scope_version": true,
	"telemetry_sdk_language": true, "telemetry_sdk_name": true, "telemetry_sdk_version": true,
	"deployment_environment_name": true, "ouo_sdk_name": true, "ouo_sdk_version": true,
	"user_agent_original": true, "browser_brands": true, "browser_language": true,
	"browser_mobile": true, "browser_platform": true, "os_name": true, "os_version": true,
	"severity_number": true, "ouo_user_anonymous": true,
}

// Retained reports whether events keep the value of a Loki label or
// structured-metadata key (Value can read it): every key except the noise
// keys outside ContextKeys.
func Retained(key string) bool {
	return !noiseKeys[key] || slices.Contains(ContextKeys, key)
}

// Value returns the value of a Loki label or structured-metadata key (Loki
// name, e.g. payment_method) as a LogQL label filter sees it: "" when the
// event does not carry it. Identifier keys read the Event fields.
func (e Event) Value(key string) string {
	switch key {
	case "event_name":
		return e.Name
	case "session_id":
		return e.SessionID
	case "user_id":
		return e.UserID
	case "device_id":
		return e.DeviceID
	case "ouo_platform":
		return e.Platform
	case "service_name":
		return e.ServiceName
	case "service_version":
		return e.ServiceVersion
	}
	if v, ok := e.Attrs[key]; ok {
		return v
	}
	return e.Context[key]
}

// ContextKeys are the resource attributes (Loki names) the session detail
// header shows: device, OS, app build and deployment environment.
var ContextKeys = []string{
	"device_model_identifier", "device_model_name", "device_manufacturer",
	"os_name", "os_version", "ouo_app_build", "deployment_environment_name",
}

// SessionContext merges the Context of a session's events: the latest
// non-empty value of each key wins. Nil when no event carries any.
func SessionContext(evs []Event) map[string]string {
	var out map[string]string
	for _, ev := range evs {
		for k, v := range ev.Context {
			if out == nil {
				out = map[string]string{}
			}
			out[k] = v
		}
	}
	return out
}

// LokiQueryResponse is the subset of Loki's /loki/api/v1/query_range response
// this package reads.
type LokiQueryResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string       `json:"resultType"`
		Result     []LokiStream `json:"result"`
	} `json:"data"`
}

// LokiStream is one stream in a Loki streams result.
type LokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][2]string       `json:"values"` // [ts nanoseconds, line]
}

// ParseLokiResponse decodes a raw query_range body into events (sorted by time).
func ParseLokiResponse(body []byte) ([]Event, error) {
	var resp LokiQueryResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode loki response: %w", err)
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("loki status %q", resp.Status)
	}
	if resp.Data.ResultType != "streams" && resp.Data.ResultType != "" {
		return nil, fmt.Errorf("loki resultType %q, want streams", resp.Data.ResultType)
	}
	return EventsFromStreams(resp.Data.Result), nil
}

// EventsFromStreams flattens Loki streams into events sorted by timestamp.
func EventsFromStreams(streams []LokiStream) []Event {
	var out []Event
	for _, s := range streams {
		for _, v := range s.Values {
			ns, err := strconv.ParseInt(v[0], 10, 64)
			if err != nil {
				continue
			}
			out = append(out, eventFromLabels(time.Unix(0, ns).UTC(), s.Stream, v[1]))
		}
	}
	SortEvents(out)
	return out
}

// SortEvents orders events by time, then name, then line (stable, total).
func SortEvents(evs []Event) {
	sort.SliceStable(evs, func(i, j int) bool {
		if !evs[i].TS.Equal(evs[j].TS) {
			return evs[i].TS.Before(evs[j].TS)
		}
		if evs[i].Name != evs[j].Name {
			return evs[i].Name < evs[j].Name
		}
		return evs[i].Line < evs[j].Line
	})
}

func eventFromLabels(ts time.Time, labels map[string]string, line string) Event {
	ev := Event{
		TS:             ts,
		Line:           line,
		Name:           labels["event_name"],
		SessionID:      labels["session_id"],
		UserID:         labels["user_id"],
		DeviceID:       labels["device_id"],
		Platform:       labels["ouo_platform"],
		ServiceName:    labels["service_name"],
		ServiceVersion: labels["service_version"],
		Attrs:          map[string]string{},
	}
	for k, v := range labels {
		if identifierKeys[k] || noiseKeys[k] {
			continue
		}
		ev.Attrs[k] = v
	}
	for _, k := range ContextKeys {
		if v := labels[k]; v != "" {
			if ev.Context == nil {
				ev.Context = map[string]string{}
			}
			ev.Context[k] = v
		}
	}
	return ev
}

// Type returns the timeline type of the event.
func (e Event) Type() Type { return TypeOf(e.Name) }

// Fatal reports whether an exception event is fatal (ouo.exception.fatal).
func (e Event) Fatal() bool { return isTrue(e.Attrs["ouo_exception_fatal"]) }

// EndReason returns ouo.session.end_reason for a session.end event.
func (e Event) EndReason() string { return e.Attrs["ouo_session_end_reason"] }

// Key identifies an event for de-duplication across paginated Loki pages.
func (e Event) Key() string {
	return strconv.FormatInt(e.TS.UnixNano(), 10) + "|" + e.SessionID + "|" + e.Name + "|" + e.Line
}

func isTrue(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "1", "yes":
		return true
	}
	return false
}
