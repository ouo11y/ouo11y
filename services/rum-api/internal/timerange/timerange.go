// Package timerange parses the from/to query parameters accepted by the API:
// RFC 3339 timestamps, Unix seconds or milliseconds, and Grafana-style
// relative expressions such as "now", "now-1h", "now-30m", "now-7d".
package timerange

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Parse turns one from/to value into a time. now is injected for tests.
func Parse(v string, now time.Time) (time.Time, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, fmt.Errorf("empty time")
	}
	if strings.HasPrefix(v, "now") {
		rest := strings.TrimPrefix(v, "now")
		if rest == "" {
			return now, nil
		}
		if rest[0] != '-' && rest[0] != '+' {
			return time.Time{}, fmt.Errorf("invalid relative time %q", v)
		}
		d, err := parseDuration(rest[1:])
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid relative time %q: %w", v, err)
		}
		if rest[0] == '-' {
			return now.Add(-d), nil
		}
		return now.Add(d), nil
	}
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return t, nil
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		switch {
		case n > 1e17: // nanoseconds
			return time.Unix(0, n), nil
		case n > 1e11: // milliseconds
			return time.UnixMilli(n), nil
		default:
			return time.Unix(n, 0), nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognised time %q (want RFC3339, unix seconds/millis or now-1h)", v)
}

// parseDuration accepts Go durations plus d (days) and w (weeks).
func parseDuration(s string) (time.Duration, error) {
	if s == "" {
		return 0, fmt.Errorf("empty duration")
	}
	unit := s[len(s)-1]
	if unit == 'd' || unit == 'w' {
		n, err := strconv.ParseFloat(s[:len(s)-1], 64)
		if err != nil {
			return 0, err
		}
		mult := 24 * time.Hour
		if unit == 'w' {
			mult = 7 * 24 * time.Hour
		}
		return time.Duration(n * float64(mult)), nil
	}
	return time.ParseDuration(s)
}

// Range resolves from/to with defaults (from defaults to now-defaultFrom,
// to defaults to now) and validates from < to.
func Range(from, to string, now time.Time, defaultFrom time.Duration) (time.Time, time.Time, error) {
	start := now.Add(-defaultFrom)
	end := now
	var err error
	if from != "" {
		if start, err = Parse(from, now); err != nil {
			return start, end, fmt.Errorf("from: %w", err)
		}
	}
	if to != "" {
		if end, err = Parse(to, now); err != nil {
			return start, end, fmt.Errorf("to: %w", err)
		}
	}
	if !start.Before(end) {
		return start, end, fmt.Errorf("from (%s) must be before to (%s)", start.Format(time.RFC3339), end.Format(time.RFC3339))
	}
	return start, end, nil
}
