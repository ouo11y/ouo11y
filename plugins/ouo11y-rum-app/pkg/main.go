// The ouo11y-rum-app backend: the BFF of ADR-0023. Grafana starts it and proxies
// /api/plugins/ouo11y-rum-app/resources/* to it with the signed-in user.
package main

import (
	"os"

	"github.com/grafana/grafana-plugin-sdk-go/backend/app"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ouo11y/ouo11y/plugins/ouo11y-rum-app/pkg/bff"
)

func main() {
	if err := app.Manage("ouo11y-rum-app", bff.NewApp, app.ManageOpts{}); err != nil {
		log.DefaultLogger.Error("plugin backend stopped", "error", err.Error())
		os.Exit(1)
	}
}
