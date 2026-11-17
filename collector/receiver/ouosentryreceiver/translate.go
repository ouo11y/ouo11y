package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.uber.org/zap"
)

// Attribute names (docs/specs/session-lifecycle.md, docs/specs/sentry-bridge.md).
const (
	attrEventName    = "event.name"
	attrSessionID    = "session.id"
	attrUserID       = "user.id"
	attrPlatform     = "ouo.platform"
	attrProjectID    = "ouo.project.id"
	attrSessionMatch = "ouo.sentry.session_match"
	attrSentrySDK    = "ouo.sentry.sdk"
	platformMobile   = "mobile"
	// attrRUMMode is the rollout cohort (examples/sentry-mobile/ROLLOUT.md): everything the
	// bridge translates was recorded by the Sentry SDK, so it is always "sentry". The ouo SDK
	// sets "parallel" or "ouo" itself.
	attrRUMMode        = "ouo.rum.mode"
	rumModeSentry      = "sentry"
	scopeName          = "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"
	maxSyntheticErrors = 100
)

// Session match rules (spec section 8).
const (
	matchEnvelope = "envelope"
	matchReplay   = "replay"
	matchDevice   = "device"
	matchTrace    = "trace"
	matchStart    = "start"
	matchEvent    = "event"
	matchNone     = "none"
)

// failedSpanStatuses are Sentry span statuses that mean the request did not
// get an HTTP answer (network failure), when no status code is recorded.
var failedSpanStatuses = map[string]bool{
	"internal_error": true, "unavailable": true, "deadline_exceeded": true,
	"unknown_error": true, "unknown": true, "aborted": true, "cancelled": false,
}

// projectAuth puts the ouo project into client.Info.Auth exactly like the
// basicauth extension does (`username`), so resource/project and ouoratelimit
// treat bridged telemetry like Basic-authenticated OTLP.
type projectAuth string

func (p projectAuth) GetAttribute(name string) any {
	if name == "username" {
		return string(p)
	}
	return nil
}

func (projectAuth) GetAttributeNames() []string { return []string{"username"} }

// decodedItem is one translatable item.
type decodedItem struct {
	typ     string
	session *sentrySession
	event   *sentryEvent
	replay  *replaySegment
	logs    []sentryLog
	report  *userReport
}

// translation accumulates the output of one envelope.
type translation struct {
	r        *sentryReceiver
	j        job
	env      *Envelope
	resource pcommon.Map // template, copied into logs and traces
	logs     plog.Logs
	lrs      plog.LogRecordSlice
	hasLogs  bool
	traces   ptrace.Traces
	spans    ptrace.SpanSlice
	hasSpans bool
	sdkName  string
	os       string // ios | android | ""
	// dev is the device and OS context the envelope itself carries; fill is
	// the one remembered for the session of its records (A3), applied to the
	// resource of what this translation emits.
	dev        deviceContext
	fill       *deviceContext
	osFallback bool // os.name on the resource comes from the SDK name, not the OS context
}

// translate turns one accepted envelope into ouo telemetry (spec sections 4 to 9).
func (r *sentryReceiver) translate(ctx context.Context, j job, env *Envelope) {
	t := &translation{r: r, j: j, env: env}
	items := t.decode(ctx)
	t.buildResource(items)

	// Sessions in this envelope, by sid.
	envSessions := map[string]*sentrySession{}
	var sessionOrder []*sentrySession
	for _, it := range items {
		if it.session != nil && it.session.SID != "" {
			envSessions[it.session.SID] = it.session
			sessionOrder = append(sessionOrder, it.session)
		}
	}
	envReplayID := traceReplayID(env.Header.Trace)

	var replays []*replaySegment
	var heldLogs []sentryLog
	var heldReports []*userReport
	r.state.withLock(func() {
		st := r.state
		project := j.project.OuoProjectID
		// Make every session of this envelope known first, so rules 1 and 3 see it.
		for _, s := range sessionOrder {
			x, created := st.upsert(project, s.SID, s.DID, firstTime(s.Started.Time, s.Timestamp.Time, j.receivedAt))
			if created && s.Init {
				x.seenInit = true
				st.setOrigin(x, j.originKey())
			}
		}

		// Errors and messages.
		for _, it := range items {
			if it.event == nil || it.typ != "event" {
				continue
			}
			x, match := t.resolve(st, envSessions, sessionOrder, it.event, envReplayID, true)
			t.emitEvent(it.event, x, match, envSessions)
		}
		// User feedback, after the errors it may name.
		for _, it := range items {
			switch {
			case it.typ == "feedback" && it.event != nil:
				t.emitFeedback(st, envSessions, sessionOrder, it.event, envReplayID)
			case it.report != nil && strings.TrimSpace(it.report.Comments) != "":
				// Its error is known: rule event, a report brings no context
				// to learn. Else held until the error arrives (section 9c).
				// An empty report is not translated and touches nothing.
				if x := st.byEventID(project, it.report.EventID); x != nil {
					st.touch(x, j.receivedAt)
					t.emitUserReport(it.report, x)
				} else {
					heldReports = append(heldReports, it.report)
				}
			}
		}
		// Transactions.
		for _, it := range items {
			if it.event == nil || it.typ != "transaction" {
				continue
			}
			x, match := t.resolve(st, envSessions, sessionOrder, it.event, envReplayID, false)
			t.emitTransaction(it.event, x, match, x != nil && t.hasReplay(st, x, envReplayID))
		}
		// Session updates last: the exceptions of this envelope are counted by now.
		for _, s := range sessionOrder {
			t.emitSession(st, s)
		}
		// Sentry logs: resolved through the state updated above, else held
		// until the error or transaction carrying their trace id arrives.
		for _, it := range items {
			for i := range it.logs {
				l := &it.logs[i]
				if x, match := resolveLog(st, project, j.originKey(), l); x != nil {
					st.touch(x, l.Timestamp.Time)
					x.dev.merge(t.dev)
					t.emitLog(l, x, match)
				} else {
					heldLogs = append(heldLogs, *l)
				}
			}
		}
		// Replay segments resolve against the state updated above.
		for _, it := range items {
			if it.replay != nil {
				replays = append(replays, it.replay)
			}
		}
	})

	r.holdLogs(ctx, t, heldLogs, heldReports)
	t.consume(ctx)
	for _, seg := range replays {
		seg.os = t.os
		seg.received = j.receivedAt
		seg.resource = t.resource
		seg.sdkName = t.sdkName
		r.handleReplay(ctx, j, seg)
	}
	// Sessions, replay ids, trace ids and event ids learned from this
	// envelope may resolve held segments, logs and user reports.
	r.flushPending(ctx)
	r.flushPendingLogs(ctx, false)
}

// decode parses the items the translator understands and counts all of them.
func (t *translation) decode(ctx context.Context) []decodedItem {
	var out []decodedItem
	for _, it := range t.env.Items {
		translated := true
		var d decodedItem
		d.typ = it.Type
		switch it.Type {
		case "session":
			var s sentrySession
			if json.Unmarshal(it.Payload, &s) == nil {
				d.session = &s
			} else {
				translated = false
			}
		case "user_report":
			var u userReport
			if json.Unmarshal(it.Payload, &u) == nil {
				d.report = &u
			} else {
				translated = false
			}
		case "event", "transaction", "feedback":
			var e sentryEvent
			if json.Unmarshal(it.Payload, &e) == nil {
				d.event = &e
			} else {
				translated = false
			}
		case "log":
			logs, err := decodeLogs(it.Payload)
			if err == nil {
				d.logs = logs
			} else {
				translated = false
			}
		case "replay_video":
			seg, err := decodeReplayVideo(it.Payload)
			if err == nil {
				d.replay = seg
			} else {
				translated = false
				t.r.set.Logger.Debug("replay_video item not decoded", zap.Error(err))
			}
		default:
			translated = false
		}
		t.r.items.Add(ctx, 1, metric.WithAttributes(
			attribute.String(attrProjectID, t.j.project.OuoProjectID),
			attribute.String("type", it.Type),
			attribute.Bool("translated", translated)))
		if translated {
			out = append(out, d)
		}
	}
	return out
}

// buildResource fills the resource template from the envelope (spec section 4).
func (t *translation) buildResource(items []decodedItem) {
	p := t.j.project
	release, environment, sdkVersion := "", "", t.env.Header.SDK.Version
	t.sdkName = t.env.Header.SDK.Name
	osName, osVersion, model, platformHint := "", "", "", ""
	for _, it := range items {
		if s := it.session; s != nil {
			release = firstString(release, s.Attrs.Release)
			environment = firstString(environment, s.Attrs.Environment)
		}
		if e := it.event; e != nil {
			release = firstString(release, e.Release)
			environment = firstString(environment, e.Environment)
			if e.SDK != nil {
				t.sdkName = firstString(t.sdkName, e.SDK.Name)
				sdkVersion = firstString(sdkVersion, e.SDK.Version)
			}
			if e.Contexts.OS != nil {
				osName = firstString(osName, e.Contexts.OS.Name)
				osVersion = firstString(osVersion, e.Contexts.OS.Version)
			}
			if e.Contexts.Device != nil {
				model = firstString(model, e.Contexts.Device.Model)
			}
		}
		if seg := it.replay; seg != nil {
			release = firstString(release, seg.event.Release)
			environment = firstString(environment, seg.event.Environment)
			if seg.event.SDK != nil {
				t.sdkName = firstString(t.sdkName, seg.event.SDK.Name)
			}
			if seg.event.Contexts.OS != nil {
				osName = firstString(osName, seg.event.Contexts.OS.Name)
			}
			// replay_event.platform is "cocoa" on iOS, "java" on Android.
			platformHint = firstString(platformHint, seg.event.Platform)
		}
		if e := it.event; e != nil {
			platformHint = firstString(platformHint, e.Platform)
		}
		// Sentry log entries carry release, environment, SDK, OS and device
		// as attributes (A2); a log-only envelope has nothing else.
		for i := range it.logs {
			l := &it.logs[i]
			release = firstString(release, l.attr("sentry.release"))
			environment = firstString(environment, l.attr("sentry.environment"))
			t.sdkName = firstString(t.sdkName, l.attr("sentry.sdk.name"))
			sdkVersion = firstString(sdkVersion, l.attr("sentry.sdk.version"))
			osName = firstString(osName, l.attr("os.name"))
			osVersion = firstString(osVersion, l.attr("os.version"))
			model = firstString(model, l.attr("device.model"))
		}
	}
	t.os = detectOS(t.sdkName, osName, platformHint)
	t.dev = deviceContext{osName: osName, osVersion: osVersion, model: model}

	res := pcommon.NewMap()
	res.PutStr("service.name", p.ServiceName)
	version, build := splitRelease(release)
	if version != "" {
		res.PutStr("service.version", version)
	}
	if build != "" {
		res.PutStr("ouo.app.build", build)
	}
	if release != "" {
		res.PutStr("ouo.sentry.release", release)
	}
	if environment != "" {
		res.PutStr("deployment.environment.name", environment)
	}
	res.PutStr(attrPlatform, platformMobile)
	res.PutStr(attrProjectID, p.OuoProjectID)
	res.PutStr(attrRUMMode, rumModeSentry)
	if osName != "" {
		res.PutStr("os.name", osName)
	} else if t.os != "" {
		res.PutStr("os.name", t.os)
		t.osFallback = true
	}
	if osVersion != "" {
		res.PutStr("os.version", osVersion)
	}
	if model != "" {
		res.PutStr("device.model.identifier", model)
	}
	if t.sdkName != "" {
		res.PutStr("telemetry.sdk.name", t.sdkName)
	}
	if sdkVersion != "" {
		res.PutStr("telemetry.sdk.version", sdkVersion)
	}
	t.resource = res
}

// resolve finds the session of an event or transaction (spec section 8).
func (t *translation) resolve(st *sessionState, envSessions map[string]*sentrySession, order []*sentrySession, e *sentryEvent, envReplayID string, isError bool) (*sess, string) {
	project := t.j.project.OuoProjectID
	replayID := envReplayID
	if e.Contexts.Replay != nil && e.Contexts.Replay.ReplayID != "" {
		replayID = e.Contexts.Replay.ReplayID
	}
	var x *sess
	match := matchNone
	switch {
	case len(order) == 1:
		x, match = st.get(project, order[0].SID), matchEnvelope
	case len(order) > 1 && isError:
		// The session whose error count moved owns the error.
		for _, s := range order {
			if c := st.get(project, s.SID); c != nil && (s.Errors > c.errorsSeen || s.Status == "crashed") {
				x, match = c, matchEnvelope
				break
			}
		}
	}
	if x == nil {
		// The replay id of a transaction can be stale: after a background
		// rotation the JS layer keeps sending the previous session's id in the
		// trace header for a while. Accept it only inside that session's window.
		if c := st.byReplayID(project, replayID); c != nil && c.covers(eventTime(e, t.j.receivedAt)) {
			x, match = c, matchReplay
		}
	}
	if x == nil && e.User != nil {
		if c := st.byDeviceAt(project, e.User.ID, eventTime(e, t.j.receivedAt)); c != nil {
			x, match = c, matchDevice
		}
	}
	var tid string
	if e.Contexts.Trace != nil {
		tid = normTraceID(e.Contexts.Trace.TraceID)
	}
	if x == nil {
		if c := st.byTraceAt(project, tid, eventTime(e, t.j.receivedAt)); c != nil {
			x, match = c, matchTrace
		}
	}
	if x == nil {
		return nil, matchNone
	}
	if match == matchEnvelope {
		st.learnReplay(x, replayID)
	}
	// Rule 4: later logs and transactions of this trace belong to this session.
	st.learnTrace(x, tid)
	x.dev.merge(t.dev)
	st.touch(x, eventTime(e, t.j.receivedAt))
	return x, match
}

func (t *translation) ensureLogs() {
	if t.hasLogs {
		return
	}
	t.hasLogs = true
	t.logs = plog.NewLogs()
	rl := t.logs.ResourceLogs().AppendEmpty()
	t.resource.CopyTo(rl.Resource().Attributes())
	sl := rl.ScopeLogs().AppendEmpty()
	sl.Scope().SetName(scopeName)
	t.lrs = sl.LogRecords()
}

func (t *translation) ensureTraces() {
	if t.hasSpans {
		return
	}
	t.hasSpans = true
	t.traces = ptrace.NewTraces()
	rs := t.traces.ResourceSpans().AppendEmpty()
	t.resource.CopyTo(rs.Resource().Attributes())
	ss := rs.ScopeSpans().AppendEmpty()
	ss.Scope().SetName(scopeName)
	t.spans = ss.Spans()
}

// newRecord appends a session event log record with the common attributes.
func (t *translation) newRecord(name string, ts time.Time, x *sess, match, userID string, sev plog.SeverityNumber) plog.LogRecord {
	t.ensureLogs()
	lr := t.lrs.AppendEmpty()
	if ts.IsZero() {
		ts = t.j.receivedAt
	}
	lr.SetTimestamp(pcommon.NewTimestampFromTime(ts))
	lr.SetObservedTimestamp(pcommon.NewTimestampFromTime(t.j.receivedAt))
	lr.SetEventName(name)
	lr.SetSeverityNumber(sev)
	lr.SetSeverityText(map[plog.SeverityNumber]string{plog.SeverityNumberTrace: "TRACE", plog.SeverityNumberDebug: "DEBUG", plog.SeverityNumberInfo: "INFO", plog.SeverityNumberWarn: "WARN", plog.SeverityNumberError: "ERROR", plog.SeverityNumberFatal: "FATAL"}[sev])
	lr.Body().SetStr(name)
	a := lr.Attributes()
	a.PutStr(attrEventName, name)
	a.PutStr(attrPlatform, platformMobile)
	if x != nil {
		a.PutStr(attrSessionID, x.sid)
		if userID == "" {
			userID = x.did
		}
		t.noteSession(x)
	}
	if userID != "" {
		a.PutStr(attrUserID, userID)
	}
	a.PutStr(attrSessionMatch, match)
	if t.sdkName != "" {
		a.PutStr(attrSentrySDK, t.sdkName)
	}
	return lr
}

// emitEvent maps an `event` item (spec section 6).
func (t *translation) emitEvent(e *sentryEvent, x *sess, match string, envSessions map[string]*sentrySession) {
	userID := ""
	if e.User != nil {
		userID = e.User.ID
	}
	ts := eventTime(e, t.j.receivedAt)
	if x != nil {
		replayID := ""
		if e.Contexts.Replay != nil {
			replayID = e.Contexts.Replay.ReplayID
		}
		defer t.emitEventBreadcrumbs(e, x, match, x.replayID != "" || replayID != "")
		// A user report or feedback names the event it is about (section 9c).
		t.r.state.learnEvent(x, e.EventID)
	}
	if !e.isError() {
		lr := t.newRecord("sentry.message", ts, x, match, userID, plog.SeverityNumberInfo)
		lr.Attributes().PutBool("ouo.event.custom", true)
		lr.Attributes().PutStr("ouo.sentry.level", e.Level)
		lr.Attributes().PutStr("ouo.sentry.event_id", e.EventID)
		t.putErrorContext(lr.Attributes(), e)
		if msg := e.messageText(); msg != "" {
			lr.Body().SetStr(msg)
			lr.Attributes().PutStr("message", msg)
		}
		t.setTraceContext(lr, e.Contexts.Trace)
		return
	}
	fatal := e.Level == "fatal"
	if x != nil {
		if s := envSessions[x.sid]; s != nil && s.Status == "crashed" {
			fatal = true
		}
	}
	sev := plog.SeverityNumberError
	if fatal {
		sev = plog.SeverityNumberFatal
	}
	lr := t.newRecord("exception", ts, x, match, userID, sev)
	a := lr.Attributes()
	excType, excMsg, handled, mechanism := "Message", e.messageText(), true, ""
	if n := len(e.Exception); n > 0 {
		last := e.Exception[n-1]
		excType, excMsg = firstString(last.Type, "Error"), last.Value
		if last.Mechanism != nil {
			mechanism = last.Mechanism.Type
			if last.Mechanism.Handled != nil {
				handled = *last.Mechanism.Handled
			}
		}
		if st := renderStacktrace(e.Exception); st != "" {
			a.PutStr("exception.stacktrace", st)
		}
		if imgs := usedDebugImages(e); len(imgs) > 0 {
			b, _ := json.Marshal(imgs)
			a.PutStr("ouo.sentry.debug_images", string(b))
		}
	}
	a.PutStr("exception.type", excType)
	a.PutStr("exception.message", excMsg)
	a.PutBool("ouo.exception.fatal", fatal)
	a.PutBool("ouo.exception.handled", handled)
	if mechanism != "" {
		a.PutStr("ouo.sentry.mechanism", mechanism)
	}
	a.PutStr("ouo.sentry.event_id", e.EventID)
	a.PutStr("ouo.sentry.level", e.Level)
	t.putErrorContext(a, e)
	if excMsg != "" {
		lr.Body().SetStr(excType + ": " + excMsg)
	} else {
		lr.Body().SetStr(excType)
	}
	t.setTraceContext(lr, e.Contexts.Trace)
	if x != nil {
		x.exceptionsEmitted++
		if fatal && (x.fatalAt.IsZero() || ts.Before(x.fatalAt)) {
			x.fatalAt = ts
		}
	}
}

// Error context allowlist (spec section 6a, A6).
const (
	maxTags       = 32
	attrTagPrefix = "ouo.sentry.tag."
)

// connectionTypes maps contexts.device.connection_type to the semantic
// conventions' network.connection.type.
var connectionTypes = map[string]string{"wifi": "wifi", "cellular": "cell", "cell": "cell", "wired": "wired", "ethernet": "wired", "none": "unavailable", "offline": "unavailable"}

// putErrorContext copies the allowlisted device and app context of an error:
// what the device and app were doing when it happened. Device model and OS
// are on the resource.
func (t *translation) putErrorContext(a pcommon.Map, e *sentryEvent) {
	putStr := func(k, v string) {
		if v != "" {
			a.PutStr(k, truncate(v, maxLogAttributeLen))
		}
	}
	putInt := func(k string, v any) {
		if f, ok := v.(float64); ok {
			a.PutInt(k, int64(f))
		}
	}
	putBool := func(k string, v any) {
		if b, ok := v.(bool); ok {
			a.PutBool(k, b)
		}
	}
	if d := e.Contexts.Device; d != nil {
		putStr("ouo.device.locale", d.Locale)
		if c := strings.ToLower(d.ConnectionType); c != "" {
			putStr("network.connection.type", firstString(connectionTypes[c], c))
		}
		putStr("ouo.device.thermal_state", d.ThermalState)
		putStr("ouo.device.orientation", d.Orientation)
		putInt("ouo.device.free_memory", d.FreeMemory)
		putInt("ouo.device.memory_size", d.MemorySize)
		putBool("ouo.device.low_power_mode", d.LowPowerMode)
		if f, ok := d.BatteryLevel.(float64); ok {
			a.PutDouble("ouo.device.battery_level", f)
		}
		putBool("ouo.device.charging", d.Charging)
		putBool("ouo.device.simulator", d.Simulator)
	}
	if c := e.Contexts.Culture; c != nil && !hasKey(a, "ouo.device.locale") {
		putStr("ouo.device.locale", c.Locale)
	}
	if app := e.Contexts.App; app != nil {
		if n := len(app.ViewNames); n > 0 {
			putStr("ouo.app.screen", app.ViewNames[n-1])
		}
		putBool("ouo.app.in_foreground", app.InForeground)
		if !app.AppStartTime.IsZero() {
			a.PutInt("ouo.app.start_time", app.AppStartTime.UnixMilli())
		}
		putInt("ouo.app.memory", app.AppMemory)
	}
	if t.j.project != nil && t.j.project.CopyTags && len(e.Tags) > 0 {
		keys := make([]string, 0, len(e.Tags))
		for k := range e.Tags {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for i, k := range keys {
			if i >= maxTags {
				break
			}
			putStr(attrTagPrefix+k, e.Tags[k])
		}
	}
}

func hasKey(m pcommon.Map, k string) bool {
	_, ok := m.Get(k)
	return ok
}

func (t *translation) setTraceContext(lr plog.LogRecord, tc *traceContext) {
	if tc == nil {
		return
	}
	if id, ok := traceID(tc.TraceID); ok {
		lr.SetTraceID(id)
	}
	if id, ok := spanID(tc.SpanID); ok {
		lr.SetSpanID(id)
	}
}

// emitSession maps a `session` item (spec section 5).
func (t *translation) emitSession(st *sessionState, s *sentrySession) {
	x := st.get(t.j.project.OuoProjectID, s.SID)
	if x == nil {
		return
	}
	updatedAt := firstTime(s.Timestamp.Time, t.j.receivedAt)
	st.touch(x, updatedAt)
	if s.Init && !x.startEmitted {
		started := firstTime(s.Started.Time, updatedAt)
		lr := t.newRecord("session.start", started, x, matchEnvelope, s.DID, plog.SeverityNumberInfo)
		lr.Attributes().PutInt("ouo.session.started_at", started.UnixMilli())
		if x.previousID != "" {
			lr.Attributes().PutStr("session.previous_id", x.previousID)
		}
		x.startEmitted = true
	}

	// Errors Sentry counted without an event the bridge saw (sampled out,
	// dropped by beforeSend): synthetic exceptions keep ADR-0004 in line.
	// seenInit means the bridge has a trustworthy baseline for the counter.
	if !x.seenInit {
		// First seen mid-session (bridge restart): take the counter as the
		// baseline instead of backfilling errors from before the restart.
		if s.Errors > x.exceptionsEmitted {
			x.exceptionsEmitted = s.Errors
		}
		x.seenInit = true
	} else {
		missing := s.Errors - x.exceptionsEmitted
		if s.Status == "crashed" && missing > 0 {
			missing-- // the crash itself; session.end reason crash classifies it
		}
		for i := 0; i < missing && i < maxSyntheticErrors; i++ {
			lr := t.newRecord("exception", updatedAt, x, matchEnvelope, s.DID, plog.SeverityNumberError)
			a := lr.Attributes()
			a.PutStr("exception.type", "sentry.unsampled_error")
			a.PutStr("exception.message", "")
			a.PutBool("ouo.exception.fatal", false)
			a.PutBool("ouo.exception.handled", true)
			a.PutBool("ouo.sentry.synthetic", true)
			x.exceptionsEmitted++
		}
	}
	if s.Errors > x.errorsSeen {
		x.errorsSeen = s.Errors
	}

	reason := map[string]string{"exited": "background", "crashed": "crash", "abnormal": "terminated"}[s.Status]
	if reason == "" || x.endEmitted {
		return
	}
	endAt := updatedAt
	switch {
	case s.Status == "crashed" && !x.fatalAt.IsZero() && x.fatalAt.Before(endAt):
		// Reported on the next launch: the session ended when it crashed.
		endAt = x.fatalAt
	case s.Status == "abnormal" && x.lastEvent.After(endAt):
		// Sent on the next launch with timestamp == started: the last thing the
		// bridge saw is the best end time available.
		endAt = x.lastEvent
	}
	lr := t.newRecord("session.end", endAt, x, matchEnvelope, s.DID, plog.SeverityNumberInfo)
	a := lr.Attributes()
	a.PutStr("ouo.session.end_reason", reason)
	dur := endAt.Sub(x.started).Milliseconds()
	if s.Duration != nil && *s.Duration > 0 {
		dur = int64(*s.Duration * 1000)
	}
	a.PutInt("ouo.session.duration_ms", dur)
	a.PutStr("ouo.sentry.session.status", s.Status)
	a.PutInt("ouo.sentry.session.errors", int64(s.Errors))
	if s.AbnormalMechanism != "" {
		a.PutStr("ouo.sentry.abnormal_mechanism", s.AbnormalMechanism)
	}
	if x.previousID != "" {
		a.PutStr("session.previous_id", x.previousID)
	}
	x.endEmitted = true
}

// emitTransaction maps a `transaction` item to spans plus derived records (spec section 7).
func (t *translation) emitTransaction(e *sentryEvent, x *sess, match string, withReplay bool) {
	tc := e.Contexts.Trace
	if tc == nil {
		return
	}
	tid, ok := traceID(tc.TraceID)
	if !ok {
		return
	}
	userID := ""
	if e.User != nil {
		userID = e.User.ID
	}
	if userID == "" && x != nil {
		userID = x.did
	}
	t.ensureTraces()
	start, end := e.StartTimestamp.Time, e.Timestamp.Time
	root := t.spans.AppendEmpty()
	root.SetTraceID(tid)
	if id, ok := spanID(tc.SpanID); ok {
		root.SetSpanID(id)
	}
	if id, ok := spanID(tc.ParentSpanID); ok {
		root.SetParentSpanID(id)
	}
	root.SetName(firstString(e.Transaction, tc.Op, "transaction"))
	root.SetKind(ptrace.SpanKindInternal)
	root.SetStartTimestamp(pcommon.NewTimestampFromTime(start))
	root.SetEndTimestamp(pcommon.NewTimestampFromTime(end))
	setSpanStatus(root.Status(), tc.Status)
	ra := root.Attributes()
	t.sessionSpanAttrs(ra, x, match, userID)
	if tc.Op != "" {
		ra.PutStr("sentry.op", tc.Op)
	}
	for name, m := range e.Measurements {
		ra.PutDouble("ouo.sentry.measurement."+name, m.Value)
		if m.Unit != "" {
			ra.PutStr("ouo.sentry.measurement."+name+".unit", m.Unit)
		}
	}

	// Screen loads and React Navigation transactions are navigations, unless
	// the screen change is on the timeline already from its breadcrumb.
	screen := firstString(e.Transaction, "unknown")
	if (tc.Op == "ui.load" || tc.Op == "navigation") && (x == nil || !x.navSeen(screen, start, false)) {
		lr := t.newRecord("navigation", start, x, match, userID, plog.SeverityNumberInfo)
		a := lr.Attributes()
		a.PutStr("url.path", screen)
		a.PutStr("ouo.navigation.kind", "screen")
		a.PutStr("ouo.navigation.source", "transaction")
		if x != nil {
			if x.lastScreen != "" && x.lastScreen != screen {
				a.PutStr("ouo.navigation.from", x.lastScreen)
			}
			x.lastScreen = screen
		}
		lr.SetTraceID(tid)
		lr.SetSpanID(root.SpanID())
	}
	vitalScreen := screen
	if tc.Op != "ui.load" && tc.Op != "navigation" {
		vitalScreen = ""
		if x != nil {
			vitalScreen = x.lastScreen
		}
	}
	t.emitVitals(e, x, match, userID, tid, root.SpanID(), vitalScreen)

	for _, sp := range e.Spans {
		span := t.spans.AppendEmpty()
		span.SetTraceID(tid)
		if id, ok := traceID(sp.TraceID); ok {
			span.SetTraceID(id)
		}
		if id, ok := spanID(sp.SpanID); ok {
			span.SetSpanID(id)
		}
		if id, ok := spanID(sp.ParentSpanID); ok {
			span.SetParentSpanID(id)
		}
		span.SetName(firstString(sp.Description, sp.Op, "span"))
		span.SetStartTimestamp(pcommon.NewTimestampFromTime(sp.StartTimestamp.Time))
		span.SetEndTimestamp(pcommon.NewTimestampFromTime(firstTime(sp.Timestamp.Time, sp.StartTimestamp.Time)))
		setSpanStatus(span.Status(), sp.Status)
		sa := span.Attributes()
		t.sessionSpanAttrs(sa, x, match, userID)
		if sp.Op != "" {
			sa.PutStr("sentry.op", sp.Op)
		}
		if !strings.HasPrefix(sp.Op, "http.client") {
			span.SetKind(ptrace.SpanKindInternal)
			continue
		}
		span.SetKind(ptrace.SpanKindClient)
		method, fullURL, code := httpFields(sp)
		// Semantic conventions: a client span is named by its method only, so
		// span metrics do not get one series per URL.
		span.SetName(firstString(method, "HTTP"))
		if method != "" {
			sa.PutStr("http.request.method", method)
		}
		if fullURL != "" {
			sa.PutStr("url.full", fullURL)
			putURLParts(sa, fullURL)
		}
		if code > 0 {
			sa.PutInt("http.response.status_code", int64(code))
		}
		if code > 0 && code < 500 && !withReplay && x != nil && !x.httpSeen(sp.SpanID) {
			// A session without a replay has no fetch breadcrumbs from the
			// recording: answered requests come from their spans (A8).
			lr := t.newRecord(eventHTTPRequest, firstTime(sp.Timestamp.Time, sp.StartTimestamp.Time), x, match, userID, plog.SeverityNumberInfo)
			a := lr.Attributes()
			if method != "" {
				a.PutStr("http.request.method", method)
			}
			if fullURL != "" {
				a.PutStr("url.full", truncate(fullURL, maxLogAttributeLen))
			}
			a.PutInt("http.response.status_code", int64(code))
			lr.Body().SetStr(strings.TrimSpace(method + " " + fullURL))
			lr.SetTraceID(tid)
			lr.SetSpanID(span.SpanID())
		}
		if code >= 500 || (code == 0 && failedSpanStatuses[sp.Status]) {
			// ERROR, as the ouo SDKs emit it (sdk/react-native/src/network.ts).
			lr := t.newRecord("http.request.failed", firstTime(sp.Timestamp.Time, sp.StartTimestamp.Time), x, match, userID, plog.SeverityNumberError)
			a := lr.Attributes()
			if method != "" {
				a.PutStr("http.request.method", method)
			}
			if fullURL != "" {
				a.PutStr("url.full", fullURL)
			}
			if code > 0 {
				a.PutInt("http.response.status_code", int64(code))
			}
			if sp.Status != "" {
				a.PutStr("ouo.sentry.span_status", sp.Status)
			}
			lr.SetTraceID(tid)
			lr.SetSpanID(span.SpanID())
		}
	}
}

// hasReplay reports whether a transaction's session records a replay, whose
// breadcrumbs then carry its requests. A replay id in the trace header that
// another session owns is stale (kept across a background rotation); one not
// resolved yet is taken as this session's. Must hold the lock.
func (t *translation) hasReplay(st *sessionState, x *sess, replayID string) bool {
	if x.replayID != "" {
		return true
	}
	if replayID == "" {
		return false
	}
	owner := st.byReplayID(t.j.project.OuoProjectID, replayID)
	return owner == nil || owner == x
}

func (t *translation) sessionSpanAttrs(a pcommon.Map, x *sess, match, userID string) {
	if x != nil {
		a.PutStr(attrSessionID, x.sid)
		t.noteSession(x)
	}
	if userID != "" {
		a.PutStr(attrUserID, userID)
	}
	a.PutStr(attrPlatform, platformMobile)
	a.PutStr(attrSessionMatch, match)
}

// consume hands the logs and traces to the pipelines with the project in the
// client auth context.
func (t *translation) consume(ctx context.Context) {
	logsNext, tracesNext := t.r.consumers()
	cctx := client.NewContext(ctx, t.j.clientInfo())
	if t.hasLogs {
		t.applyDevice(t.logs.ResourceLogs().At(0).Resource().Attributes())
	}
	if t.hasSpans {
		t.applyDevice(t.traces.ResourceSpans().At(0).Resource().Attributes())
	}
	if t.hasLogs && logsNext != nil {
		if err := logsNext.ConsumeLogs(cctx, t.logs); err != nil {
			t.r.drop(ctx, t.j.project.OuoProjectID, "consumer_logs")
			t.r.set.Logger.Debug("translated logs rejected by the pipeline", zap.Error(err))
		}
	}
	if t.hasSpans && tracesNext != nil {
		if err := tracesNext.ConsumeTraces(cctx, t.traces); err != nil {
			t.r.drop(ctx, t.j.project.OuoProjectID, "consumer_traces")
			t.r.set.Logger.Debug("translated traces rejected by the pipeline", zap.Error(err))
		}
	}
}

// noteSession remembers the device context of the first session this
// translation emits a record for. Must hold the state lock.
func (t *translation) noteSession(x *sess) {
	if t.fill != nil {
		return
	}
	if d := t.r.state.deviceOf(x); !d.empty() {
		t.fill = &d
	}
}

// applyDevice completes an emitted resource with the device and OS context
// remembered for the session (A3): session-only, replay and log envelopes
// carry none or part of it themselves.
func (t *translation) applyDevice(res pcommon.Map) {
	if t.fill == nil {
		return
	}
	if _, ok := res.Get("os.name"); t.fill.osName != "" && (t.osFallback || !ok) {
		res.PutStr("os.name", t.fill.osName)
	}
	for k, v := range map[string]string{"os.version": t.fill.osVersion, "device.model.identifier": t.fill.model} {
		if _, ok := res.Get(k); !ok && v != "" {
			res.PutStr(k, v)
		}
	}
}

// ---- helpers ------------------------------------------------------------------

func setSpanStatus(s ptrace.Status, sentryStatus string) {
	switch sentryStatus {
	case "", "ok":
		s.SetCode(ptrace.StatusCodeUnset)
	default:
		s.SetCode(ptrace.StatusCodeError)
		s.SetMessage(sentryStatus)
	}
}

// httpFields reads method, URL and status code from a Sentry http.client span
// (cocoa: http.request.method / url / http.response.status_code; JS: http.method,
// url, http.response.status_code, status_code; description "GET https://...").
func httpFields(sp sentrySpan) (method, fullURL string, code int) {
	d := sp.Data
	method = firstString(anyString(d["http.request.method"]), anyString(d["http.method"]), anyString(d["method"]))
	fullURL = firstString(anyString(d["fullURL"]), anyString(d["url.full"]), anyString(d["http.fullURL"]))
	if desc := strings.Fields(sp.Description); len(desc) == 2 {
		method = firstString(method, desc[0])
		fullURL = firstString(fullURL, desc[1])
	}
	for _, k := range []string{"http.response.status_code", "status_code", "http.status_code"} {
		if c, err := strconv.Atoi(anyString(d[k])); err == nil && c > 0 {
			code = c
			break
		}
	}
	return method, fullURL, code
}

// putURLParts adds server.address, server.port, url.scheme and url.path from
// an absolute URL, as the ouo SDKs do (port defaults to 80 / 443 by scheme).
func putURLParts(a pcommon.Map, raw string) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return
	}
	scheme := strings.ToLower(u.Scheme)
	a.PutStr("server.address", u.Hostname())
	port, _ := strconv.Atoi(u.Port())
	if port == 0 {
		port = map[string]int{"http": 80, "https": 443}[scheme]
	}
	if port > 0 {
		a.PutInt("server.port", int64(port))
	}
	a.PutStr("url.scheme", scheme)
	a.PutStr("url.path", firstString(u.EscapedPath(), "/"))
}

func traceID(s string) (pcommon.TraceID, bool) {
	var id pcommon.TraceID
	b, err := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	if err != nil || len(b) != 16 {
		return id, false
	}
	copy(id[:], b)
	return id, !id.IsEmpty()
}

func spanID(s string) (pcommon.SpanID, bool) {
	var id pcommon.SpanID
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 8 {
		return id, false
	}
	copy(id[:], b)
	return id, !id.IsEmpty()
}

// traceReplayID reads replay_id from the envelope `trace` header (DSC).
func traceReplayID(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var dsc struct {
		ReplayID string `json:"replay_id"`
	}
	_ = json.Unmarshal(raw, &dsc)
	return dsc.ReplayID
}

func eventTime(e *sentryEvent, fallback time.Time) time.Time {
	return firstTime(e.Timestamp.Time, e.StartTimestamp.Time, fallback)
}

func firstTime(ts ...time.Time) time.Time {
	for _, t := range ts {
		if !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}

func firstString(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

func detectOS(sdkName, osName, platform string) string {
	o := strings.ToLower(osName)
	switch {
	case strings.Contains(o, "ios") || strings.Contains(o, "ipados"):
		return "ios"
	case strings.Contains(o, "android"):
		return "android"
	}
	p := strings.ToLower(platform)
	n := strings.ToLower(sdkName)
	switch {
	case p == "cocoa" || strings.Contains(n, "cocoa"):
		return "ios"
	case p == "java" || p == "android" || strings.Contains(n, "android") ||
		(strings.HasPrefix(n, "sentry.java") && !strings.HasPrefix(n, "sentry.javascript")):
		return "android"
	}
	return o
}
