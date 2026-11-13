package ouogo

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Level is a Clearance level, 0 to 5 (ADR-0023 section 4.1). Each level sees everything
// the level below sees. 0 sees nothing.
type Level int

// The levels. C5 reads the same as C4; it is reserved for actions that change or export data.
const (
	None Level = 0
	C1   Level = 1
	C2   Level = 2
	C3   Level = 3
	C4   Level = 4
	C5   Level = 5
)

// Capabilities says which field groups a level may see.
type Capabilities struct {
	// Timeline: sessions, their events and their traces with time, name, severity, ids and counts.
	Timeline bool `json:"timeline"`
	// Attributes: every event attribute and body, except identity.
	Attributes bool `json:"attributes"`
	// Replay: the replay list, manifests and chunks of masked recordings.
	Replay bool `json:"replay"`
	// Identity: enduser.*, user.* and client.address, and the session's user.
	Identity bool `json:"identity"`
	// Unmasked: replays with a chunk recorded without masking (ouo.replay.masked=false).
	Unmasked bool `json:"unmasked"`
}

// levels is THE Clearance table. Reordering what a level sees is a change here, and
// TestLevelsAgainstFields says what moved.
var levels = [...]Capabilities{
	None: {},
	C1:   {Timeline: true},
	C2:   {Timeline: true, Attributes: true},
	C3:   {Timeline: true, Attributes: true, Replay: true},
	C4:   {Timeline: true, Attributes: true, Replay: true, Identity: true},
	C5:   {Timeline: true, Attributes: true, Replay: true, Identity: true, Unmasked: true},
}

// Can returns the level's capabilities. Out-of-range levels can do nothing.
func (l Level) Can() Capabilities {
	if l < None || int(l) >= len(levels) {
		return Capabilities{}
	}
	return levels[l]
}

func (l Level) String() string { return "c" + strconv.Itoa(int(l)) }

// UnmarshalJSON accepts an integer from 0 to 5.
func (l *Level) UnmarshalJSON(b []byte) error {
	var n int
	if err := json.Unmarshal(b, &n); err != nil || n < int(None) || n > int(C5) {
		return fmt.Errorf("clearance level: want an integer 0-5, got %s", b)
	}
	*l = Level(n)
	return nil
}

// Grants maps Grafana users to levels in one scope (the org, or one project).
type Grants struct {
	Roles map[string]Level `json:"roles,omitempty"`
	Users map[string]Level `json:"users,omitempty"`
	Teams map[string]Level `json:"teams,omitempty"`
}

// ClearanceConfig is the org's grants, plus per-project grants that replace them for one project.
type ClearanceConfig struct {
	Grants
	Projects map[string]Grants `json:"projects,omitempty"`
}

// TeamNames lists every team the configuration names, so a caller looks up only those.
func (cfg ClearanceConfig) TeamNames() []string {
	seen := map[string]bool{}
	var out []string
	add := func(g Grants) {
		for t := range g.Teams {
			if !seen[t] {
				seen[t] = true
				out = append(out, t)
			}
		}
	}
	add(cfg.Grants)
	for _, g := range cfg.Projects {
		add(g)
	}
	sort.Strings(out)
	return out
}

// DefaultRoles applies when the org grants have no roles map: Viewer c1, Editor c3, Admin c5.
var DefaultRoles = map[string]Level{"Viewer": C1, "Editor": C3, "Admin": C5}

// Clearance is the caller's resolved level. Every read function of this package takes one.
type Clearance struct {
	Login string   `json:"login"`
	Role  string   `json:"role"`
	Teams []string `json:"teams,omitempty"`
	// Level is the org-wide level; Projects overrides it per project.
	Level    Level            `json:"level"`
	Projects map[string]Level `json:"projects,omitempty"`
}

// Can is shorthand for c.Level.Can().
func (c Clearance) Can() Capabilities { return c.Level.Can() }

// For returns the clearance for one project.
func (c Clearance) For(project string) Clearance {
	if lv, ok := c.Projects[project]; ok {
		c.Level = lv
	}
	return c
}

// Max is the highest level the caller has in any project.
func (c Clearance) Max() Level {
	m := c.Level
	for _, lv := range c.Projects {
		m = max(m, lv)
	}
	return m
}

// resolve finds the level in one scope: the user's entry wins (up or down); otherwise the
// highest of the role's and the teams' entries. ok is false when nothing in the scope matched.
func (g Grants) resolve(login, role string, teams []string, defaultRoles map[string]Level) (Level, bool) {
	if login != "" {
		for u, lv := range g.Users {
			if strings.EqualFold(u, login) {
				return lv, true
			}
		}
	}
	roles := g.Roles
	if roles == nil {
		roles = defaultRoles
	}
	lv, ok := None, false
	if r, hit := roles[role]; hit && role != "" {
		lv, ok = r, true
	}
	for _, t := range teams {
		if r, hit := g.Teams[t]; hit {
			lv, ok = max(lv, r), true
		}
	}
	return lv, ok
}

// Resolve finds a user's levels (ADR-0023 section 4.2). Deny by default: a user nothing
// matches gets 0. Logins compare without case, as Grafana's do. A project's grants replace
// the org's for that project when something in them matches the user.
func Resolve(cfg ClearanceConfig, login, role string, teams []string) Clearance {
	c := Clearance{Login: login, Role: role, Teams: teams}
	c.Level, _ = cfg.Grants.resolve(login, role, teams, DefaultRoles)
	for p, g := range cfg.Projects {
		if lv, ok := g.resolve(login, role, teams, nil); ok {
			if c.Projects == nil {
				c.Projects = map[string]Level{}
			}
			c.Projects[p] = lv
		}
	}
	return c
}

// Field group names reported in Redacted lists.
const (
	GroupAttributes = "attributes"
	GroupReplay     = "replay"
	GroupIdentity   = "identity"
)

// redactedGroups lists the groups this clearance does not see.
func (c Clearance) redactedGroups() []string {
	can := c.Can()
	out := []string{}
	if !can.Attributes {
		out = append(out, GroupAttributes)
	}
	if !can.Replay {
		out = append(out, GroupReplay)
	}
	if !can.Identity {
		out = append(out, GroupIdentity)
	}
	return out
}

// coreKeys are the Loki labels (attribute names with "." written "_") that make up the
// timeline itself, visible from c1. They become fields of Event, not attributes.
var coreKeys = map[string]bool{
	"event_name": true, "severity_text": true, "session_id": true, "ouo_view_id": true,
	"trace_id": true, "span_id": true, "service_name": true, "ouo_project_id": true,
}

// identityKeys are the attributes that name a person (OTel enduser.* and user.*, and the
// client address), visible from c4. A Loki label name is the attribute name with "_".
var identityKeys = map[string]bool{
	"user_id": true, "user_email": true, "user_name": true, "user_full_name": true,
	"user_hash": true, "user_roles": true, "client_address": true,
}

func isIdentity(key string) bool {
	return identityKeys[key] || strings.HasPrefix(key, "enduser_")
}

// attributes copies the attributes this clearance may see out of a Loki label set. It
// starts empty and adds (deny by default); nil when the level sees no attributes.
func (c Clearance) attributes(labels map[string]string) map[string]string {
	can := c.Can()
	if !can.Attributes && !can.Identity {
		return nil
	}
	out := map[string]string{}
	for k, v := range labels {
		switch {
		case coreKeys[k]:
		case isIdentity(k):
			if can.Identity {
				out[k] = v
			}
		case can.Attributes:
			out[k] = v
		}
	}
	return out
}
