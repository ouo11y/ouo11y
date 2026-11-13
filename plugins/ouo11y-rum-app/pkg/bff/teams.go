package bff

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// teams finds which of the teams named in the Clearance settings a user belongs to, through
// Grafana's HTTP API with the plugin's managed service account (plugin.json "iam": teams:read
// and teams.permissions:read). Grafana does not pass a user's teams to a backend plugin.
// Members of the named teams are cached for teamTTL, so a membership change takes effect
// within that time.
type teams struct {
	grafanaURL string
	http       *http.Client
	// token returns the service account token; replaced in tests.
	token func(ctx context.Context) (string, error)

	mu      sync.Mutex
	members map[string]map[string]bool // team name -> lowercased logins
	until   time.Time
}

const teamTTL = time.Minute

func newTeams(grafanaURL string) *teams {
	return &teams{
		grafanaURL: strings.TrimRight(grafanaURL, "/"),
		http:       &http.Client{Timeout: 10 * time.Second},
		token: func(ctx context.Context) (string, error) {
			return backend.GrafanaConfigFromContext(ctx).PluginAppClientSecret()
		},
	}
}

// of returns the teams among names that login belongs to.
func (t *teams) of(ctx context.Context, names []string, login string) ([]string, error) {
	if len(names) == 0 || login == "" {
		return nil, nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.members == nil || time.Now().After(t.until) {
		members, err := t.load(ctx, names)
		if err != nil {
			return nil, err
		}
		t.members, t.until = members, time.Now().Add(teamTTL)
	}
	var out []string
	for _, n := range names {
		if t.members[n][strings.ToLower(login)] {
			out = append(out, n)
		}
	}
	return out, nil
}

func (t *teams) load(ctx context.Context, names []string) (map[string]map[string]bool, error) {
	token, err := t.token(ctx)
	if err != nil || token == "" {
		return nil, errors.New("no service account token for the plugin (enable Grafana's managed service accounts)")
	}
	out := map[string]map[string]bool{}
	for _, name := range names {
		var found struct {
			Teams []struct {
				ID   int64  `json:"id"`
				Name string `json:"name"`
			} `json:"teams"`
		}
		if err := t.get(ctx, token, "/api/teams/search?perpage=100&name="+url.QueryEscape(name), &found); err != nil {
			return nil, err
		}
		logins := map[string]bool{}
		for _, team := range found.Teams {
			if team.Name != name {
				continue
			}
			var members []struct {
				Login string `json:"login"`
			}
			if err := t.get(ctx, token, fmt.Sprintf("/api/teams/%d/members", team.ID), &members); err != nil {
				return nil, err
			}
			for _, m := range members {
				logins[strings.ToLower(m.Login)] = true
			}
		}
		out[name] = logins
	}
	return out, nil
}

func (t *teams) get(ctx context.Context, token, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, t.grafanaURL+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := t.http.Do(req)
	if err != nil {
		return fmt.Errorf("grafana %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("grafana %s: %s", path, resp.Status)
	}
	return json.Unmarshal(body, v)
}
