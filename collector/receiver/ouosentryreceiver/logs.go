package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
)

// Sentry structured logs (`log` item, spec section 7a).
const (
	eventLog            = "log"
	maxLogAttributes    = 32
	maxLogAttributeLen  = 1024
	maxPendingLogs      = 20000
	attrLogTemplate     = "ouo.sentry.log.template"
	sentryAttrReplayID  = "sentry.replay_id"
	sentryAttrParentID  = "sentry.trace.parent_span_id"
	sentryAttrTemplate  = "sentry.message.template"
	sentryAttrUserID    = "user.id"
	sentryAttrOrigin    = "sentry.origin"
	originConsole       = "auto.log.console"
	sentryAttrNamespace = "sentry."
)

// sentryLog is one entry of a `log` item
// (content type application/vnd.sentry.items.log+json: {"items":[...]}).
type sentryLog struct {
	Timestamp      flexTime                   `json:"timestamp"`
	Level          string                     `json:"level"`
	Body           string                     `json:"body"`
	TraceID        string                     `json:"trace_id"`
	SeverityNumber int                        `json:"severity_number"`
	Attributes     map[string]sentryAttribute `json:"attributes"`
}

// sentryAttribute is a typed log attribute: {"value": ..., "type": "string"|"boolean"|"integer"|"double"}.
type sentryAttribute struct {
	Value json.RawMessage `json:"value"`
	Type  string          `json:"type"`
}

func (a sentryAttribute) str() string {
	var s string
	if json.Unmarshal(a.Value, &s) == nil {
		return s
	}
	return string(bytes.TrimSpace(a.Value))
}

// droppedLogAttribute reports attributes the bridge does not copy: the SDK's
// own `sentry.*` namespace (release, environment and SDK are on the resource),
// device and OS context (resource too) and user PII (spec section 12).
func droppedLogAttribute(k string) bool {
	switch {
	case strings.HasPrefix(k, sentryAttrNamespace),
		strings.HasPrefix(k, "device."), strings.HasPrefix(k, "os."),
		k == "user.email", k == "user.name", k == "user.ip_address", k == sentryAttrUserID:
		return true
	}
	return false
}

func decodeLogs(payload []byte) ([]sentryLog, error) {
	var c struct {
		Items []sentryLog `json:"items"`
	}
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, err
	}
	return c.Items, nil
}

func (l *sentryLog) attr(k string) string {
	if a, ok := l.Attributes[k]; ok {
		return a.str()
	}
	return ""
}

// resolveLog finds the session of a log entry (spec section 8): the replay id
// attribute (rule 2), the trace id (rule 4), the user id (rule 3), the
// session its client started around it (rule 5). Must hold the state lock.
func resolveLog(st *sessionState, project, origin string, l *sentryLog) (*sess, string) {
	at := l.Timestamp.Time
	if c := st.byReplayID(project, l.attr(sentryAttrReplayID)); c != nil && c.covers(at) {
		return c, matchReplay
	}
	if c := st.byTraceAt(project, normTraceID(l.TraceID), at); c != nil {
		return c, matchTrace
	}
	if c := st.byDeviceAt(project, l.attr(sentryAttrUserID), at); c != nil {
		return c, matchDevice
	}
	if c := st.byStart(project, origin, at); c != nil {
		return c, matchStart
	}
	return nil, matchNone
}

// emitLog maps one Sentry log entry to a `log` session event, or to a
// `console` event for captured console output. With a session, x must be the
// state's session and the lock held (console de-duplication).
func (t *translation) emitLog(l *sentryLog, x *sess, match string) {
	sev := plog.SeverityNumber(l.SeverityNumber)
	if sev < plog.SeverityNumberTrace || sev > plog.SeverityNumberFatal4 {
		sev = severityOfLevel(l.Level)
	}
	name := eventLog
	if l.attr(sentryAttrOrigin) == originConsole {
		name = eventConsole
		if x != nil && x.consoleSeen(l.Body, l.Timestamp.Time) {
			return // already on the timeline from the replay's breadcrumb
		}
	}
	lr := t.newRecord(name, l.Timestamp.Time, x, match, l.attr(sentryAttrUserID), sev)
	lr.SetSeverityText(strings.ToUpper(firstString(l.Level, "info")))
	lr.Body().SetStr(l.Body)
	a := lr.Attributes()
	a.PutStr("message", truncate(l.Body, maxLogAttributeLen))
	a.PutStr("ouo.sentry.level", l.Level)
	if origin := l.attr(sentryAttrOrigin); origin != "" {
		a.PutStr("ouo.sentry.origin", origin)
	}
	if tpl := l.attr(sentryAttrTemplate); tpl != "" {
		a.PutStr(attrLogTemplate, truncate(tpl, maxLogAttributeLen))
	}
	if id, ok := traceID(l.TraceID); ok {
		lr.SetTraceID(id)
		if sp, ok := spanID(l.attr(sentryAttrParentID)); ok {
			lr.SetSpanID(sp)
		}
	}
	n := 0
	for k, v := range l.Attributes {
		if droppedLogAttribute(k) || n >= maxLogAttributes {
			continue
		}
		if _, exists := a.Get(k); exists {
			continue // never override the session attributes
		}
		putTyped(a, k, v)
		n++
	}
}

func putTyped(a pcommon.Map, k string, v sentryAttribute) {
	switch v.Type {
	case "boolean":
		var b bool
		if json.Unmarshal(v.Value, &b) == nil {
			a.PutBool(k, b)
			return
		}
	case "integer":
		if i, err := strconv.ParseInt(strings.Trim(string(v.Value), `"`), 10, 64); err == nil {
			a.PutInt(k, i)
			return
		}
	case "double":
		var f float64
		if json.Unmarshal(v.Value, &f) == nil {
			a.PutDouble(k, f)
			return
		}
	}
	a.PutStr(k, truncate(v.str(), maxLogAttributeLen))
}

func severityOfLevel(level string) plog.SeverityNumber {
	switch strings.ToLower(level) {
	case "trace":
		return plog.SeverityNumberTrace
	case "debug":
		return plog.SeverityNumberDebug
	case "warn", "warning":
		return plog.SeverityNumberWarn
	case "error":
		return plog.SeverityNumberError
	case "fatal":
		return plog.SeverityNumberFatal
	}
	return plog.SeverityNumberInfo
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// normTraceID lowercases a trace id and strips dashes (Sentry trace ids are
// 32 hex characters; some SDKs send UUID form).
func normTraceID(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "-", ""))
}

// ---- held logs and user reports -------------------------------------------

// pendingLogs holds log entries whose session is not known yet: a log can
// arrive before the transaction or error that carries its trace id. It also
// holds `user_report` items whose error is not known yet, keyed by that
// error's event id (section 9c): a report can arrive before its error. Entries
// are emitted when their session becomes known, or without a session after
// the hold time.
type pendingLogs struct {
	mu      sync.Mutex
	entries []pendingLog
}

// pendingLog is a held log entry, or a held user report when report is set.
type pendingLog struct {
	group  *logGroup
	log    sentryLog
	report *userReport
	until  time.Time
}

// logGroup is what held logs of one envelope share.
type logGroup struct {
	j          job
	resource   pcommon.Map
	sdkName    string
	dev        deviceContext
	osFallback bool
}

// holdLogs holds the envelope's unresolved log entries and user reports.
func (r *sentryReceiver) holdLogs(ctx context.Context, t *translation, logs []sentryLog, reports []*userReport) {
	if len(logs) == 0 && len(reports) == 0 {
		return
	}
	hold := r.cfg.State.LogHold
	if hold <= 0 {
		hold = time.Minute
	}
	j := t.j
	j.body = nil // the envelope is translated; do not keep its bytes while logs wait
	g := &logGroup{j: j, resource: t.resource, sdkName: t.sdkName, dev: t.dev, osFallback: t.osFallback}
	until := time.Now().Add(hold)
	p := &r.pendingLogs
	p.mu.Lock()
	defer p.mu.Unlock()
	// Full: emit without a session rather than lose the entry.
	full := func() bool { return len(p.entries) >= maxPendingLogs }
	for i := range logs {
		if full() {
			t.emitLog(&logs[i], nil, matchNone)
			r.drop(ctx, t.j.project.OuoProjectID, "log_unresolved_overflow")
			continue
		}
		p.entries = append(p.entries, pendingLog{group: g, log: logs[i], until: until})
	}
	for _, u := range reports {
		if full() {
			t.emitUserReport(u, nil)
			r.drop(ctx, t.j.project.OuoProjectID, "user_report_unresolved_overflow")
			continue
		}
		p.entries = append(p.entries, pendingLog{group: g, report: u, until: until})
	}
}

// flushPendingLogs emits held logs and user reports whose session is known
// now, and the expired ones (or all of them with force) without a session.
func (r *sentryReceiver) flushPendingLogs(ctx context.Context, force bool) {
	p := &r.pendingLogs
	p.mu.Lock()
	if len(p.entries) == 0 {
		p.mu.Unlock()
		return
	}
	now := time.Now()
	byGroup := map[*logGroup]*translation{}
	var order []*translation
	emit := func(pl *pendingLog, x *sess, match string) {
		t := byGroup[pl.group]
		if t == nil {
			t = &translation{r: r, j: pl.group.j, resource: pl.group.resource, sdkName: pl.group.sdkName, dev: pl.group.dev, osFallback: pl.group.osFallback}
			byGroup[pl.group] = t
			order = append(order, t)
		}
		if pl.report != nil {
			t.emitUserReport(pl.report, x)
			return
		}
		t.emitLog(&pl.log, x, match)
	}
	var keep []pendingLog
	r.state.withLock(func() {
		for i := range p.entries {
			pl := &p.entries[i]
			project := pl.group.j.project.OuoProjectID
			// A report resolves by the error it names (rule event) at its
			// received time; a log entry by section 8 at its own time.
			x, match, at := (*sess)(nil), matchEvent, pl.group.j.receivedAt
			if pl.report != nil {
				x = r.state.byEventID(project, pl.report.EventID)
			} else {
				x, match = resolveLog(r.state, project, pl.group.j.originKey(), &pl.log)
				at = pl.log.Timestamp.Time
			}
			switch {
			case x != nil:
				r.state.touch(x, at)
				x.dev.merge(pl.group.dev)
				emit(pl, x, match)
			case force || now.After(pl.until):
				emit(pl, nil, matchNone)
			default:
				keep = append(keep, *pl)
			}
		}
	})
	p.entries = keep
	p.mu.Unlock()
	for _, t := range order {
		t.consume(ctx)
	}
}
