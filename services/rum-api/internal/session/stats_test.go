package session

import (
	"encoding/json"
	"testing"
	"time"
)

func TestEventProjectID(t *testing.T) {
	ev := eventFromLabels(time.Unix(1, 0), map[string]string{"event_name": "session.start", "session_id": "s", "ouo_project_id": "shop"}, "")
	if ev.ProjectID != "shop" || ev.Attrs["ouo_project_id"] != "shop" {
		t.Fatalf("project id must be lifted and stay in attrs: %+v", ev)
	}
	rec := FoldOne("s", []Event{ev}, time.Unix(2, 0), Options{})
	if rec.ProjectID != "shop" {
		t.Fatalf("record project %q", rec.ProjectID)
	}
}

func TestHealthApps(t *testing.T) {
	recs := []Record{
		{ProjectID: "shop", ServiceName: "shop-rn", Platform: "mobile", ServiceVersion: "1", Status: StatusHealthy},
		{ProjectID: "shop", ServiceName: "shop-rn", Platform: "mobile", ServiceVersion: "2", Status: StatusCrashed},
		{ProjectID: "shop", ServiceName: "shop-rn", Platform: "web", ServiceVersion: "2", Status: StatusErrored},
		{ProjectID: "bank", ServiceName: "bank-web", Platform: "web", ServiceVersion: "1", Status: StatusHealthy},
		{ServiceName: "legacy", Platform: "web", Status: StatusHealthy},
	}
	h := Health(recs)
	if len(h.Buckets) != 5 || h.Buckets[0].ProjectID != "" || h.Buckets[1].ProjectID != "bank" {
		t.Fatalf("buckets %+v", h.Buckets)
	}
	b, _ := json.Marshal(h.Apps)
	want := `[{"project_id":"","service_name":"legacy","platforms":["web"],"total":1,"healthy":1,"errored":0,"crashed":0,"healthy_pct":100,"errored_pct":0,"crashed_pct":0},` +
		`{"project_id":"bank","service_name":"bank-web","platforms":["web"],"total":1,"healthy":1,"errored":0,"crashed":0,"healthy_pct":100,"errored_pct":0,"crashed_pct":0},` +
		`{"project_id":"shop","service_name":"shop-rn","platforms":["mobile","web"],"total":3,"healthy":1,"errored":1,"crashed":1,"healthy_pct":33.33,"errored_pct":33.33,"crashed_pct":33.33}]`
	if string(b) != want {
		t.Fatalf("apps\n got %s\nwant %s", b, want)
	}
	if h.Totals.Total != 5 || h.Totals.HealthyPct != 60 {
		t.Fatalf("totals %+v", h.Totals)
	}
	// The bucket JSON stays flat (Counts is embedded).
	bb, _ := json.Marshal(h.Buckets[1])
	if string(bb) != `{"project_id":"bank","platform":"web","service_name":"bank-web","service_version":"1","total":1,"healthy":1,"errored":0,"crashed":0,"healthy_pct":100,"errored_pct":0,"crashed_pct":0}` {
		t.Fatalf("bucket json %s", bb)
	}
	if e := Health(nil); e.Apps == nil || len(e.Apps) != 0 {
		t.Fatalf("empty apps must be [] not null: %+v", e)
	}
}
