package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"context"
	"sort"
	"strings"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
)

// Timeline events derived from the breadcrumbs of replay recordings (spec
// section 9a). Each breadcrumb is in exactly one segment, so every one becomes
// one record; retried segments produce identical records, which rum-api
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

// skippedBreadcrumbs duplicate what other items already produce: navigation
// (transactions), the SDK's own transaction and event notes.
var skippedBreadcrumbs = map[string]bool{
	"navigation": true, "sentry.transaction": true, "sentry.event": true,
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
		did = seg.event.User.ID
	}
	r.state.withLock(func() {
		x := r.state.get(j.project.OuoProjectID, sid)
		if x == nil {
			x = &sess{sid: sid, did: did} // evicted meanwhile: no de-duplication
		}
		for i := range seg.breadcrumbs {
			t.emitBreadcrumb(&seg.breadcrumbs[i], x)
		}
	})
	t.consume(ctx)
}

// emitBreadcrumb must run under the state lock (console de-duplication).
func (t *translation) emitBreadcrumb(b *breadcrumb, x *sess) {
	cat := b.Category
	switch {
	case skippedBreadcrumbs[cat]:
		return
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
		lr := t.newRecord(eventHTTPRequest, b.at, x, matchReplay, "", plog.SeverityNumberInfo)
		a := lr.Attributes()
		if method != "" {
			a.PutStr("http.request.method", method)
		}
		if url != "" {
			a.PutStr("url.full", truncate(url, maxLogAttributeLen))
		}
		a.PutInt("http.response.status_code", int64(code))
		lr.Body().SetStr(strings.TrimSpace(method + " " + url))
		if sp, ok := spanID(anyString(b.Data["__span"])); ok {
			lr.SetSpanID(sp)
		}
	case cat == "console":
		if x.consoleSeen(b.Message, b.at) {
			return // already on the timeline from a console Sentry log
		}
		lr := t.newRecord(eventConsole, b.at, x, matchReplay, "", severityOfLevel(b.Level))
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
		lr := t.newRecord(eventAppLifecycle, b.at, x, matchReplay, "", plog.SeverityNumberInfo)
		lr.Body().SetStr("app " + state)
		lr.Attributes().PutStr("ouo.app.state", state)
	case cat == "ui.tap" || cat == "ui.click" || cat == "touch":
		lr := t.newRecord(eventUITap, b.at, x, matchReplay, "", plog.SeverityNumberInfo)
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
		lr := t.newRecord(eventBreadcrumb, b.at, x, matchReplay, "", severityOfLevel(b.Level))
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
