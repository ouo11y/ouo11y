package httpapi

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

// Attribute filters of GET /v1/sessions and /v1/stats/health
// (docs/specs/attributes.md section 7): `attr.<key>=<value>` matches the
// folded session record's attributes[key], `bundle=<id>` its bundle_id.
// They apply to records, never to LogQL: keys and values never reach Loki.

const (
	attrParamPrefix = "attr."
	// maxAttrFilters bounds the attr.* parameters of one request.
	maxAttrFilters = 10
	// maxAttrValueLen matches the SDKs' 128-character cut; the bundle id has
	// the same limit.
	maxAttrValueLen = 128
)

// attrKeyRE is the SDKs' key rule: a letter, then letters, digits and _,
// at most 40 characters.
var attrKeyRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,39}$`)

// recordFilter is the parsed attr.* and bundle parameters.
type recordFilter struct {
	attrs  map[string]string
	bundle string
}

// parseRecordFilter reads attr.<key>=<value> and bundle=<id>. A bad key, a
// repeated key, an empty, over-long or control-character value, or more than
// maxAttrFilters filters is a badRequest.
func parseRecordFilter(q url.Values) (recordFilter, error) {
	var f recordFilter
	keys := make([]string, 0, len(q))
	for name := range q {
		keys = append(keys, name)
	}
	sort.Strings(keys) // deterministic error messages
	for _, name := range keys {
		key, ok := strings.CutPrefix(name, attrParamPrefix)
		if !ok {
			continue
		}
		if !attrKeyRE.MatchString(key) {
			return f, errorf(fmt.Sprintf("attribute filter %q: the key must be a letter, then letters, digits or _, at most 40 characters", name))
		}
		vals := q[name]
		if len(vals) != 1 {
			return f, errorf(fmt.Sprintf("attribute filter %q given more than once", name))
		}
		if err := validFilterValue(vals[0]); err != nil {
			return f, errorf(fmt.Sprintf("attribute filter %q: %v", name, err))
		}
		if f.attrs == nil {
			f.attrs = map[string]string{}
		}
		if len(f.attrs) == maxAttrFilters {
			return f, errorf(fmt.Sprintf("at most %d attribute filters", maxAttrFilters))
		}
		f.attrs[key] = vals[0]
	}
	if b := q.Get("bundle"); b != "" {
		if err := validFilterValue(b); err != nil {
			return f, errorf("bundle: " + err.Error())
		}
		f.bundle = b
	}
	return f, nil
}

func validFilterValue(v string) error {
	if v == "" {
		return fmt.Errorf("the value is empty")
	}
	if !utf8.ValidString(v) {
		return fmt.Errorf("the value is not UTF-8")
	}
	if utf8.RuneCountInString(v) > maxAttrValueLen {
		return fmt.Errorf("the value is longer than %d characters", maxAttrValueLen)
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return fmt.Errorf("the value contains a control character")
		}
	}
	return nil
}

// empty reports whether the filter matches every record.
func (f recordFilter) empty() bool { return len(f.attrs) == 0 && f.bundle == "" }

// match reports whether rec has every filtered attribute value and the bundle.
func (f recordFilter) match(rec *session.Record) bool {
	if f.bundle != "" && rec.BundleID != f.bundle {
		return false
	}
	for k, v := range f.attrs {
		if got, ok := rec.Attributes[k]; !ok || got != v {
			return false
		}
	}
	return true
}
