package funnel

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// Step conditions (ADR-0019): `where key=value` on event steps and on the
// failure event, translated to LogQL label filters on structured metadata.

// Limits of conditions.
const (
	MaxConditions = 5
	MaxKeyLen     = 128
)

// Op is a condition operator. All three are LogQL label-filter matchers
// evaluated per line on the streams the event name already selected.
type Op string

const (
	OpEq    Op = "="
	OpNeq   Op = "!="
	OpRegex Op = "=~" // RE2, fully anchored, as in Loki
)

// Condition is one `key op value` test on an event attribute.
type Condition struct {
	// Key is the OpenTelemetry attribute name as sent by the SDK
	// (payment.method); LokiKey is what Loki stores (payment_method).
	Key   string `json:"key"`
	Op    Op     `json:"op,omitempty"` // default =
	Value string `json:"value"`

	re *regexp.Regexp // OpRegex, compiled by Validate
}

// keyPattern is an attribute name as the SDKs send it. After LokiKey only
// [A-Za-z0-9_] remain, so a key never needs quoting in LogQL.
var keyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.\-]*$`)

// LokiKey is the Loki structured-metadata name of the key: Loki's OTLP
// ingest replaces every character outside [A-Za-z0-9_] with _.
func (c Condition) LokiKey() string {
	return strings.Map(func(r rune) rune {
		if r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, c.Key)
}

// Validate checks the condition, fills the default operator and compiles a
// regex. Keys are restricted to attribute-name characters and values to
// printable UTF-8, so the LogQL (values rendered with strconv.Quote) cannot
// be broken out of.
func (c *Condition) Validate() error {
	if c.Key == "" || len(c.Key) > MaxKeyLen || !keyPattern.MatchString(c.Key) {
		return fmt.Errorf("condition key %q: want an attribute name (letters, digits, _ . -; 1 to %d characters, not starting with a digit)", c.Key, MaxKeyLen)
	}
	switch k := c.LokiKey(); {
	case k == "event_name":
		return errors.New("condition key event.name: the step value is the event name")
	case !session.Retained(k):
		return fmt.Errorf("condition key %q: rum-api does not read this SDK constant", c.Key)
	}
	if c.Op == "" {
		c.Op = OpEq
	}
	if len(c.Value) > MaxValueLen || !utf8.ValidString(c.Value) || strings.IndexFunc(c.Value, unicode.IsControl) >= 0 {
		return fmt.Errorf("condition %s: value must be printable UTF-8, at most %d bytes", c.Key, MaxValueLen)
	}
	switch c.Op {
	case OpEq, OpNeq:
	case OpRegex:
		if c.Value == "" {
			return fmt.Errorf("condition %s =~: empty regex", c.Key)
		}
		re, err := regexp.Compile(`^(?:` + c.Value + `)$`)
		if err != nil {
			return fmt.Errorf("condition %s =~: %w", c.Key, err)
		}
		c.re = re
	default:
		return fmt.Errorf("condition %s: operator must be =, != or =~, got %q", c.Key, c.Op)
	}
	return nil
}

// Matches applies the condition to an event the way the LogQL label filter
// does: a missing key reads as "".
func (c Condition) Matches(ev session.Event) bool {
	v := ev.Value(c.LokiKey())
	switch c.Op {
	case OpNeq:
		return v != c.Value
	case OpRegex:
		re := c.re
		if re == nil {
			var err error
			if re, err = regexp.Compile(`^(?:` + c.Value + `)$`); err != nil {
				return false
			}
		}
		return re.MatchString(v)
	}
	return v == c.Value
}

// LogQL is the label filter, e.g. payment_method="card". The key is
// [A-Za-z0-9_] only (Validate, LokiKey) and the value a Go-quoted string,
// which LogQL reads with the same escapes.
func (c Condition) LogQL() string {
	op := c.Op
	if op == "" {
		op = OpEq
	}
	return c.LokiKey() + string(op) + strconv.Quote(c.Value)
}

// String is the compact form: key=value, quoted when the value is not a
// plain token (payment.method=card, note="two words").
func (c Condition) String() string {
	op := c.Op
	if op == "" {
		op = OpEq
	}
	v := c.Value
	if v == "" || strings.IndexFunc(v, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && !strings.ContainsRune("_.:/@+-", r)
	}) >= 0 {
		v = strconv.Quote(v)
	}
	return c.Key + string(op) + v
}

// whereSep starts the conditions in the compact step form.
const whereSep = " where "

// parseConditions reads `k=v and k2!="x y" and k3=~"a|b"`. A value is either
// a Go-quoted string or a bare token without spaces.
func parseConditions(s string) ([]Condition, error) {
	var out []Condition
	for {
		s = strings.TrimLeft(s, " ")
		i := strings.IndexAny(s, "=!")
		if i <= 0 {
			return nil, fmt.Errorf("condition %q: want key=value, key!=value or key=~regex", s)
		}
		c := Condition{Key: strings.TrimSpace(s[:i])}
		s = s[i:]
		switch {
		case strings.HasPrefix(s, "!="):
			c.Op, s = OpNeq, s[2:]
		case strings.HasPrefix(s, "=~"):
			c.Op, s = OpRegex, s[2:]
		case strings.HasPrefix(s, "="):
			c.Op, s = OpEq, s[1:]
		default:
			return nil, fmt.Errorf("condition %q: want =, != or =~", c.Key)
		}
		s = strings.TrimLeft(s, " ")
		switch {
		case strings.HasPrefix(s, `"`):
			q, err := strconv.QuotedPrefix(s)
			if err != nil {
				return nil, fmt.Errorf("condition %s: bad quoted value", c.Key)
			}
			c.Value, _ = strconv.Unquote(q)
			s = s[len(q):]
		default: // a bare token ends at the next space
			j := strings.IndexByte(s, ' ')
			if j < 0 {
				j = len(s)
			}
			c.Value, s = s[:j], s[j:]
		}
		out = append(out, c)
		s = strings.TrimLeft(s, " ")
		if s == "" {
			return out, nil
		}
		if !strings.HasPrefix(s, "and ") {
			return nil, fmt.Errorf("conditions: want \" and \" between conditions, got %q", s)
		}
		s = s[len("and "):]
	}
}

// ConditionsLogQL joins one step's conditions with and.
func ConditionsLogQL(cs []Condition) string {
	parts := make([]string, len(cs))
	for i, c := range cs {
		parts[i] = c.LogQL()
	}
	return strings.Join(parts, " and ")
}

func conditionsString(cs []Condition) string {
	parts := make([]string, len(cs))
	for i, c := range cs {
		parts[i] = c.String()
	}
	return strings.Join(parts, " and ")
}
