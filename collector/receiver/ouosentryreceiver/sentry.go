package ouosentryreceiver // import "github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver"

import (
	"bytes"
	"encoding/json"
	"math"
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
	Exception    exceptionList `json:"exception"`
	User         *sentryUser   `json:"user"`
	Contexts     contexts      `json:"contexts"`
	SDK          *SDKInfo      `json:"sdk"`
	Spans        []sentrySpan  `json:"spans"`
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
	Device *struct {
		Model string `json:"model"`
	} `json:"device"`
	Replay *struct {
		ReplayID string `json:"replay_id"`
	} `json:"replay"`
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
		Type    string `json:"type"`
		Handled *bool  `json:"handled"`
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
				if loc == "" {
					loc = f.Package
				}
				if loc == "" {
					loc = f.InstructionAddr
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
