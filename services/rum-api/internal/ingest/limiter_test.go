package ingest

import (
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }
func newClock() *clock                   { return &clock{t: time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)} }
func mustAllow(t *testing.T, l *Limiter, k string) {
	t.Helper()
	if ok, _ := l.Allow(k); !ok {
		t.Fatalf("Allow(%s) denied", k)
	}
}

func TestLimiterBurstRefillAndRetryAfter(t *testing.T) {
	c := newClock()
	l := NewLimiter(2, 3, c.now) // 2 rps, burst 3
	for i := 0; i < 3; i++ {
		mustAllow(t, l, "a")
	}
	ok, wait := l.Allow("a")
	if ok || wait != 500*time.Millisecond {
		t.Fatalf("4th: ok=%v wait=%v", ok, wait)
	}
	// Other keys have their own bucket.
	mustAllow(t, l, "b")
	// After 500 ms one token is back; after another 250 ms only half a token.
	c.advance(500 * time.Millisecond)
	mustAllow(t, l, "a")
	c.advance(250 * time.Millisecond)
	if ok, wait := l.Allow("a"); ok || wait != 250*time.Millisecond {
		t.Fatalf("half token: ok=%v wait=%v", ok, wait)
	}
	// Refill never exceeds the burst.
	c.advance(time.Hour)
	for i := 0; i < 3; i++ {
		mustAllow(t, l, "a")
	}
	if ok, _ := l.Allow("a"); ok {
		t.Fatal("burst exceeded after a long idle")
	}
}

func TestLimiterSweepsIdleBuckets(t *testing.T) {
	c := newClock()
	l := NewLimiter(10, 5, c.now) // refill period 0.5 s -> sweep every minute
	for _, k := range []string{"a", "b", "c"} {
		mustAllow(t, l, k)
	}
	if l.Len() != 3 {
		t.Fatalf("buckets: %d", l.Len())
	}
	c.advance(59 * time.Second)
	mustAllow(t, l, "d")
	if l.Len() != 4 {
		t.Fatalf("swept too early: %d", l.Len())
	}
	c.advance(2 * time.Second)
	mustAllow(t, l, "a") // triggers the sweep: b, c, d idle for >= 0.5 s are full again and dropped; a is re-created
	if l.Len() != 1 {
		t.Fatalf("after sweep: %d", l.Len())
	}
}

func TestLimiterDisabled(t *testing.T) {
	l := NewLimiter(0, 0, nil)
	if l.Enabled() {
		t.Fatal("enabled")
	}
	for i := 0; i < 1000; i++ {
		mustAllow(t, l, "x")
	}
	if l.Len() != 0 {
		t.Fatal("disabled limiter keeps buckets")
	}
}

func TestProjectLimiterOverrides(t *testing.T) {
	c := newClock()
	pl := NewProjectLimiter(1000, 5000, c.now)
	// default project: burst 5000
	for i := 0; i < 5000; i++ {
		if ok, _ := pl.Allow("def", 0, 0); !ok {
			t.Fatalf("default denied at %d", i)
		}
	}
	if ok, _ := pl.Allow("def", 0, 0); ok {
		t.Fatal("default burst not enforced")
	}
	// project override: 1 rps burst 2
	for i := 0; i < 2; i++ {
		if ok, _ := pl.Allow("small", 1, 2); !ok {
			t.Fatalf("small denied at %d", i)
		}
	}
	if ok, wait := pl.Allow("small", 1, 2); ok || wait != time.Second {
		t.Fatalf("small: ok=%v wait=%v", ok, wait)
	}
	c.advance(time.Second)
	if ok, _ := pl.Allow("small", 1, 2); !ok {
		t.Fatal("small not refilled")
	}
}
