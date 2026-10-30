package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"strings"
	"time"

	"go.opentelemetry.io/collector/pdata/plog"
)

// User feedback (spec section 9c, docs/specs/mobile-sdk.md C10): Sentry's
// `feedback` and `user_report` items become the ouo SDK's `feedback` record.
const (
	eventFeedback       = "feedback"
	attrFeedbackMessage = "ouo.feedback.message"
	attrFeedbackContact = "ouo.feedback.contact"
	attrFeedbackID      = "ouo.feedback.id"
	// maxFeedbackText is the cut of the message and the contact, in bytes
	// with "…" (truncate), as the ouo SDK cuts them (MAX_FEEDBACK_BYTES).
	maxFeedbackText = 4096
)

// emitFeedback maps a `feedback` item: an event of type feedback whose
// contexts.feedback holds what the user wrote. Its session resolves like an
// event's (rules 1 to 4, with contexts.feedback.replay_id as its replay id),
// else through the event it names (associated_event_id). Its breadcrumbs
// become timeline events as an error's do (section 9b). Must hold the lock.
func (t *translation) emitFeedback(st *sessionState, envSessions map[string]*sentrySession, order []*sentrySession, e *sentryEvent, envReplayID string) {
	f := e.Contexts.Feedback
	if f == nil || strings.TrimSpace(f.Message) == "" {
		return
	}
	// The replay id resolve falls back on when contexts.replay has none: the
	// feedback's own (the JS replay integration's), else the envelope's.
	replayID := firstString(f.ReplayID, envReplayID)
	x, match := t.resolve(st, envSessions, order, e, replayID, false)
	if x == nil {
		if x = st.byEventID(t.j.project.OuoProjectID, f.AssociatedEventID); x != nil {
			// Rule event names a session that its error already resolved: no
			// device context or trace id to learn from a feedback's own fields.
			match = matchEvent
			st.touch(x, eventTime(e, t.j.receivedAt))
		}
	}
	if e.Contexts.Replay != nil && e.Contexts.Replay.ReplayID != "" {
		replayID = e.Contexts.Replay.ReplayID
	}
	userID := ""
	if e.User != nil {
		userID = e.User.ID
	}
	lr := t.newFeedback(eventTime(e, t.j.receivedAt), x, match, userID, f.Message, firstString(f.ContactEmail, f.Name), e.EventID)
	t.setTraceContext(lr, e.Contexts.Trace)
	if x != nil {
		t.emitEventBreadcrumbs(e, x, match, x.replayID != "" || replayID != "")
	}
}

// emitUserReport maps the legacy `user_report` item: no time, user or
// context, only the event it is about, whose session it takes. Received time
// stands for its time. Must hold the lock.
func (t *translation) emitUserReport(st *sessionState, u *userReport) {
	if strings.TrimSpace(u.Comments) == "" {
		return
	}
	// Unknown error (bridge restarted, error sampled out or not sent yet):
	// emitted without a session (none). Holding it like logs is a later item.
	x, match := st.byEventID(t.j.project.OuoProjectID, u.EventID), matchNone
	if x != nil {
		// Rule event: the error's session; a report brings no context to learn.
		match = matchEvent
		st.touch(x, t.j.receivedAt)
	}
	t.newFeedback(t.j.receivedAt, x, match, "", u.Comments, firstString(u.Email, u.Name), "")
}

// newFeedback appends the `feedback` record. The id is Sentry's event id as a
// UUID; a user report has none of its own (its event_id names the error), so
// it gets none.
func (t *translation) newFeedback(ts time.Time, x *sess, match, userID, message, contact, eventID string) plog.LogRecord {
	message = truncate(strings.TrimSpace(message), maxFeedbackText)
	lr := t.newRecord(eventFeedback, ts, x, match, userID, plog.SeverityNumberInfo)
	lr.Body().SetStr(message)
	a := lr.Attributes()
	a.PutStr(attrFeedbackMessage, message)
	if c := strings.TrimSpace(contact); c != "" {
		a.PutStr(attrFeedbackContact, truncate(c, maxFeedbackText))
	}
	if id := uuidOf(eventID); id != "" {
		a.PutStr(attrFeedbackID, id)
	}
	if eventID != "" {
		a.PutStr("ouo.sentry.event_id", eventID)
	}
	return lr
}

// uuidOf formats a Sentry event id (32 hex digits, dashes optional) as a
// UUID; "" for anything else.
func uuidOf(id string) string {
	h := normTraceID(id)
	if len(h) != 32 {
		return ""
	}
	for _, c := range h {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return ""
		}
	}
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
