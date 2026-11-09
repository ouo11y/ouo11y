package session

import (
	"encoding/json"
	"testing"
	"time"
)

// Loki streams as they arrive for ouo.attr.* metadata and the OTA bundle
// (docs/specs/attributes.md): attributes leave Attrs, the bundle is lifted.
func TestEventAttributesAndBundle(t *testing.T) {
	ev := eventFromLabels(base, map[string]string{
		"event_name": "cart.added", "session_id": "S", "service_name": "app",
		"ouo_attr_tenant": "acme", "ouo_attr_plan_tier": "3", "ouo_attr_": "empty key ignored",
		"ouo_app_bundle_id": "b-42", "ouo_app_bundle_channel": "production", "cart_items": "2",
	}, "")
	if ev.Attributes["tenant"] != "acme" || ev.Attributes["plan_tier"] != "3" || len(ev.Attributes) != 2 {
		t.Fatalf("attributes: %v", ev.Attributes)
	}
	if ev.BundleID != "b-42" || ev.BundleChannel != "production" {
		t.Fatalf("bundle: %q %q", ev.BundleID, ev.BundleChannel)
	}
	for _, k := range []string{"ouo_attr_tenant", "ouo_attr_plan_tier", "ouo_app_bundle_id", "ouo_app_bundle_channel"} {
		if _, ok := ev.Attrs[k]; ok {
			t.Errorf("%s left in Attrs", k)
		}
	}
	if ev.Attrs["cart_items"] != "2" || ev.Attrs["ouo_attr_"] != "empty key ignored" {
		t.Fatalf("attrs: %v", ev.Attrs)
	}
}

func TestFoldAttributesLatestValueAndFirstBundle(t *testing.T) {
	ev := func(sec int, name string, attrs map[string]string, bundle string) Event {
		return Event{TS: base.Add(time.Duration(sec) * time.Second), Name: name, SessionID: "S", Platform: "mobile",
			ServiceName: "app", ServiceVersion: "1.0.0", Attributes: attrs, BundleID: bundle, Attrs: map[string]string{}}
	}
	evs := []Event{
		ev(0, "session.start", nil, ""),
		ev(1, "screen", map[string]string{"tenant": "acme"}, "b-1"),
		ev(2, "screen", map[string]string{"tenant": "acme", "plan": "free"}, "b-1"),
		ev(3, "screen", map[string]string{"plan": "pro"}, "b-1"), // tenant removed: keeps its last value
		// A crash reported on the next launch, under the next bundle.
		ev(4, "exception", nil, "b-2"),
	}
	rec := FoldOne("S", evs, base.Add(time.Minute), DefaultOptions)
	if rec.Attributes["tenant"] != "acme" || rec.Attributes["plan"] != "pro" || len(rec.Attributes) != 2 {
		t.Fatalf("attributes: %v", rec.Attributes)
	}
	if rec.BundleID != "b-1" {
		t.Fatalf("bundle: %q", rec.BundleID)
	}

	// No attributes, no bundle: the JSON fields are omitted (web sessions unchanged).
	plain := FoldOne("P", []Event{{TS: base, Name: "session.start", SessionID: "P", Attrs: map[string]string{}}}, base, DefaultOptions)
	b, _ := json.Marshal(plain)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for _, k := range []string{"attributes", "bundle_id", "bundle_channel"} {
		if _, ok := m[k]; ok {
			t.Errorf("%s present on a record without it: %s", k, b)
		}
	}
}

func TestHealthBucketsByBundle(t *testing.T) {
	recs := []Record{
		{Platform: "mobile", ServiceName: "app", ServiceVersion: "1.0.0", BundleID: "b-2", Status: StatusCrashed},
		{Platform: "mobile", ServiceName: "app", ServiceVersion: "1.0.0", BundleID: "b-1", Status: StatusHealthy},
		{Platform: "mobile", ServiceName: "app", ServiceVersion: "1.0.0", BundleID: "b-1", Status: StatusErrored},
		{Platform: "mobile", ServiceName: "app", ServiceVersion: "1.0.0", Status: StatusHealthy},
		{Platform: "web", ServiceName: "web", ServiceVersion: "2.0.0", Status: StatusHealthy},
	}
	st := Health(recs)
	if len(st.Buckets) != 4 {
		t.Fatalf("buckets: %+v", st.Buckets)
	}
	got := []string{}
	for _, b := range st.Buckets {
		got = append(got, b.Platform+"/"+b.ServiceVersion+"/"+b.BundleID)
	}
	want := []string{"mobile/1.0.0/", "mobile/1.0.0/b-1", "mobile/1.0.0/b-2", "web/2.0.0/"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order: %v", got)
		}
	}
	if b := st.Buckets[1]; b.Total != 2 || b.HealthyPct != 50 || b.ErroredPct != 50 {
		t.Fatalf("b-1 bucket: %+v", b)
	}
	if st.Totals.Total != 5 {
		t.Fatalf("totals: %+v", st.Totals)
	}
}
