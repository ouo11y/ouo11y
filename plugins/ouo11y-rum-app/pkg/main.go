// The backend of ouo11y-rum-datasource, the datasource nested in the ouo11y-rum-app plugin:
// the BFF of ADR-0023. Grafana starts it and proxies
// /api/datasources/uid/<uid>/resources/* to it with the signed-in user and, when the
// datasource sets oauthPassThru, the user's identity-provider tokens (ADR-0024).
package main

import (
	"os"

	"github.com/grafana/grafana-plugin-sdk-go/backend/datasource"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ouo11y/ouo11y/plugins/ouo11y-rum-app/pkg/bff"
)

func main() {
	if err := datasource.Manage("ouo11y-rum-datasource", bff.NewDatasource, datasource.ManageOpts{}); err != nil {
		log.DefaultLogger.Error("plugin backend stopped", "error", err.Error())
		os.Exit(1)
	}
}
