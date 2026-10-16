package loki

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// LinkBuilder builds Grafana Explore deep links to a LogQL query in the Loki
// datasource (same URL shape as tempo.LinkBuilder).
type LinkBuilder struct {
	GrafanaURL    string // e.g. http://localhost:3000
	DatasourceUID string // e.g. loki
	OrgID         int
}

// QueryURL returns an Explore URL (schemaVersion=1, panes JSON) running query over [from, to].
func (b LinkBuilder) QueryURL(query string, from, to time.Time) string {
	pane := map[string]any{
		"datasource": b.DatasourceUID,
		"queries": []map[string]any{{
			"refId":      "A",
			"datasource": map[string]string{"type": "loki", "uid": b.DatasourceUID},
			"expr":       query,
			"queryType":  "range",
			"editorMode": "code",
		}},
		"range": map[string]string{
			"from": strconv.FormatInt(from.UnixMilli(), 10),
			"to":   strconv.FormatInt(to.UnixMilli(), 10),
		},
	}
	panes, _ := json.Marshal(map[string]any{"ouo": pane})
	org := b.OrgID
	if org <= 0 {
		org = 1
	}
	v := url.Values{}
	v.Set("schemaVersion", "1")
	v.Set("orgId", strconv.Itoa(org))
	v.Set("panes", string(panes))
	return strings.TrimRight(b.GrafanaURL, "/") + "/explore?" + v.Encode()
}
