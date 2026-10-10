package ingest

import (
	"math"
	"sync"
	"time"
)

// Limiter is a set of token buckets keyed by string (project id or client
// IP) sharing one rate and burst. A bucket that has been idle long enough to
// refill completely is indistinguishable from a fresh one, so idle buckets
// are dropped during a periodic sweep that runs inline from Allow (no
// background goroutine, deterministic with an injected clock).
type Limiter struct {
	rate  float64 // tokens per second
	burst float64
	now   func() time.Time

	mu         sync.Mutex
	buckets    map[string]*bucket
	lastSweep  time.Time
	sweepEvery time.Duration
}

type bucket struct {
	tokens float64
	last   time.Time
}

// NewLimiter creates a limiter. rate <= 0 or burst <= 0 disables it (Allow
// always succeeds).
func NewLimiter(rate float64, burst int, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	l := &Limiter{rate: rate, burst: float64(burst), now: now, buckets: map[string]*bucket{}}
	l.lastSweep = now()
	// Sweep once per full refill period, at least once a minute, so a sweep
	// only ever removes buckets that are full again.
	l.sweepEvery = l.refillPeriod()
	if l.sweepEvery < time.Minute {
		l.sweepEvery = time.Minute
	}
	return l
}

// Enabled reports whether the limiter enforces anything.
func (l *Limiter) Enabled() bool { return l != nil && l.rate > 0 && l.burst > 0 }

func (l *Limiter) refillPeriod() time.Duration {
	if !l.Enabled() {
		return 0
	}
	return time.Duration(math.Ceil(l.burst / l.rate * float64(time.Second)))
}

// Allow takes one token from key's bucket. When the bucket is empty it
// returns false and how long until one token is available (callers round it
// up to whole seconds for Retry-After).
func (l *Limiter) Allow(key string) (ok bool, retryAfter time.Duration) {
	if !l.Enabled() {
		return true, 0
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) >= l.sweepEvery {
		l.sweep(now)
	}
	b, found := l.buckets[key]
	if !found {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	} else if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = math.Min(l.burst, b.tokens+elapsed*l.rate)
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := (1 - b.tokens) / l.rate
	return false, time.Duration(math.Ceil(wait * float64(time.Second)))
}

// sweep drops buckets idle for at least one full refill period.
func (l *Limiter) sweep(now time.Time) {
	idle := l.refillPeriod()
	for k, b := range l.buckets {
		if now.Sub(b.last) >= idle {
			delete(l.buckets, k)
		}
	}
	l.lastSweep = now
}

// Len is the number of live buckets (for tests and debugging).
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// ProjectLimiter holds one bucket per project. Projects may carry their own
// rate_limit; the others share the server defaults. Each project has its
// own Limiter instance so that per-project rate and burst stay independent.
type ProjectLimiter struct {
	defRate  float64
	defBurst int
	now      func() time.Time

	mu   sync.Mutex
	byID map[string]*Limiter
}

// NewProjectLimiter creates the per-project limiter set with the server
// defaults (OUO_RATE_LIMIT_RPS / OUO_RATE_LIMIT_BURST).
func NewProjectLimiter(defRate float64, defBurst int, now func() time.Time) *ProjectLimiter {
	if now == nil {
		now = time.Now
	}
	return &ProjectLimiter{defRate: defRate, defBurst: defBurst, now: now, byID: map[string]*Limiter{}}
}

// Allow takes one token from the project's bucket. rate / burst are the
// project's own values (0 means default).
func (p *ProjectLimiter) Allow(projectID string, rate float64, burst int) (bool, time.Duration) {
	if rate <= 0 {
		rate = p.defRate
	}
	if burst <= 0 {
		burst = p.defBurst
	}
	p.mu.Lock()
	l, ok := p.byID[projectID]
	if !ok || l.rate != rate || int(l.burst) != burst {
		l = NewLimiter(rate, burst, p.now)
		p.byID[projectID] = l
	}
	p.mu.Unlock()
	return l.Allow(projectID)
}
