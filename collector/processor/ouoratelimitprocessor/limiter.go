package ouoratelimitprocessor // import "github.com/ZiadMansourM/ouo/collector/processor/ouoratelimitprocessor"

import (
	"math"
	"sync"
	"time"
)

// bucket is a classic token bucket; tokens are refilled lazily on access.
type bucket struct {
	tokens   float64
	last     time.Time // last refill
	lastSeen time.Time
}

// limiter holds the buckets of both key kinds behind one mutex so a request
// takes its tokens from both buckets atomically (or from none).
type limiter struct {
	cfg *Config
	now func() time.Time

	mu      sync.Mutex
	project map[string]*bucket
	client  map[string]*bucket
}

func newLimiter(cfg *Config) *limiter {
	return &limiter{
		cfg:     cfg,
		now:     time.Now,
		project: map[string]*bucket{},
		client:  map[string]*bucket{},
	}
}

func refill(b *bucket, bc BucketConfig, now time.Time) {
	if el := now.Sub(b.last).Seconds(); el > 0 {
		b.tokens = math.Min(float64(bc.Burst), b.tokens+el*bc.Rate)
	}
	b.last = now
	b.lastSeen = now
}

func get(m map[string]*bucket, key string, bc BucketConfig, now time.Time) *bucket {
	b, ok := m[key]
	if !ok {
		b = &bucket{tokens: float64(bc.Burst), last: now, lastSeen: now}
		m[key] = b
	}
	refill(b, bc, now)
	return b
}

// wait is how long until bucket b holds one token again.
func wait(b *bucket, bc BucketConfig) time.Duration {
	missing := 1 - b.tokens
	if missing <= 0 {
		return 0
	}
	return time.Duration(missing / bc.Rate * float64(time.Second))
}

// allow takes one token from the project bucket (when projectKey != "" and
// the project limit is enabled) and one from the client bucket (same rule).
// When either bucket is empty nothing is taken and it returns the rejecting
// key kind ("project" or "client") and the time until a token is available.
func (l *limiter) allow(projectKey, clientKey string) (string, time.Duration) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	var pb, cb *bucket
	if projectKey != "" && l.cfg.Project.Rate > 0 {
		pb = get(l.project, projectKey, l.cfg.Project, now)
	}
	if clientKey != "" && l.cfg.Client.Rate > 0 {
		cb = get(l.client, clientKey, l.cfg.Client.BucketConfig, now)
	}
	if cb != nil && cb.tokens < 1 {
		return keyKindClient, wait(cb, l.cfg.Client.BucketConfig)
	}
	if pb != nil && pb.tokens < 1 {
		return keyKindProject, wait(pb, l.cfg.Project)
	}
	if pb != nil {
		pb.tokens--
	}
	if cb != nil {
		cb.tokens--
	}
	return "", 0
}

// sweep drops buckets idle for longer than the idle timeout. An idle bucket
// is full again, so dropping it changes nothing for the next request.
func (l *limiter) sweep() {
	cutoff := l.now().Add(-l.cfg.IdleTimeout)
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, m := range []map[string]*bucket{l.project, l.client} {
		for k, b := range m {
			if b.lastSeen.Before(cutoff) {
				delete(m, k)
			}
		}
	}
}

func (l *limiter) size() (int, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.project), len(l.client)
}
