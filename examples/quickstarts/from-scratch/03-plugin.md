# 03. Build your own Grafana plugin on ouo data

The fourth guide of the [from-scratch series](README.md). You build **Sessions**, a Grafana app
plugin of your own: a Go backend that reads sessions from Loki and replays from Muninn with
[`ouo-go`](../../../libs/ouo-go/README.md) and decides who sees the user's identity, and a React
frontend that lists sessions and plays the web replay with [`@ouo11y/kit`](../../../libs/ouo-kit/README.md).
It runs in the Grafana of [guide 00](00-stack.md), on the sessions of guides
[01](01-web.md) and [02](02-react-native.md). Plan on about 30 minutes.

Why your own: ouo ships the data and generic libraries, and each client owns its plugin, its
backend and its access model ([ADR-0025](../../../docs/adr/0025-generic-libs-clients-own-plugin-and-access.md)).
This guide is the smallest such plugin.

```
ouo-from-scratch/
├── stack/            guide 00; this guide changes 50-grafana/
├── web/              guide 01: makes the sessions you will look at
└── plugin/           this guide, scaffolded by @grafana/create-plugin
    ├── go.mod        Go module, with ouo-go
    ├── pkg/
    │   ├── main.go               scaffolded: starts the backend
    │   └── plugin/
    │       ├── app.go            settings: where Loki and Muninn are, Muninn's read token
    │       ├── resources.go      four routes, and your access rule
    │       └── resources_test.go the access rule, tested without Grafana
    ├── src/
    │   ├── plugin.json           one page, a backend
    │   ├── module.tsx, constants.ts, api.ts
    │   ├── components/App/App.tsx  two routes
    │   └── pages/Sessions.tsx, Session.tsx
    └── dist/          the build Grafana loads: module.js and gpx_sessions_linux_*
```

How a request travels:

```
browser ─► Grafana /api/plugins/myorg-sessions-app/resources/sessions ─► your Go backend
            (signed-in user attached)                                    ├─ ouo-go Loki   ─► Loki
                                                                         └─ ouo-go Muninn ─► Muninn (read token)
```

The browser never sees Loki, Muninn or the read token: only your backend's answers.

Every command goes in its own block: run them one by one, in order. Paths are relative to
`ouo-from-scratch/`. When a step says "replace the file", select everything in it and paste the
new content over it.

## Step 0. Check your tools

Node 24 or newer, and Go 1.26 or newer:

```bash
node -v
```

```bash
go version
```

The stack of guide 00 is up, and you made at least one web session in guide 01 within the last 24
hours (the plugin lists the last 24 hours).

## Step 1. Scaffold the plugin

Grafana's scaffolder writes an app plugin with a Go backend, its build config and its tooling.
From `ouo-from-scratch/`:

```bash
npx @grafana/create-plugin@9.0.3 --pluginType=app --hasBackend --pluginName=sessions --orgName=myorg
```

It writes `myorg-sessions-app/`: the plugin id is `<org>-<name>-app`. Call the folder `plugin`:

```bash
mv myorg-sessions-app plugin
```

```bash
cd plugin
```

```bash
npm install
```

**Remove what this plugin does not use**: the four example pages, the configuration page (the
stack provisions the settings in step 5), their tests, and the scaffold's own Grafana
(`docker-compose.yaml`, `provisioning/`), since the plugin runs in your stack's Grafana:

```bash
rm -r src/pages src/components/AppConfig src/components/testIds.ts src/utils src/components/App/App.test.tsx tests provisioning docker-compose.yaml
```

The scaffolder also writes files for coding agents (`AGENTS.md`, `CLAUDE.md`, `.claude/`, ...)
and GitHub workflows (`.github/`). This guide does not use them; keep them or delete them.

## Step 2. The backend

**Add `ouo-go`**, the readers for ouo's data. The repository is public, so the Go module proxy
serves it like any module:

```bash
go get github.com/ouo11y/ouo11y/libs/ouo-go@v0.2.0
```

| Module | What it does in this plugin |
|---|---|
| `github.com/grafana/grafana-plugin-sdk-go` | Scaffolded: runs the backend as a Grafana plugin, passes it the settings and the signed-in user, and turns resource calls into `http.Request`s (`httpadapter`) |
| `github.com/ouo11y/ouo11y/libs/ouo-go` | Typed readers: `Loki.ListSessions`, `Loki.SessionEvents`, `Muninn.ListReplays`, `Muninn.Manifest`, `Muninn.Chunk`. It checks every id before it reaches LogQL or a Muninn path, and decides nothing about who sees what |
| `github.com/ouo11y/ouo11y/libs/ouo-go/redact` | Optional filters: `redact.Identity` matches `enduser.*`, `user.id`, `client.address` and the rest, in both the `.` and Loki's `_` spelling |

**The settings.** Grafana gives each plugin instance its `jsonData` (readable by every signed-in
user) and its decrypted `secureJsonData` (never sent to a browser). The read token goes in the
second. Replace `plugin/pkg/plugin/app.go`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/pkg/plugin/app.go -->
```go
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
```

**The routes, and your access model.** Four `GET` routes, one per thing the pages need. Grafana
proxies `/api/plugins/myorg-sessions-app/resources/<path>` to them with the signed-in user, whose
org role `hideIdentity` reads: this plugin lets Viewers see sessions but never who the user was.
That one function is the access model; yours can read teams, identity-provider groups, a ladder of
levels, or allow everything. Store errors carry internal URLs and queries, so `writeErr` logs them
and answers the browser `BackendError.Public()`. Replace `plugin/pkg/plugin/resources.go`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/pkg/plugin/resources.go -->
```go
package plugin

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
	"github.com/ouo11y/ouo11y/libs/ouo-go/redact"
)

func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /sessions", a.sessions)
	mux.HandleFunc("GET /sessions/{project}/{session}", a.session)
	mux.HandleFunc("GET /sessions/{project}/{session}/replays/{replay}", a.manifest)
	mux.HandleFunc("GET /sessions/{project}/{session}/replays/{replay}/streams/{stream}/chunks/{seq}", a.chunk)
}

// Your access model goes here. This one: Grafana Viewers never see who the user was.
// Editors and Admins see everything. Replace it with yours (teams, IdP groups, nothing).
func hideIdentity(r *http.Request) bool {
	u := backend.UserFromContext(r.Context())
	return u == nil || (u.Role != "Admin" && u.Role != "Editor")
}

// GET /sessions: the sessions of the last 24 hours, newest first.
func (a *App) sessions(w http.ResponseWriter, r *http.Request) {
	list, err := a.loki.ListSessions(r.Context(), ouogo.SessionQuery{Project: r.URL.Query().Get("project")})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if hideIdentity(r) {
		redact.Sessions(list.Sessions, redact.Identity)
	}
	writeJSON(w, list)
}

type sessionAnswer struct {
	*ouogo.SessionEvents
	Replays []ouogo.ReplaySummary `json:"replays"`
}

// GET /sessions/{project}/{session}: the session's events from Loki and its replays from Muninn.
func (a *App) session(w http.ResponseWriter, r *http.Request) {
	project, session := r.PathValue("project"), r.PathValue("session")
	events, err := a.loki.SessionEvents(r.Context(), project, session, ouogo.TimeRange{})
	if err != nil {
		writeErr(w, r, err)
		return
	}
	replays, err := a.muninn.ListReplays(r.Context(), project, session)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if hideIdentity(r) {
		redact.Session(&events.Session, redact.Identity)
		redact.Events(events.Events, redact.Identity)
	}
	writeJSON(w, sessionAnswer{SessionEvents: events, Replays: replays})
}

// GET .../replays/{replay}: the replay's manifest, what @ouo11y/kit's ReplayPlayer plays.
func (a *App) manifest(w http.ResponseWriter, r *http.Request) {
	m, err := a.muninn.Manifest(r.Context(), r.PathValue("project"), r.PathValue("session"), r.PathValue("replay"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if hideIdentity(r) {
		redact.Manifest(m, redact.Identity)
	}
	writeJSON(w, m)
}

// GET .../streams/{stream}/chunks/{seq}: one chunk's bytes, decompressed.
func (a *App) chunk(w http.ResponseWriter, r *http.Request) {
	seq, err := strconv.ParseInt(r.PathValue("seq"), 10, 64)
	if err != nil {
		writeErr(w, r, &ouogo.BadRequestError{Msg: "sequence must be an integer"})
		return
	}
	c, err := a.muninn.Chunk(r.Context(), r.PathValue("project"), r.PathValue("session"),
		r.PathValue("replay"), r.PathValue("stream"), seq)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(c.Body)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store") // a changed access rule applies at once
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr logs the full error (it carries store URLs and queries) and answers a short one.
func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var bad *ouogo.BadRequestError
	var store *ouogo.BackendError
	switch {
	case errors.As(err, &bad):
		http.Error(w, bad.Msg, http.StatusBadRequest)
	case errors.Is(err, ouogo.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.As(err, &store):
		log.DefaultLogger.Error("store read failed", "path", r.URL.Path, "error", store.Error())
		http.Error(w, store.Public(), http.StatusBadGateway)
	default:
		log.DefaultLogger.Error("request failed", "path", r.URL.Path, "error", err.Error())
		http.Error(w, "internal error", http.StatusInternalServerError)
	}
}
```

**A test of the access rule, without Grafana.** It calls the backend the way Grafana does
(`CallResource` with the user in the plugin context) against a fake Loki. Replace
`plugin/pkg/plugin/resources_test.go`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/pkg/plugin/resources_test.go -->
```go
package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// A fake Loki that answers one session of user alice, the way Loki answers a query_range.
func fakeLoki(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/query") { // the "has replay" hint: none
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"streams","result":[{"stream":{
			"ouo_project_id":"demo","session_id":"0123456789abcdef0123456789abcdef",
			"service_name":"tiny-shop-web","event_name":"session.start","enduser_id":"alice"},
			"values":[["1794699403167000000",""]]}]}}`))
	}))
}

func call(t *testing.T, app *App, role, path string) (int, string) {
	t.Helper()
	var status int
	var body []byte
	err := app.CallResource(
		context.Background(),
		&backend.CallResourceRequest{
			PluginContext: backend.PluginContext{User: &backend.User{Login: "u", Role: role}}, // what Grafana sends
			Method:        http.MethodGet, Path: path, URL: path,
		},
		backend.CallResourceResponseSenderFunc(func(res *backend.CallResourceResponse) error {
			status, body = res.Status, res.Body
			return nil
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	return status, string(body)
}

func newApp(t *testing.T, lokiURL string) *App {
	t.Helper()
	jsonData, _ := json.Marshal(Settings{LokiURL: lokiURL, MuninnURL: "http://muninn.invalid"})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{JSONData: jsonData})
	if err != nil {
		t.Fatal(err)
	}
	return inst.(*App)
}

func TestSessionsShowTheUserToEditorsOnly(t *testing.T) {
	loki := fakeLoki(t)
	defer loki.Close()
	app := newApp(t, loki.URL)

	status, body := call(t, app, "Editor", "sessions")
	if status != http.StatusOK || !strings.Contains(body, `"user":"alice"`) {
		t.Fatalf("editor: %d %s", status, body)
	}
	for _, role := range []string{"Viewer", "None", ""} { // anything not Editor or Admin
		status, body = call(t, app, role, "sessions")
		if status != http.StatusOK || strings.Contains(body, "alice") {
			t.Fatalf("role %q: %d %s", role, status, body)
		}
	}
}

func TestBadIdsNeverReachTheStores(t *testing.T) {
	app := newApp(t, "http://loki.invalid")
	if status, _ := call(t, app, "Admin", "sessions/demo/not-a-session-id"); status != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", status)
	}
}
```

```bash
go mod tidy
```

```bash
go vet ./pkg/... && go test ./pkg/...
```

`ok github.com/myorg/sessions/pkg/plugin`. Run the tests on `./pkg/...`, not `./...`: one npm
package under `node_modules/` ships Go files.

## Step 3. The frontend

**Add `@ouo11y/kit`**, the replay player:

```bash
npm install @ouo11y/kit@0.1.0
```

| Package | What it does in this plugin |
|---|---|
| `@grafana/data`, `@grafana/runtime`, `@grafana/ui` | Scaffolded: the plugin API, `getBackendSrv()` to call your backend, and Grafana's components |
| `@ouo11y/kit` | `ReplayPlayer`: plays a Muninn manifest with chunks fetched by a function you give it. It plays `rrweb/2` (the web SDK) and says "stored, not playable" for `ouo-frames/3` (the mobile SDK) until its frames player ships. React and `rrweb-player` only, no Grafana assumed |

**One page in the menu, and a backend.** `executable` names the binary Grafana starts:
`gpx_sessions_linux_arm64` or `..._amd64`. Replace `plugin/src/plugin.json`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/src/plugin.json -->
```json
{
  "$schema": "https://raw.githubusercontent.com/grafana/grafana/main/docs/sources/developers/plugins/plugin.schema.json",
  "type": "app",
  "name": "Sessions",
  "id": "myorg-sessions-app",
  "backend": true,
  "executable": "gpx_sessions",
  "info": {
    "keywords": ["app", "rum", "sessions"],
    "description": "Sessions and replays from ouo11y, read with ouo-go and played with @ouo11y/kit",
    "author": {
      "name": "Myorg"
    },
    "logos": {
      "small": "img/logo.svg",
      "large": "img/logo.svg"
    },
    "screenshots": [],
    "version": "%VERSION%",
    "updated": "%TODAY%"
  },
  "includes": [
    {
      "type": "page",
      "name": "Sessions",
      "path": "/a/%PLUGIN_ID%",
      "addToNav": true,
      "defaultNav": true
    }
  ],
  "dependencies": {
    "grafanaDependency": ">=13.2.0",
    "plugins": []
  }
}
```

**The plugin's entry point**, without the configuration page. Replace `plugin/src/module.tsx`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/src/module.tsx -->
```tsx
import { lazy } from 'react';
import { AppPlugin } from '@grafana/data';

const App = lazy(() => import('./components/App/App'));

export const plugin = new AppPlugin<{}>().setRootPage(App);
```

Replace `plugin/src/constants.ts`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/src/constants.ts -->
```ts
import pluginJson from './plugin.json';

// Where the app's pages live in Grafana, and where Grafana proxies calls to its backend.
export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;
export const API = `/api/plugins/${pluginJson.id}/resources`;
```

**Two routes**: a session (`/a/myorg-sessions-app/<project>/<session>`), and the list for
everything else. Replace `plugin/src/components/App/App.tsx`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/src/components/App/App.tsx -->
```tsx
import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';

const Sessions = React.lazy(() => import('../../pages/Sessions'));
const Session = React.lazy(() => import('../../pages/Session'));

function App(_props: AppRootProps) {
  return (
    <Routes>
      <Route path=":project/:session" element={<Session />} />
      <Route path="*" element={<Sessions />} />
    </Routes>
  );
}

export default App;
```

**The calls to your backend**, typed with what `ouo-go` returns. A chunk is fetched as an
`ArrayBuffer`, the shape `ReplayPlayer`'s `fetchChunk` wants. Create `plugin/src/api.ts`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/src/api.ts -->
```ts
import { lastValueFrom } from 'rxjs';
import { getBackendSrv } from '@grafana/runtime';
import type { Manifest } from '@ouo11y/kit';
import { API } from './constants';

// The shapes ouo-go returns (libs/ouo-go/loki.go, muninn.go), as far as these pages read them.
export interface Session {
  project: string;
  id: string;
  service: string;
  start: number;
  end: number;
  event_count: number;
  error_count: number;
  has_replay: boolean;
  user?: string;
}
export interface Event {
  time: number;
  name: string;
  severity?: string;
  trace_id?: string;
  attributes?: Record<string, string>;
  body?: string;
}
export interface Replay {
  replay_id: string;
  state: string;
  formats: string[];
  chunk_count: number;
}

const get = <T,>(path: string) => getBackendSrv().get<T>(`${API}${path}`);

export const listSessions = () => get<{ sessions: Session[]; truncated: boolean }>('/sessions');

export const getSession = (project: string, session: string) =>
  get<{ session: Session; events: Event[]; replays: Replay[] }>(`/sessions/${project}/${session}`);

export const getManifest = (project: string, session: string, replay: string) =>
  get<Manifest>(`/sessions/${project}/${session}/replays/${replay}`);

// The chunk's bytes, as @ouo11y/kit's fetchChunk wants them.
export async function getChunk(p: string, s: string, r: string, stream: string, seq: number) {
  const res = await lastValueFrom(
    getBackendSrv().fetch<ArrayBuffer>({
      url: `${API}/sessions/${p}/${s}/replays/${r}/streams/${stream}/chunks/${seq}`,
      responseType: 'arraybuffer',
    })
  );
  return res.data;
}
```

**The sessions list.** Create `plugin/src/pages/Sessions.tsx`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/src/pages/Sessions.tsx -->
```tsx
import React, { useEffect, useState } from 'react';
import { PluginPage } from '@grafana/runtime';
import { Alert, Badge, LoadingPlaceholder, TextLink } from '@grafana/ui';
import { listSessions, type Session } from '../api';
import { PLUGIN_BASE_URL } from '../constants';

const time = (ms: number) => new Date(ms).toLocaleString();
const seconds = (s: Session) => `${Math.round((s.end - s.start) / 1000)} s`;

function Sessions() {
  const [sessions, setSessions] = useState<Session[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    listSessions().then((r) => setSessions(r.sessions), (e) => setError(e?.data?.message ?? String(e)));
  }, []);

  return (
    <PluginPage>
      {error && <Alert title="Sessions could not be read">{error}</Alert>}
      {!sessions && !error && <LoadingPlaceholder text="Reading sessions from Loki" />}
      {sessions?.length === 0 && <p>No session in the last 24 hours. Open the web app of guide 01 and click around.</p>}
      {sessions && sessions.length > 0 && (
        <table className="filter-table">
          <thead>
            <tr><th>Started</th><th>Service</th><th>User</th><th>Duration</th><th>Events</th><th>Errors</th><th>Replay</th></tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td><TextLink href={`${PLUGIN_BASE_URL}/${s.project}/${s.id}`} inline={false}>{time(s.start)}</TextLink></td>
                <td>{s.service}</td>
                <td>{s.user ?? <i>hidden or anonymous</i>}</td>
                <td>{seconds(s)}</td>
                <td>{s.event_count}</td>
                <td>{s.error_count > 0 ? <Badge color="red" text={String(s.error_count)} /> : 0}</td>
                <td>{s.has_replay ? 'yes' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PluginPage>
  );
}

export default Sessions;
```

**One session**: its first replay in `ReplayPlayer`, keyed by replay id, and its events. Loki
writes attribute names with `_` for `.` (`exception.message` arrives as `exception_message`).
Create `plugin/src/pages/Session.tsx`:

<!-- embed: examples/quickstarts/from-scratch/result/plugin/src/pages/Session.tsx -->
```tsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { PluginPage } from '@grafana/runtime';
import { Alert, LoadingPlaceholder } from '@grafana/ui';
import { ReplayPlayer, type Manifest } from '@ouo11y/kit';
import { getChunk, getManifest, getSession, type Event, type Replay, type Session as S } from '../api';

// What one event says, in a few words. Loki writes attribute names with `_` for `.`; the web
// SDK and the mobile SDK name a few things differently (url_full, url_path).
function summary(e: Event) {
  const a = e.attributes ?? {};
  const body = e.body !== e.name ? e.body : undefined; // mobile events repeat their name as body
  return a.exception_message || a.product_name || a.url_path || a.url_full || a.browser_web_vital_name || a.browser_css_selector || body || '';
}

function Session() {
  const { project = '', session = '' } = useParams();
  const [data, setData] = useState<{ session: S; events: Event[]; replays: Replay[] }>();
  const [manifest, setManifest] = useState<Manifest>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    getSession(project, session).then(async (d) => {
      setData(d);
      const replay = d.replays[0];
      if (replay) {
        setManifest(await getManifest(project, session, replay.replay_id));
      }
    }, (e) => setError(e?.data?.message ?? String(e)));
  }, [project, session]);

  const s = data?.session;
  return (
    <PluginPage pageNav={{ text: `Session ${session.slice(0, 8)}` }}>
      {error && <Alert title="Session could not be read">{error}</Alert>}
      {!data && !error && <LoadingPlaceholder text="Reading the session" />}
      {s && (
        <p>
          {s.service}, user {s.user ?? <i>hidden or anonymous</i>}, {new Date(s.start).toLocaleString()},{' '}
          {data.events.length} events
        </p>
      )}
      {manifest && (
        <ReplayPlayer
          key={manifest.replay_id}
          manifest={manifest}
          fetchChunk={(stream, seq) => getChunk(project, session, manifest.replay_id, stream, seq)}
        />
      )}
      {data && data.replays.length === 0 && <p>This session has no replay.</p>}
      {data && (
        <table className="filter-table">
          <thead>
            <tr><th>Time</th><th>Event</th><th>What</th></tr>
          </thead>
          <tbody>
            {data.events.map((e, i) => (
              <tr key={i}>
                <td>{new Date(e.time).toLocaleTimeString()}</td>
                <td>{e.severity === 'ERROR' ? <b>{e.name}</b> : e.name}</td>
                <td>{summary(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PluginPage>
  );
}

export default Session;
```

```bash
npm run typecheck
```

## Step 4. Build it

The frontend goes to `dist/` (webpack empties `dist/` first, but keeps the backend binaries):

```bash
npm run build
```

The backend, for Linux, since Grafana runs in Docker. Build both architectures, so the same
`dist/` works on Apple silicon and on Intel:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o dist/gpx_sessions_linux_arm64 ./pkg
```

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/gpx_sessions_linux_amd64 ./pkg
```

`dist/` now holds `module.js`, `plugin.json` and the two `gpx_sessions_linux_*` files.

The scaffold's `mage -v build:linuxARM64` does the same as the Go commands, if you install
[Mage](https://magefile.org).

## Step 5. Load it into the stack's Grafana

**Mount `plugin/dist` into Grafana and allow it unsigned**: a plugin you build is not signed by
Grafana Labs. The read token reaches the provisioning file as an environment variable. Replace
`stack/50-grafana/compose.yaml`:

<!-- embed: examples/quickstarts/from-scratch/result/stack/50-grafana/compose.yaml -->
```yaml
# Grafana: the UI. It reads Loki and Tempo directly (provisioning/datasources), and runs your
# plugin from ../plugin/dist (guide 03): its backend reads Loki and Muninn inside this network.
# Port 3000, admin / testing567: development credentials, public.
services:
  grafana:
    image: grafana/grafana:13.2.5
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: testing567
      GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS: myorg-sessions-app   # your build is not signed
      MUNINN_READ_TOKEN: mrt_dev_0000000000000000   # read by provisioning/plugins; equals Muninn's
    volumes:
      - ./provisioning:/etc/grafana/provisioning:ro
      - ../../plugin/dist:/var/lib/grafana/plugins/myorg-sessions-app:ro
    depends_on: [loki, tempo, muninn]
```

**Turn the plugin on and give its backend where to read.** From `plugin/`:

```bash
mkdir -p ../stack/50-grafana/provisioning/plugins
```

Create `stack/50-grafana/provisioning/plugins/myorg-sessions-app.yaml`:

<!-- embed: examples/quickstarts/from-scratch/result/stack/50-grafana/provisioning/plugins/myorg-sessions-app.yaml -->
```yaml
# Turns your plugin on in org 1 and gives its backend where to read (guide 03).
# jsonData is readable by every signed-in user; the read token goes in secureJsonData.
apiVersion: 1

apps:
  - type: myorg-sessions-app
    org_id: 1
    disabled: false
    jsonData:
      lokiUrl: http://loki:3100
      muninnUrl: http://muninn:3400
    secureJsonData:
      muninnReadToken: $MUNINN_READ_TOKEN
```

Apply it from `stack/`; compose recreates Grafana only:

```bash
cd ../stack
```

```bash
docker compose up -d
```

Grafana logs `Plugin registered` with `pluginId=myorg-sessions-app`, after a warning that it is
unsigned, which is expected:

```bash
docker compose logs grafana | grep myorg-sessions-app
```

## Step 6. Use it

Open http://localhost:3000 as `admin` / `testing567`, then **More apps > Sessions**.

- The list shows your sessions of the last 24 hours, newest first: service, user `alice`, events,
  errors, and whether there is a replay.
- Click a **tiny-shop-web** session. The replay plays the shop as the visitor saw it: the product
  list readable (`data-ouo-unmask`), the rest `***`. Below it, the events, the `exception` with
  its message last.
- Click a **tiny-shop-mobile** session. Its events are there; the replay says
  "Stored, not playable here: the frames player is not wired to ouo-frames/3 yet". The frames are
  in Muninn; `@ouo11y/kit` plays them once its frames player ships.

Your backend answers `curl` too, through Grafana and as the user you sign in with:

```bash
curl -s -u admin:testing567 localhost:3000/api/plugins/myorg-sessions-app/resources/sessions
```

## Step 7. Check your access model

Make a Viewer (Grafana's default role for a new user):

```bash
curl -s -u admin:testing567 -H 'Content-Type: application/json' -X POST localhost:3000/api/admin/users -d '{"name":"viewer","login":"viewer","password":"viewer-pass-123"}'
```

The same call as that Viewer has no `"user"` field:

```bash
curl -s -u viewer:viewer-pass-123 localhost:3000/api/plugins/myorg-sessions-app/resources/sessions
```

Sign in as `viewer` in a private window: the list says "hidden or anonymous", and a session's
events have no `enduser_id` or `user_id`. Change `hideIdentity` in `resources.go` to make your
own rule, then rebuild the backend (step 4) and `docker compose restart grafana`.

## Change it and see the change

- **Frontend:** from `plugin/`, `npm run dev` rebuilds `dist/` on every save; reload the page.
- **Backend:** rebuild the binary for your Mac's architecture (step 4), then from `stack/`
  `docker compose restart grafana`. Grafana starts a plugin backend once.

## Clean up

From `stack/`, the plugin goes with Grafana:

```bash
docker compose down
```

## When something does not work

| What you see | Why | Fix |
|---|---|---|
| **More apps** has no **Sessions** | Grafana did not load the plugin | Read Grafana's log for `myorg-sessions-app` (step 5): an unsigned error means `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS` is missing; no line at all means `plugin/dist` was not built or the mount path is wrong |
| The pages load but every call to the backend fails | No backend binary for Grafana's architecture | Step 4 builds both; `ls plugin/dist/gpx_*` |
| `Sessions could not be read: loki could not be read` | Loki is down or `lokiUrl` is wrong | `docker compose ps`; Grafana's log has the full error |
| `muninn could not be read` | Wrong read token or URL | `MUNINN_READ_TOKEN` in `50-grafana/compose.yaml` must equal Muninn's |
| The list is empty | No session in the last 24 hours | Click around the web app of guide 01 |
| A web session has events but no replay | The session started before you set `replay.sessionRate` | Reload the web app for a new session |
| `go: module github.com/ouo11y/ouo11y/libs/ouo-go: not found` | A typo in the path, or a proxy that blocks it | The path and version are exactly `github.com/ouo11y/ouo11y/libs/ouo-go@v0.2.0` |
| `go test ./...` fails in `node_modules` | An npm package ships Go files | `go test ./pkg/...` |

## What else `ouo-go` reads

`ouo-go` v0.2.0, used here, also has readers this plugin does not call yet,
whose definitions follow ouo's telemetry schema, so you do not rebuild them: `Loki.Funnel` (ordered
steps such as `page:/` then `event:add_to_cart`), `Loki.Health` (session health %),
`Loki.SessionVitals` (mobile vitals) and `Tempo.SessionTraces` (a session's traces). See
[libs/ouo-go](../../../libs/ouo-go/README.md); each is one more route in `resources.go`.
