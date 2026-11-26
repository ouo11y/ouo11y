package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// Settings is the app's jsonData (provisioning/plugins/myorg-sessions-app.yaml in the stack).
// Empty values fall back to the compose service names of guide 00.
type Settings struct {
	LokiURL   string `json:"lokiUrl"`
	MuninnURL string `json:"muninnUrl"`
}

// App is one instance of the plugin backend. Grafana proxies
// /api/plugins/myorg-sessions-app/resources/* to it, with the signed-in user.
type App struct {
	backend.CallResourceHandler
	loki   *ouogo.Loki
	muninn *ouogo.Muninn
}

// NewApp builds an instance from the settings Grafana passes; a settings change makes a new one.
func NewApp(_ context.Context, s backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	cfg := Settings{LokiURL: "http://loki:3100", MuninnURL: "http://muninn:3400"}
	if len(s.JSONData) > 0 {
		if err := json.Unmarshal(s.JSONData, &cfg); err != nil {
			return nil, fmt.Errorf("plugin settings: %w", err)
		}
	}
	app := &App{
		loki: &ouogo.Loki{URL: cfg.LokiURL},
		muninn: &ouogo.Muninn{
			URL:       cfg.MuninnURL,
			Tenant:    "anonymous",
			ReadToken: s.DecryptedSecureJSONData["muninnReadToken"], // a secure field: never sent to browsers
		},
	}
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)
	return app, nil
}
