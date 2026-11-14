// Package ouogo reads ouo's RUM data as plain typed functions: sessions and their events
// from Loki (the client SDK spec's wire), replays from Muninn (docs/specs/muninn.md).
//
// The reads return the data as stored. Who may see what is the caller's decision: ouogo
// has no notion of users, roles or levels. The optional sub-packages help with that
// decision without making it: redact filters attributes, oidc verifies an ID token.
package ouogo

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"time"
)

// defaultHTTP is the client of a Loki or Muninn reader whose HTTP is nil: a store that
// hangs must not hang the caller when its context has no deadline.
var defaultHTTP = &http.Client{Timeout: 30 * time.Second}

func httpClient(c *http.Client) *http.Client {
	if c != nil {
		return c
	}
	return defaultHTTP
}

// ErrNotFound is a session or replay the store has no record of.
var ErrNotFound = errors.New("not found")

// BadRequestError is an invalid identifier or parameter. Nothing was sent to a store.
type BadRequestError struct{ Msg string }

func (e *BadRequestError) Error() string { return e.Msg }

// BackendError is a failure of Loki or Muninn. Its message may carry internal URLs,
// queries and store answers: log it, and show a user Public().
type BackendError struct {
	Backend string
	Err     error
}

func (e *BackendError) Error() string { return e.Backend + ": " + e.Err.Error() }

// Public is the message a caller may show a user: no URLs, queries or store answers.
func (e *BackendError) Public() string { return e.Backend + " could not be read" }
func (e *BackendError) Unwrap() error  { return e.Err }

// Identifiers are checked before they reach a query or a path, so quotes, backslashes,
// braces and slashes cannot get into LogQL or a Muninn URL.
var (
	reHex32   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	reProject = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
)

func checkID(kind, v string) error {
	if !reHex32.MatchString(v) {
		return &BadRequestError{Msg: fmt.Sprintf("%s must be 32 lowercase hex characters", kind)}
	}
	return nil
}

func checkProject(v string) error {
	if !reProject.MatchString(v) {
		return &BadRequestError{Msg: "project must match ^[a-z0-9][a-z0-9._-]{0,63}$"}
	}
	return nil
}

func checkReplayIDs(project, session, replay string) error {
	if err := checkProject(project); err != nil {
		return err
	}
	if err := checkID("session", session); err != nil {
		return err
	}
	return checkID("replay", replay)
}

// TimeRange is a closed query window. Zero values mean the last 24 hours; at most 30 days.
type TimeRange struct {
	From, To time.Time
}

func (r TimeRange) window(now func() time.Time) (time.Time, time.Time, error) {
	if now == nil {
		now = time.Now
	}
	to := r.To
	if to.IsZero() {
		to = now()
	}
	from := r.From
	if from.IsZero() {
		from = to.Add(-24 * time.Hour)
	}
	if !from.Before(to) {
		return time.Time{}, time.Time{}, &BadRequestError{Msg: "from must be before to"}
	}
	if to.Sub(from) > 30*24*time.Hour {
		return time.Time{}, time.Time{}, &BadRequestError{Msg: "time range longer than 30 days"}
	}
	return from, to, nil
}

func orDefault(n, d int) int {
	if n > 0 {
		return n
	}
	return d
}
