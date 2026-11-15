package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"sort"
	"strings"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
)

// Timeline events derived from the breadcrumbs of replay recordings (spec
// section 9a). Each breadcrumb is in exactly one segment, so every one becomes
// one record; retried segments produce identical records, which readers
// de-duplicates.
const (
	eventHTTPRequest   = "http.request"
	eventConsole       = "console"
	eventAppLifecycle  = "app.lifecycle"
	eventUITap         = "ui.tap"
	eventBreadcrumb    = "breadcrumb"
	maxBreadcrumbData  = 16
	attrBreadcrumbCat  = "ouo.breadcrumb.category"
	attrBreadcrumbData = "ouo.breadcrumb.data."
)

// breadcrumb is the payload of an rrweb custom event with tag "breadcrumb".
type breadcrumb struct {
	Category string         `json:"category"`
	Message  string         `json:"message"`
	Level    string         `json:"level"`
	Type     string         `json:"type"`
	Data     map[string]any `json:"data"`
	at       time.Time
}

// skippedBreadcrumbs duplicate what other items already produce: the SDK's
// own transaction and event notes.
var skippedBreadcrumbs = map[string]bool{
	"sentry.transaction": true, "sentry.event": true,
}

func (r *sentryReceiver) emitBreadcrumbs(ctx context.Context, j job, seg *replaySegment, sid string) {
	if len(seg.breadcrumbs) == 0 {
		return
	}
	resource := seg.resource
	if resource == (pcommon.Map{}) {
		resource = pcommon.NewMap()
		resource.PutStr("service.name", j.project.ServiceName)
		resource.PutStr(attrPlatform, platformMobile)
		resource.PutStr(attrProjectID, j.project.OuoProjectID)
		resource.PutStr(attrRUMMode, rumModeSentry)
	}
	t := &translation{r: r, j: j, resource: resource, sdkName: seg.sdkName}
	did := ""
	if seg.event.User != nil {
		did = string(seg.event.User.ID)
	}
	r.state.withLock(func() {
		x := r.state.get(j.project.OuoProjectID, sid)
		if x == nil {
			x = &sess{sid: sid, did: did, project: j.project.OuoProjectID} // evicted meanwhile: no de-duplication
		}
		for i := range seg.breadcrumbs {
			t.emitBreadcrumb(&seg.breadcrumbs[i], x, matchReplay)
		}
	})
	t.consume(ctx)
}

// eventOnlySkipped are event breadcrumbs the replay recordings do not carry
// and that add nothing to the timeline: React Navigation's dispatch notes (the
// `navigation` breadcrumb follows), UIKit view controller events (native
// containers such as RNSScreen in a React Native app) and the SDK start note.
var eventOnlySkipped = map[string]bool{
	"navigation.dispatch": true, "ui.lifecycle": true, "started": true,
}

// crumbSessionSkew: an event's breadcrumbs reach back into earlier sessions
// (the scope keeps them across a background rotation); only those from the
// session's start on belong to it. A new session starts at least 30 s after
// the previous one went to the background.
const crumbSessionSkew = 5 * time.Second

// emitEventBreadcrumbs turns the breadcrumbs attached to an event into
// session events (A8, spec section 9b). Sessions with a replay get them from
// the recording, except navigation, which recordings rarely carry (A11).
// Must hold the state lock.
func (t *translation) emitEventBreadcrumbs(e *sentryEvent, x *sess, match string, withReplay bool) {
	if x == nil || len(e.Breadcrumbs) == 0 {
		return
	}
	from, until := x.started.Add(-crumbSessionSkew), eventTime(e, t.j.receivedAt).Add(crumbCopyWindow)
	for i := range e.Breadcrumbs {
		b := &e.Breadcrumbs[i].breadcrumb
		if b.at.IsZero() || b.at.Before(from) || b.at.After(until) || eventOnlySkipped[b.Category] || skippedBreadcrumbs[b.Category] {
			continue
		}
		if b.Category != "navigation" {
			if withReplay || x.eventCrumbSeen(crumbKey(b), b.at, e.EventID) {
				continue
			}
		}
		t.emitBreadcrumb(b, x, match)
	}
}

// crumbKey identifies a breadcrumb's content (category, message, data).
func crumbKey(b *breadcrumb) uint64 {
	h := fnv.New64a()
	h.Write([]byte(b.Category))
	h.Write([]byte{0})
	h.Write([]byte(b.Message))
	h.Write([]byte{0})
	data, _ := json.Marshal(b.Data) // map keys sorted
	h.Write(data)
	return h.Sum64()
}

// emitBreadcrumb must run under the state lock (console de-duplication).
func (t *translation) emitBreadcrumb(b *breadcrumb, x *sess, match string) {
	cat := b.Category
	switch {
	case skippedBreadcrumbs[cat]:
		return
	case cat == "navigation":
		// React Navigation {from, to}. The RN SDK drops the transaction of a
		// back navigation without spans, so this is the only trace of it (A11).
		// sentry-cocoa's replay copy of a view controller event reads
		// {to: <class>} with the class as message: native containers in a
		// React Native app, covered by ui.load transactions in a native one.
		screen := anyString(b.Data["to"])
		if screen == "" || screen == b.Message || x.navSeen(screen, b.at, true) {
			return
		}
		lr := t.newRecord("navigation", b.at, x, match, "", plog.SeverityNumberInfo)
		a := lr.Attributes()
		a.PutStr("url.path", screen)
		a.PutStr("ouo.navigation.kind", "screen")
		a.PutStr("ouo.navigation.source", "breadcrumb")
		if from := firstString(anyString(b.Data["from"]), x.lastScreen); from != "" && from != screen {
			a.PutStr("ouo.navigation.from", from)
		}
		x.lastScreen = screen
	case cat == "fetch" || cat == "xhr" || cat == "http":
		method := anyString(b.Data["method"])
		url := firstString(anyString(b.Data["url"]), anyString(b.Data["url.full"]))
		code := 0
		if c, ok := b.Data["status_code"].(float64); ok {
			code = int(c)
		}
		// Failures come from http.client spans as http.request.failed, with
		// their trace; only answered requests below 500 are added here.
		if code == 0 || code >= 500 {
			return
		}
		span := anyString(b.Data["__span"])
		if span != "" && x.httpSeen(span) {
			return // from the http.client span or another event's copy
		}
		lr := t.newRecord(eventHTTPRequest, b.at, x, match, "", plog.SeverityNumberInfo)
		a := lr.Attributes()
		if method != "" {
			a.PutStr("http.request.method", method)
		}
		if url != "" {
			a.PutStr("url.full", truncate(url, maxLogAttributeLen))
		}
		a.PutInt("http.response.status_code", int64(code))
		lr.Body().SetStr(strings.TrimSpace(method + " " + url))
		if sp, ok := spanID(span); ok {
			lr.SetSpanID(sp)
		}
	case cat == "console":
		if x.consoleSeen(b.Message, b.at) {
			return // already on the timeline from a console Sentry log
		}
		lr := t.newRecord(eventConsole, b.at, x, match, "", severityOfLevel(b.Level))
		lr.Body().SetStr(b.Message)
		a := lr.Attributes()
		a.PutStr("message", truncate(b.Message, maxLogAttributeLen))
		a.PutStr("ouo.sentry.level", b.Level)
	case strings.HasPrefix(cat, "app."):
		// app.inactive, app.background, app.foreground (sentry-cocoa), app.lifecycle (sentry-java).
		state := strings.TrimPrefix(cat, "app.")
		if cat == "app.lifecycle" {
			state = firstString(anyString(b.Data["state"]), b.Message)
		}
		lr := t.newRecord(eventAppLifecycle, b.at, x, match, "", plog.SeverityNumberInfo)
		lr.Body().SetStr("app " + state)
		lr.Attributes().PutStr("ouo.app.state", state)
	case cat == "ui.tap" || cat == "ui.click" || cat == "touch":
		lr := t.newRecord(eventUITap, b.at, x, match, "", plog.SeverityNumberInfo)
		// React Native: the touched component path, innermost labelled component
		// first ("action-fetch-ok > action-fetch-ok > Text"), sometimes prefixed.
		path := strings.TrimPrefix(firstString(b.Message, anyString(b.Data["view.id"]), anyString(b.Data["target"])), "Touch event within element: ")
		target, _, _ := strings.Cut(path, " > ")
		lr.Body().SetStr(firstString(path, "tap"))
		a := lr.Attributes()
		if target != "" {
			a.PutStr("ouo.ui.target", truncate(target, maxLogAttributeLen))
		}
		if path != target {
			a.PutStr("ouo.ui.path", truncate(path, maxLogAttributeLen))
		}
	default:
		lr := t.newRecord(eventBreadcrumb, b.at, x, match, "", severityOfLevel(b.Level))
		lr.Body().SetStr(firstString(b.Message, cat))
		a := lr.Attributes()
		a.PutStr(attrBreadcrumbCat, cat)
		if b.Message != "" {
			a.PutStr("message", truncate(b.Message, maxLogAttributeLen))
		}
		keys := make([]string, 0, len(b.Data))
		for k := range b.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		n := 0
		for _, k := range keys {
			v := anyString(b.Data[k])
			if v == "" || strings.HasPrefix(k, "__") || n >= maxBreadcrumbData {
				continue
			}
			a.PutStr(attrBreadcrumbData+k, truncate(v, maxLogAttributeLen))
			n++
		}
	}
}
