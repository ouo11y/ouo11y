package timerange

import (
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		in   string
		want time.Time
		err  bool
	}{
		{"now", now, false},
		{"now-1h", now.Add(-time.Hour), false},
		{"now-30m", now.Add(-30 * time.Minute), false},
		{"now-2d", now.Add(-48 * time.Hour), false},
		{"now-1w", now.Add(-7 * 24 * time.Hour), false},
		{"now+5m", now.Add(5 * time.Minute), false},
		{"2026-10-06T10:00:00Z", now.Add(-2 * time.Hour), false},
		{"1791280800", now.Add(-2 * time.Hour), false},
		{"1791280800000", now.Add(-2 * time.Hour), false},
		{"", time.Time{}, true},
		{"yesterday", time.Time{}, true},
		{"now-", time.Time{}, true},
		{"now1h", time.Time{}, true},
	}
	for _, c := range cases {
		got, err := Parse(c.in, now)
		if c.err {
			if err == nil {
				t.Errorf("%q: expected error, got %v", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if !got.Equal(c.want) {
			t.Errorf("%q: got %v want %v", c.in, got, c.want)
		}
	}
}

func TestRange(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	from, to, err := Range("", "", now, time.Hour)
	if err != nil || !from.Equal(now.Add(-time.Hour)) || !to.Equal(now) {
		t.Fatalf("defaults: %v %v %v", from, to, err)
	}
	if _, _, err := Range("now", "now-1h", now, time.Hour); err == nil {
		t.Fatal("expected from>to error")
	}
}
