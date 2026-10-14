package loki

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestQueryURL(t *testing.T) {
	from := time.UnixMilli(1791937900000)
	to := from.Add(10 * time.Minute)
	u := LinkBuilder{GrafanaURL: "http://localhost:3003/", DatasourceUID: "loki"}.QueryURL(`{service_name=~".+"} | session_id="s1"`, from, to)
	if !strings.HasPrefix(u, "http://localhost:3003/explore?") {
		t.Fatalf("url %s", u)
	}
	q, _ := url.ParseQuery(strings.SplitN(u, "?", 2)[1])
	if q.Get("schemaVersion") != "1" || q.Get("orgId") != "1" {
		t.Errorf("params %v", q)
	}
	var panes map[string]struct {
		Datasource string `json:"datasource"`
		Queries    []struct {
			Expr       string            `json:"expr"`
			Datasource map[string]string `json:"datasource"`
		} `json:"queries"`
		Range map[string]string `json:"range"`
	}
	if err := json.Unmarshal([]byte(q.Get("panes")), &panes); err != nil {
		t.Fatal(err)
	}
	p := panes["ouo"]
	if p.Datasource != "loki" || p.Queries[0].Expr != `{service_name=~".+"} | session_id="s1"` || p.Queries[0].Datasource["type"] != "loki" ||
		p.Range["from"] != "1791937900000" || p.Range["to"] != "1791938500000" {
		t.Errorf("pane %+v", p)
	}
}
