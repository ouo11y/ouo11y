package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"container/list"
	"sync"
	"time"
)

// deviceWindow is how long after its last update a session still claims a
// device's items (rule 3, spec section 8): the session lifecycle's inactivity
// timeout.
const deviceWindow = 30 * time.Minute

// endedGrace is how long after an ended session's last update it still claims
// items. Mobile SDKs end a session after 30 s in the background and the next
// one starts on foreground, so nothing later than that can belong to it.
const endedGrace = 30 * time.Second

// startSkew tolerates items timed slightly before the session's start (the app
// start transaction begins before the SDK opens the session).
const startSkew = time.Minute

// Startup logs (spec section 8, rule 5): console output printed while the
// app starts, before the SDK opened its session, carries no replay id, user
// id or known trace id. It belongs to the session the same client starts
// within this window around it (observed: 60 ms before to 0.7 s after).
const (
	startLogBefore = 10 * time.Second // a log at most this long before the session start
	startLogAfter  = 5 * time.Second  // or at most this long after it
	maxPerOrigin   = 16
)

// setOrigin indexes a new session by the network origin it came from. Must
// hold the lock.
func (s *sessionState) setOrigin(x *sess, origin string) {
	if origin == "" || x.origin != "" {
		return
	}
	x.origin = origin
	k := x.project + "/" + origin
	l := append(s.byOrigin[k], x)
	if len(l) > maxPerOrigin {
		l = l[len(l)-maxPerOrigin:]
	}
	s.byOrigin[k] = l
}

// byStart resolves the startup rule: the one session created from the same
// origin that started within the window around at. Several candidates
// (clients behind one address starting together) match none. Must hold the
// lock.
func (s *sessionState) byStart(project, origin string, at time.Time) *sess {
	if origin == "" || at.IsZero() {
		return nil
	}
	var found *sess
	for _, x := range s.byOrigin[project+"/"+origin] {
		if at.Before(x.started.Add(-startLogBefore)) || at.After(x.started.Add(startLogAfter)) {
			continue
		}
		if found != nil {
			return nil
		}
		found = x
	}
	return found
}

// covers reports whether an item at `at` can belong to the session.
func (x *sess) covers(at time.Time) bool {
	if at.IsZero() {
		return true
	}
	end := x.lastEvent.Add(deviceWindow)
	if x.endEmitted {
		end = x.lastEvent.Add(endedGrace)
	}
	return !at.Before(x.started.Add(-startSkew)) && !at.After(end)
}

// sess is what the bridge remembers about one Sentry session.
type sess struct {
	key       string // project + "/" + sid
	sid       string
	did       string
	project   string
	started   time.Time
	lastEvent time.Time // latest session-update or item time (device time)
	lastSeen  time.Time // wall clock of the last envelope (LRU and TTL)
	// seenInit: the bridge saw the session from its first update, so the
	// errors counter can be backfilled with synthetic exceptions.
	seenInit          bool
	startEmitted      bool
	endEmitted        bool
	appStartEmitted   bool // an ouo.app.start record was emitted (mobile vitals spec, section 3)
	errorsSeen        int  // last `errors` value of a session update
	exceptionsEmitted int  // exception records emitted for this session
	replayID          string
	replayMasked      *bool         // masking options from the replay's `options` event
	traceIDs          []string      // trace ids learned for this session (rule 4), oldest first
	console           []consoleLine // recent console lines, to de-duplicate logs and breadcrumbs
	fatalAt           time.Time     // time of the first fatal exception
	lastScreen        string
	previousID        string        // the device's session that started before this one (A9)
	origin            string        // network origin of the envelope that created the session
	navs              []navEntry    // recent navigations, to pair transactions with breadcrumbs (A11)
	crumbs            []crumbSeen   // event breadcrumbs emitted, to skip their copies on later events (A8)
	httpSpans         []string      // span ids emitted as http.request, oldest first (A8)
	eventIDs          []string      // event ids of its errors and messages, oldest first (section 9c)
	dev               deviceContext // OS and device from the session's events, transactions and logs
	elem              *list.Element
}

// deviceContext is the OS and device context Sentry sends on events,
// transactions and log entries, but not on session updates or replays.
type deviceContext struct {
	osName, osVersion, model string
}

func (d deviceContext) empty() bool { return d == deviceContext{} }

// merge takes every field d2 has.
func (d *deviceContext) merge(d2 deviceContext) {
	d.osName = firstString(d2.osName, d.osName)
	d.osVersion = firstString(d2.osVersion, d.osVersion)
	d.model = firstString(d2.model, d.model)
}

// deviceOf returns the device context of a session, else the one of the
// device's latest started session that has one (a new session's first
// updates come before any event). Must hold the lock.
func (s *sessionState) deviceOf(x *sess) deviceContext {
	if !x.dev.empty() || x.did == "" {
		return x.dev
	}
	var best *sess
	for c := range s.byDevice[x.project+"/"+x.did] {
		if !c.dev.empty() && (best == nil || c.started.After(best.started)) {
			best = c
		}
	}
	if best == nil {
		return x.dev
	}
	return best.dev
}

// sessionState is a bounded LRU of sessions with lookups by device and by
// replay id. Safe for concurrent use.
type sessionState struct {
	mu       sync.Mutex
	max      int
	ttl      time.Duration
	order    *list.List // front = most recently updated
	bySID    map[string]*sess
	byDevice map[string]map[*sess]struct{} // project/did
	byReplay map[string]*sess              // project/replay_id
	byTrace  map[string][]*sess            // project/trace_id
	byOrigin map[string][]*sess            // project/origin, latest sessions created from it
	byEvent  map[string]*sess              // project/event_id of errors and messages
	now      func() time.Time
}

func newSessionState(cfg StateConfig) *sessionState {
	maxSessions := cfg.MaxSessions
	if maxSessions <= 0 {
		maxSessions = 200000
	}
	ttl := cfg.TTL
	if ttl <= 0 {
		ttl = 4 * time.Hour
	}
	return &sessionState{
		max: maxSessions, ttl: ttl, order: list.New(),
		bySID: map[string]*sess{}, byDevice: map[string]map[*sess]struct{}{}, byReplay: map[string]*sess{}, byTrace: map[string][]*sess{}, byOrigin: map[string][]*sess{}, byEvent: map[string]*sess{},
		now: time.Now,
	}
}

// withLock runs fn under the state lock; translation of one envelope holds it
// for the whole envelope so concurrent workers see consistent counters.
func (s *sessionState) withLock(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expire()
	fn()
}

// upsert returns the session, creating it when unknown. Must hold the lock.
func (s *sessionState) upsert(project, sid, did string, started time.Time) (*sess, bool) {
	key := project + "/" + sid
	if x, ok := s.bySID[key]; ok {
		if did != "" && x.did == "" {
			x.did = did
			x.previousID = s.previousOf(x)
			s.indexDevice(x)
		}
		return x, false
	}
	x := &sess{key: key, sid: sid, did: did, project: project, started: started, lastEvent: started, lastSeen: s.now()}
	x.previousID = s.previousOf(x)
	x.elem = s.order.PushFront(x)
	s.bySID[key] = x
	s.indexDevice(x)
	for s.order.Len() > s.max {
		s.remove(s.order.Back().Value.(*sess))
	}
	return x, true
}

// previousOf returns the sid of the device's latest session that started
// before x, for session.previous_id. Must hold the lock.
func (s *sessionState) previousOf(x *sess) string {
	if x.did == "" {
		return ""
	}
	var best *sess
	for c := range s.byDevice[x.project+"/"+x.did] {
		if c != x && c.started.Before(x.started) && (best == nil || c.started.After(best.started)) {
			best = c
		}
	}
	if best == nil {
		return ""
	}
	return best.sid
}

func (s *sessionState) indexDevice(x *sess) {
	if x.did == "" {
		return
	}
	dk := x.project + "/" + x.did
	m := s.byDevice[dk]
	if m == nil {
		m = map[*sess]struct{}{}
		s.byDevice[dk] = m
	}
	m[x] = struct{}{}
}

// touch marks a session updated now. Must hold the lock.
func (s *sessionState) touch(x *sess, at time.Time) {
	if at.After(x.lastEvent) {
		x.lastEvent = at
	}
	x.lastSeen = s.now()
	s.order.MoveToFront(x.elem)
}

// get returns a known session. Must hold the lock.
func (s *sessionState) get(project, sid string) *sess {
	return s.bySID[project+"/"+sid]
}

// learnReplay maps a replay id to a session (first mapping wins). Must hold the lock.
func (s *sessionState) learnReplay(x *sess, replayID string) {
	if replayID == "" {
		return
	}
	rk := x.project + "/" + replayID
	if _, ok := s.byReplay[rk]; !ok {
		s.byReplay[rk] = x
	}
	if x.replayID == "" {
		x.replayID = replayID
	}
}

// byReplayID resolves rule 2. Must hold the lock.
func (s *sessionState) byReplayID(project, replayID string) *sess {
	if replayID == "" {
		return nil
	}
	return s.byReplay[project+"/"+replayID]
}

// maxTracesPerSession bounds the trace ids remembered per session; the oldest
// mapping is forgotten first.
const maxTracesPerSession = 512

// learnTrace maps a trace id to a session (rule 4). A trace id can span
// sessions (the SDK's scope trace outlives a background rotation), so each id
// keeps every session it was seen in. Must hold the lock.
func (s *sessionState) learnTrace(x *sess, traceID string) {
	if traceID == "" {
		return
	}
	tk := x.project + "/" + traceID
	for _, c := range s.byTrace[tk] {
		if c == x {
			return
		}
	}
	s.byTrace[tk] = append(s.byTrace[tk], x)
	x.traceIDs = append(x.traceIDs, traceID)
	if len(x.traceIDs) > maxTracesPerSession {
		s.forgetTrace(x, x.traceIDs[0])
		x.traceIDs = x.traceIDs[1:]
	}
}

func (s *sessionState) forgetTrace(x *sess, traceID string) {
	tk := x.project + "/" + traceID
	list := s.byTrace[tk]
	for i, c := range list {
		if c == x {
			list = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(s.byTrace, tk)
	} else {
		s.byTrace[tk] = list
	}
}

// byTraceAt resolves rule 4: the session of the trace whose window contains
// at; the latest started one wins. Must hold the lock.
func (s *sessionState) byTraceAt(project, traceID string, at time.Time) *sess {
	if traceID == "" {
		return nil
	}
	var best *sess
	for _, x := range s.byTrace[project+"/"+traceID] {
		if x.covers(at) && (best == nil || x.started.After(best.started)) {
			best = x
		}
	}
	return best
}

// maxEventsPerSession bounds the event ids remembered per session; the oldest
// is forgotten first. A report names an event the user just saw fail.
const maxEventsPerSession = 64

// learnEvent maps an error or message event id to its session, so a
// `user_report` or a `feedback` naming it finds the session (section 9c).
// Must hold the lock.
func (s *sessionState) learnEvent(x *sess, eventID string) {
	id := normTraceID(eventID)
	if id == "" {
		return
	}
	k := x.project + "/" + id
	if s.byEvent[k] == x {
		return
	}
	s.byEvent[k] = x
	x.eventIDs = append(x.eventIDs, id)
	if len(x.eventIDs) > maxEventsPerSession {
		s.forgetEvent(x, x.eventIDs[0])
		x.eventIDs = x.eventIDs[1:]
	}
}

func (s *sessionState) forgetEvent(x *sess, id string) {
	k := x.project + "/" + id
	if s.byEvent[k] == x {
		delete(s.byEvent, k)
	}
}

// byEventID returns the session of an error or message event. Must hold the lock.
func (s *sessionState) byEventID(project, eventID string) *sess {
	id := normTraceID(eventID)
	if id == "" {
		return nil
	}
	return s.byEvent[project+"/"+id]
}

// navEntry is one navigation seen for a session, from a transaction or a
// `navigation` breadcrumb.
type navEntry struct {
	screen     string
	at         time.Time
	breadcrumb bool
	paired     bool
}

const (
	maxNavs = 64
	// navPairWindow: a React Navigation transaction starts 10 to 20 ms before
	// its breadcrumb; the app-start ui.load transaction up to 3 s before
	// (observed on iOS).
	navPairWindow = 5 * time.Second
	// crumbCopyWindow: the same breadcrumb repeats on every error event, and
	// the native SDK's copy is stamped up to about 60 ms later (observed).
	crumbCopyWindow = time.Second
)

// navSeen pairs a navigation with one from the other source (a transaction
// and its breadcrumb) or with a copy of the same breadcrumb, and records it
// otherwise. It returns true when the navigation is already on the timeline.
// Must hold the lock.
func (x *sess) navSeen(screen string, at time.Time, breadcrumb bool) bool {
	paired := false
	for i := range x.navs {
		n := &x.navs[i]
		if n.screen != screen {
			continue
		}
		dt := n.at.Sub(at).Abs()
		if breadcrumb && n.breadcrumb && dt <= crumbCopyWindow {
			return true
		}
		if !paired && n.breadcrumb != breadcrumb && !n.paired && dt <= navPairWindow {
			n.paired, paired = true, true
		}
	}
	// Recorded even when paired, so later copies of a breadcrumb find it.
	x.navs = append(x.navs, navEntry{screen: screen, at: at, breadcrumb: breadcrumb, paired: paired})
	if len(x.navs) > maxNavs {
		x.navs = x.navs[len(x.navs)-maxNavs:]
	}
	return paired
}

// crumbSeen is one event breadcrumb emitted for a session.
type crumbSeen struct {
	key   uint64
	at    time.Time
	event string
}

const maxCrumbs = 512

// eventCrumbSeen reports whether an event breadcrumb is a copy of one an
// earlier event already brought (every error carries the scope's last 100;
// the native SDK's copies are stamped up to about 60 ms later), and records
// it otherwise. Copies within one event are not duplicates (two taps on the
// same button). Must hold the lock.
func (x *sess) eventCrumbSeen(key uint64, at time.Time, event string) bool {
	for _, c := range x.crumbs {
		if c.key == key && c.event != event && c.at.Sub(at).Abs() <= crumbCopyWindow {
			return true
		}
	}
	x.crumbs = append(x.crumbs, crumbSeen{key: key, at: at, event: event})
	if len(x.crumbs) > maxCrumbs {
		x.crumbs = x.crumbs[len(x.crumbs)-maxCrumbs:]
	}
	return false
}

// httpSeen reports whether a request (by span id) is on the timeline
// already, from a fetch breadcrumb or its http.client span, and records it
// otherwise. Must hold the lock.
func (x *sess) httpSeen(spanID string) bool {
	for _, s := range x.httpSpans {
		if s == spanID {
			return true
		}
	}
	x.httpSpans = append(x.httpSpans, spanID)
	if len(x.httpSpans) > maxCrumbs {
		x.httpSpans = x.httpSpans[len(x.httpSpans)-maxCrumbs:]
	}
	return false
}

// consoleLine is one console message emitted for a session.
type consoleLine struct {
	msg string
	at  time.Time
}

const (
	maxConsoleLines = 256
	consoleWindow   = 2 * time.Second
)

// consoleSeen reports whether the session already got this console line (the
// same message within consoleWindow) and records it otherwise. The JS SDK
// reports console output twice: as a Sentry log (consoleLoggingIntegration,
// part of enableLogs) and as a breadcrumb in the replay recording. Must hold
// the lock.
func (x *sess) consoleSeen(msg string, at time.Time) bool {
	for _, c := range x.console {
		if c.msg == msg && c.at.Sub(at).Abs() <= consoleWindow {
			return true
		}
	}
	x.console = append(x.console, consoleLine{msg: msg, at: at})
	if len(x.console) > maxConsoleLines {
		x.console = x.console[len(x.console)-maxConsoleLines:]
	}
	return false
}

// byDeviceAt resolves rule 3: the device's session whose window contains at;
// the latest started one wins. Must hold the lock.
func (s *sessionState) byDeviceAt(project, did string, at time.Time) *sess {
	if did == "" {
		return nil
	}
	var best *sess
	for x := range s.byDevice[project+"/"+did] {
		if x.covers(at) && (best == nil || x.started.After(best.started)) {
			best = x
		}
	}
	return best
}

// replayStartSkew: a replay starts with its session (observed +0.0 s on iOS),
// so a segment can only belong to a session that started at most this long
// after the segment. The 1 min startSkew of covers() is for the app start
// transaction and is too loose for replays: it let a held segment of an
// unknown earlier session (bridge restarted mid-replay) claim the device's
// next session, whose own replay was then dropped as a conflict.
const replayStartSkew = 10 * time.Second

// byDeviceForReplay resolves rule 3 for a replay segment starting at `at`.
// Must hold the lock.
func (s *sessionState) byDeviceForReplay(project, did string, at time.Time) *sess {
	if did == "" {
		return nil
	}
	var best *sess
	for x := range s.byDevice[project+"/"+did] {
		if !x.covers(at) || (!at.IsZero() && at.Before(x.started.Add(-replayStartSkew))) {
			continue
		}
		if best == nil || x.started.After(best.started) {
			best = x
		}
	}
	return best
}

func (s *sessionState) remove(x *sess) {
	s.order.Remove(x.elem)
	delete(s.bySID, x.key)
	if x.did != "" {
		dk := x.project + "/" + x.did
		delete(s.byDevice[dk], x)
		if len(s.byDevice[dk]) == 0 {
			delete(s.byDevice, dk)
		}
	}
	if x.replayID != "" {
		rk := x.project + "/" + x.replayID
		if s.byReplay[rk] == x {
			delete(s.byReplay, rk)
		}
	}
	for _, id := range x.traceIDs {
		s.forgetTrace(x, id)
	}
	for _, id := range x.eventIDs {
		s.forgetEvent(x, id)
	}
	if x.origin != "" {
		k := x.project + "/" + x.origin
		l := s.byOrigin[k]
		for i, c := range l {
			if c == x {
				l = append(l[:i:i], l[i+1:]...)
				break
			}
		}
		if len(l) == 0 {
			delete(s.byOrigin, k)
		} else {
			s.byOrigin[k] = l
		}
	}
}

// expire drops sessions not updated within the TTL. Must hold the lock.
func (s *sessionState) expire() {
	cutoff := s.now().Add(-s.ttl)
	for e := s.order.Back(); e != nil; {
		x := e.Value.(*sess)
		if x.lastSeen.After(cutoff) {
			return
		}
		prev := e.Prev()
		s.remove(x)
		e = prev
	}
}
