package httpapi

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ouo11y/ouo11y/services/rum-api/internal/session"
)

func TestParseRecordFilter(t *testing.T) {
	f, err := parseRecordFilter(url.Values{"attr.tenant": {"acme"}, "attr.plan_tier": {"3"}, "bundle": {"b-1"}, "user": {"u"}})
	if err != nil || f.attrs["tenant"] != "acme" || f.attrs["plan_tier"] != "3" || len(f.attrs) != 2 || f.bundle != "b-1" {
		t.Fatalf("%+v %v", f, err)
	}
	if f, err := parseRecordFilter(url.Values{}); err != nil || !f.empty() {
		t.Fatalf("empty: %+v %v", f, err)
	}
	// LogQL / injection-shaped and malformed input is a 400, never passed on.
	bad := []url.Values{
		{"attr.": {"x"}},
		{"attr.ten-ant": {"x"}},
		{"attr.a.b": {"x"}},
		{"attr._x": {"x"}},
		{`attr.x"} |= "`: {"x"}},
		{"attr." + strings.Repeat("k", 41): {"x"}},
		{"attr.tenant": {""}},
		{"attr.tenant": {"a", "b"}},
		{"attr.tenant": {strings.Repeat("v", 129)}},
		{"attr.tenant": {"acme\n} | line_format"}},
		{"attr.tenant": {"\x00"}},
		{"attr.tenant": {string([]byte{0xff, 0xfe})}},
		{"bundle": {"b\r\n"}},
	}
	for _, q := range bad {
		if _, err := parseRecordFilter(q); err == nil {
			t.Errorf("%v: want an error", q)
		} else if _, ok := err.(badRequest); !ok {
			t.Errorf("%v: want badRequest, got %T", q, err)
		}
	}
	// Quotes, braces and pipes in a value are just characters: values never reach LogQL.
	if f, err := parseRecordFilter(url.Values{"attr.tenant": {`a"} |~ ".*`}}); err != nil || f.attrs["tenant"] != `a"} |~ ".*` {
		t.Fatalf("quoted value: %+v %v", f, err)
	}
	many := url.Values{}
	for i := 0; i < maxAttrFilters+1; i++ {
		many.Set("attr.k"+strings.Repeat("x", i), "v")
	}
	if _, err := parseRecordFilter(many); err == nil {
		t.Fatal("more than maxAttrFilters filters accepted")
	}
	// 128 characters (not bytes) is the limit.
	if _, err := parseRecordFilter(url.Values{"attr.city": {strings.Repeat("é", 128)}}); err != nil {
		t.Fatalf("128 runes: %v", err)
	}
}

func TestRecordFilterMatch(t *testing.T) {
	rec := &session.Record{Attributes: map[string]string{"tenant": "acme", "plan": "pro"}, BundleID: "b-1"}
	cases := []struct {
		f    recordFilter
		want bool
	}{
		{recordFilter{}, true},
		{recordFilter{attrs: map[string]string{"tenant": "acme"}}, true},
		{recordFilter{attrs: map[string]string{"tenant": "acme", "plan": "pro"}, bundle: "b-1"}, true},
		{recordFilter{attrs: map[string]string{"tenant": "acme", "plan": "free"}}, false},
		{recordFilter{attrs: map[string]string{"region": ""}}, false},
		{recordFilter{bundle: "b-2"}, false},
	}
	for i, c := range cases {
		if got := c.f.match(rec); got != c.want {
			t.Errorf("case %d: got %v", i, got)
		}
	}
	if (recordFilter{attrs: map[string]string{"tenant": "acme"}}).match(&session.Record{}) {
		t.Error("a record without attributes matched")
	}
}

// The filter applies to the folded record: an attribute set after
// session.start still selects the whole session, and the Loki query is the
// unfiltered one (keys and values never reach LogQL).
func TestListSessionsAttributeFilter(t *testing.T) {
	ts, fe, _ := newTestServer(t)
	last := fe.events[len(fe.events)-1].TS
	fe.events = append(fe.events,
		session.Event{TS: last.Add(time.Second), Name: "screen", SessionID: "mobile-1", UserID: "m1", Platform: "mobile", ServiceName: "mobile-store", ServiceVersion: "9.9.9",
			Attributes: map[string]string{"tenant": "acme"}, BundleID: "b-7", Attrs: map[string]string{}},
	)
	var list listResponse
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h&attr.tenant=acme", &list); code != 200 || list.Count != 1 || list.Sessions[0].SessionID != "mobile-1" {
		t.Fatalf("attr filter: %d %+v", code, list)
	}
	if s := list.Sessions[0]; s.Attributes["tenant"] != "acme" || s.BundleID != "b-7" {
		t.Fatalf("record: %+v", s)
	}
	if fl := fe.filters[len(fe.filters)-1]; fl.Platform != "" || fl.Service != "" || fl.Version != "" || fl.User != "" || fl.SessionID != "" {
		t.Fatalf("attribute filter leaked into the Loki filters: %+v", fl)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h&attr.tenant=other", &list); code != 200 || list.Count != 0 {
		t.Fatalf("no match: %+v", list)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h&bundle=b-7", &list); code != 200 || list.Count != 1 {
		t.Fatalf("bundle filter: %+v", list)
	}
	if code := getJSON(t, ts.URL+"/v1/sessions?from=now-2h&"+url.Values{"attr.x\"}": {"v"}}.Encode(), nil); code != http.StatusBadRequest {
		t.Fatalf("bad key: %d", code)
	}

	var st statsResponse
	if code := getJSON(t, ts.URL+"/v1/stats/health?from=now-2h&attr.tenant=acme", &st); code != 200 || st.Totals.Total != 1 || len(st.Buckets) != 1 || st.Buckets[0].BundleID != "b-7" {
		t.Fatalf("health with attr filter: %d %+v", code, st)
	}
	if code := getJSON(t, ts.URL+"/v1/stats/health?from=now-2h&attr.=x", nil); code != http.StatusBadRequest {
		t.Fatalf("health bad key: %d", code)
	}
}
