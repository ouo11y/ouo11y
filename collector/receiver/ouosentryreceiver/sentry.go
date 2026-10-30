package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"bytes"
	"encoding/json"
	"math"
	"path"
	"strconv"
	"strings"
	"time"
)

// Sentry payload shapes the translator reads (develop.sentry.dev; MIT SDK
// sources). Unknown fields are ignored.

// flexTime accepts a Sentry timestamp: RFC 3339 string or Unix seconds (float).
type flexTime struct{ time.Time }

func (t *flexTime) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		if s == "" {
			return nil
		}
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04:05.999999999Z0700"} {
			if v, err := time.Parse(layout, s); err == nil {
				t.Time = v.UTC()
				return nil
			}
		}
		// Some SDKs send numeric strings.
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			t.Time = unixFloat(f)
		}
		return nil
	}
	var f float64
	if err := json.Unmarshal(b, &f); err != nil {
		return err
	}
	t.Time = unixFloat(f)
	return nil
}

func unixFloat(f float64) time.Time {
	sec, frac := math.Modf(f)
	return time.Unix(int64(sec), int64(math.Round(frac*1e6))*1e3).UTC()
}

type sentrySession struct {
	SID               string   `json:"sid"`
	DID               string   `json:"did"`
	Init              bool     `json:"init"`
	Started           flexTime `json:"started"`
	Timestamp         flexTime `json:"timestamp"`
	Status            string   `json:"status"`
	Errors            int      `json:"errors"`
	Duration          *float64 `json:"duration"`
	AbnormalMechanism string   `json:"abnormal_mechanism"`
	Attrs             struct {
		Release     string `json:"release"`
		Environment string `json:"environment"`
	} `json:"attrs"`
}

type sentryEvent struct {
	EventID        string          `json:"event_id"`
	Type           string          `json:"type"`
	Timestamp      flexTime        `json:"timestamp"`
	StartTimestamp flexTime        `json:"start_timestamp"`
	Level          string          `json:"level"`
	Platform       string          `json:"platform"`
	Release        string          `json:"release"`
	Environment    string          `json:"environment"`
	Transaction    string          `json:"transaction"`
	Message        json.RawMessage `json:"message"`
	Logentry       *struct {
		Formatted string `json:"formatted"`
		Message   string `json:"message"`
	} `json:"logentry"`
	Exception exceptionList `json:"exception"`
	Tags      tagMap        `json:"tags"`
	DebugMeta *struct {
		Images []debugImage `json:"images"`
	} `json:"debug_meta"`
	Breadcrumbs  crumbList    `json:"breadcrumbs"`
	User         *sentryUser  `json:"user"`
	Contexts     contexts     `json:"contexts"`
	SDK          *SDKInfo     `json:"sdk"`
	Spans        []sentrySpan `json:"spans"`
	Measurements map[string]struct {
		Value float64 `json:"value"`
		Unit  string  `json:"unit"`
	} `json:"measurements"`
}

type sentryUser struct {
	ID string `json:"id"`
}

type contexts struct {
	Trace *traceContext `json:"trace"`
	OS    *struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"os"`
	Device  *deviceCtx `json:"device"`
	App     *appCtx    `json:"app"`
	Culture *struct {
		Locale string `json:"locale"`
	} `json:"culture"`
	Replay *struct {
		ReplayID string `json:"replay_id"`
	} `json:"replay"`
	// Feedback is the user feedback of a `feedback` item (Sentry.captureFeedback).
	Feedback *struct {
		Message           string `json:"message"`
		ContactEmail      string `json:"contact_email"`
		Name              string `json:"name"`
		ReplayID          string `json:"replay_id"`
		AssociatedEventID string `json:"associated_event_id"`
	} `json:"feedback"`
}

// userReport is the payload of the legacy `user_report` item
// (captureUserFeedback / SentrySDK.capture(userFeedback:)).
type userReport struct {
	EventID  string `json:"event_id"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	Comments string `json:"comments"`
}

// deviceCtx is contexts.device. Numbers and booleans stay `any`: SDKs differ
// in how they encode them.
type deviceCtx struct {
	Model          string `json:"model"`
	Locale         string `json:"locale"`
	ConnectionType string `json:"connection_type"`
	ThermalState   string `json:"thermal_state"`
	Orientation    string `json:"orientation"`
	FreeMemory     any    `json:"free_memory"`
	MemorySize     any    `json:"memory_size"`
	LowPowerMode   any    `json:"low_power_mode"`
	BatteryLevel   any    `json:"battery_level"`
	Charging       any    `json:"charging"`
	Simulator      any    `json:"simulator"`
}

// appCtx is contexts.app.
type appCtx struct {
	ViewNames    []string `json:"view_names"`
	InForeground any      `json:"in_foreground"`
	AppStartTime flexTime `json:"app_start_time"`
	AppMemory    any      `json:"app_memory"`
}

// tagMap accepts tags as an object or as a list of [key, value] pairs.
type tagMap map[string]string

func (m *tagMap) UnmarshalJSON(b []byte) error {
	out := tagMap{}
	var o map[string]any
	if json.Unmarshal(b, &o) == nil {
		for k, v := range o {
			out[k] = anyString(v)
		}
		*m = out
		return nil
	}
	var pairs [][]any
	if err := json.Unmarshal(b, &pairs); err != nil {
		return nil // tags are optional; never fail the event on them
	}
	for _, p := range pairs {
		if len(p) == 2 {
			out[anyString(p[0])] = anyString(p[1])
		}
	}
	*m = out
	return nil
}

type traceContext struct {
	TraceID      string         `json:"trace_id"`
	SpanID       string         `json:"span_id"`
	ParentSpanID string         `json:"parent_span_id"`
	Op           string         `json:"op"`
	Status       string         `json:"status"`
	Data         map[string]any `json:"data"`
}

type sentrySpan struct {
	TraceID        string         `json:"trace_id"`
	SpanID         string         `json:"span_id"`
	ParentSpanID   string         `json:"parent_span_id"`
	Op             string         `json:"op"`
	Description    string         `json:"description"`
	StartTimestamp flexTime       `json:"start_timestamp"`
	Timestamp      flexTime       `json:"timestamp"`
	Status         string         `json:"status"`
	Data           map[string]any `json:"data"`
}

type sentryException struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	Module    string `json:"module"`
	Mechanism *struct {
		Type      string `json:"type"`
		Handled   *bool  `json:"handled"`
		Synthetic bool   `json:"synthetic"`
	} `json:"mechanism"`
	Stacktrace *struct {
		Frames []sentryFrame `json:"frames"`
	} `json:"stacktrace"`
}

type sentryFrame struct {
	Function        string `json:"function"`
	Module          string `json:"module"`
	Filename        string `json:"filename"`
	AbsPath         string `json:"abs_path"`
	Package         string `json:"package"`
	InstructionAddr string `json:"instruction_addr"`
	ImageAddr       string `json:"image_addr"`
	Lineno          int    `json:"lineno"`
	Colno           int    `json:"colno"`
	InApp           *bool  `json:"in_app"`
}

// exceptionList accepts {"values": [...]} and the legacy bare array.
type exceptionList []sentryException

func (l *exceptionList) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '[' {
		var v []sentryException
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
		*l = v
		return nil
	}
	var v struct {
		Values []sentryException `json:"values"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*l = v.Values
	return nil
}

// eventCrumb is a breadcrumb attached to an event (the scope's last 100).
type eventCrumb struct {
	breadcrumb
	Timestamp flexTime `json:"timestamp"`
}

// crumbList accepts {"values": [...]} and the bare array (both SDKs observed
// with the array).
type crumbList []eventCrumb

func (l *crumbList) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	var v []eventCrumb
	if len(b) > 0 && b[0] == '[' {
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
	} else {
		var o struct {
			Values []eventCrumb `json:"values"`
		}
		if err := json.Unmarshal(b, &o); err != nil {
			return err
		}
		v = o.Values
	}
	for i := range v {
		v[i].at = v[i].Timestamp.Time
	}
	*l = v
	return nil
}

// messageText returns the event's message: logentry.formatted, logentry.message,
// or `message` as a string or {formatted|message} object.
func (e *sentryEvent) messageText() string {
	if e.Logentry != nil {
		if e.Logentry.Formatted != "" {
			return e.Logentry.Formatted
		}
		if e.Logentry.Message != "" {
			return e.Logentry.Message
		}
	}
	if len(e.Message) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(e.Message, &s) == nil {
		return s
	}
	var o struct {
		Formatted string `json:"formatted"`
		Message   string `json:"message"`
	}
	if json.Unmarshal(e.Message, &o) == nil {
		if o.Formatted != "" {
			return o.Formatted
		}
		return o.Message
	}
	return ""
}

// isError reports whether an event is an error (spec section 6): level error
// or fatal, or an exception the SDK did not make up. captureMessage with
// attachStacktrace (the React Native default) sends a synthetic exception
// with level info; Sentry does not count it in the session's errors.
func (e *sentryEvent) isError() bool {
	switch e.Level {
	case "error", "fatal":
		return true
	case "":
		return len(e.Exception) > 0
	}
	for _, v := range e.Exception {
		if v.Mechanism == nil || !v.Mechanism.Synthetic {
			return true
		}
	}
	return false
}

// renderStacktrace renders all exception values newest first, each with its
// frames from the top of the stack (Sentry orders frames oldest call first),
// capped at maxStacktraceBytes.
func renderStacktrace(values []sentryException) string {
	var b strings.Builder
	for i := len(values) - 1; i >= 0; i-- {
		v := values[i]
		if i < len(values)-1 {
			b.WriteString("Caused by: ")
		}
		b.WriteString(v.Type)
		if v.Value != "" {
			b.WriteString(": ")
			b.WriteString(v.Value)
		}
		b.WriteByte('\n')
		if v.Stacktrace != nil {
			fr := v.Stacktrace.Frames
			for j := len(fr) - 1; j >= 0; j-- {
				f := fr[j]
				fn := f.Function
				if fn == "" {
					fn = "?"
				}
				loc := f.Filename
				if loc == "" {
					loc = f.Module
				}
				if loc == "" && f.InstructionAddr != "" {
					loc = nativeLocation(f)
				}
				if loc == "" {
					loc = f.Package
				}
				b.WriteString("  at ")
				b.WriteString(fn)
				b.WriteString(" (")
				b.WriteString(loc)
				if f.Lineno > 0 {
					b.WriteString(":" + strconv.Itoa(f.Lineno))
					if f.Colno > 0 {
						b.WriteString(":" + strconv.Itoa(f.Colno))
					}
				}
				b.WriteString(")")
				if f.InApp != nil && *f.InApp {
					b.WriteString(" [in app]")
				}
				b.WriteByte('\n')
				if b.Len() > maxStacktraceBytes {
					break
				}
			}
		}
		if b.Len() > maxStacktraceBytes {
			break
		}
	}
	s := b.String()
	if len(s) > maxStacktraceBytes {
		s = s[:maxStacktraceBytes]
	}
	return strings.TrimRight(s, "\n")
}

const maxStacktraceBytes = 32 << 10

// nativeLocation renders an unsymbolicated native frame as Apple crash
// reports do, `<image> <address> <load address> + <offset>`, which is what
// atos needs with the image's dSYM (found by its debug id, A7).
func nativeLocation(f sentryFrame) string {
	name := path.Base(f.Package)
	if f.Package == "" {
		name = "?"
	}
	instr, err1 := strconv.ParseUint(strings.TrimPrefix(f.InstructionAddr, "0x"), 16, 64)
	image, err2 := strconv.ParseUint(strings.TrimPrefix(f.ImageAddr, "0x"), 16, 64)
	if err1 != nil || err2 != nil || image == 0 || instr < image {
		return name + " " + f.InstructionAddr
	}
	return name + " " + f.InstructionAddr + " 0x" + strconv.FormatUint(image, 16) + " + " + strconv.FormatUint(instr-image, 10)
}

// debugImage is one entry of an event's debug_meta.images: a loaded native
// image (macho, elf, pe) or a JavaScript source map.
type debugImage struct {
	Type        string `json:"type"`
	CodeFile    string `json:"code_file"`
	DebugID     string `json:"debug_id"`
	ImageAddr   string `json:"image_addr"`
	ImageVMAddr string `json:"image_vmaddr,omitempty"`
	ImageSize   int64  `json:"image_size,omitempty"`
	Arch        string `json:"arch,omitempty"`
}

const maxDebugImages = 64

// usedDebugImages returns the debug images the stack frames point into
// (native frames by image_addr, JavaScript frames by source file), with the
// image name instead of its path: enough to find the dSYM or source map.
func usedDebugImages(e *sentryEvent) []debugImage {
	if e.DebugMeta == nil || len(e.DebugMeta.Images) == 0 {
		return nil
	}
	addrs, files := map[string]bool{}, map[string]bool{}
	for _, v := range e.Exception {
		if v.Stacktrace == nil {
			continue
		}
		for _, f := range v.Stacktrace.Frames {
			if f.ImageAddr != "" {
				addrs[strings.ToLower(f.ImageAddr)] = true
			}
			if f.Filename != "" {
				files[f.Filename] = true
			}
		}
	}
	var out []debugImage
	for _, img := range e.DebugMeta.Images {
		if !addrs[strings.ToLower(img.ImageAddr)] && !files[img.CodeFile] {
			continue
		}
		if img.Type != "sourcemap" {
			img.CodeFile = path.Base(img.CodeFile)
		}
		out = append(out, img)
		if len(out) == maxDebugImages {
			break
		}
	}
	return out
}

// splitRelease splits `<package>@<version>+<build>` into version and build.
func splitRelease(release string) (version, build string) {
	v := release
	if i := strings.LastIndex(v, "@"); i >= 0 {
		v = v[i+1:]
	}
	if i := strings.Index(v, "+"); i >= 0 {
		return v[:i], v[i+1:]
	}
	return v, ""
}

// anyString renders a JSON value (string or number) as a string.
func anyString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		if x == math.Trunc(x) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case json.Number:
		return x.String()
	case bool:
		return strconv.FormatBool(x)
	}
	return ""
}
