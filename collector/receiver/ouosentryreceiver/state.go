package ouosentryreceiver // import "github.com/ZiadMansourM/ouo/collector/receiver/ouosentryreceiver"

import (
	"container/list"
	"sync"
	"time"
)

// deviceWindow is how long after its last update a session still claims a
// device's items (rule 3, spec section 8): the session lifecycle's inactivity
// timeout.
const deviceWindow = 30 * time.Minute

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
	errorsSeen        int // last `errors` value of a session update
	exceptionsEmitted int // exception records emitted for this session
	replayID          string
	lastScreen        string
	elem              *list.Element
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
		bySID: map[string]*sess{}, byDevice: map[string]map[*sess]struct{}{}, byReplay: map[string]*sess{},
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
			s.indexDevice(x)
		}
		return x, false
	}
	x := &sess{key: key, sid: sid, did: did, project: project, started: started, lastEvent: started, lastSeen: s.now()}
	x.elem = s.order.PushFront(x)
	s.bySID[key] = x
	s.indexDevice(x)
	for s.order.Len() > s.max {
		s.remove(s.order.Back().Value.(*sess))
	}
	return x, true
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

// byDeviceAt resolves rule 3: the device's session whose window contains at;
// the latest started one wins. Must hold the lock.
func (s *sessionState) byDeviceAt(project, did string, at time.Time) *sess {
	if did == "" {
		return nil
	}
	var best *sess
	for x := range s.byDevice[project+"/"+did] {
		end := x.lastEvent.Add(deviceWindow)
		if x.endEmitted {
			end = x.lastEvent
		}
		if at.IsZero() || (!at.Before(x.started.Add(-time.Minute)) && !at.After(end)) {
			if best == nil || x.started.After(best.started) {
				best = x
			}
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
