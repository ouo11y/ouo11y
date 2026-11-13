package ouogo

import (
	"encoding/json"
	"fmt"
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
	// Timeline: sessions and their events with time, name, severity, ids and counts.
	Timeline bool `json:"timeline"`
	// Attributes: every event attribute and body, except identity.
	Attributes bool `json:"attributes"`
	// Replay: the replay list, manifests and chunks.
	Replay bool `json:"replay"`
	// Identity: enduser.*, user.* and client.address, and the session's user.
	Identity bool `json:"identity"`
}

// levels is THE Clearance table. Reordering what a level sees is a change here, and
// clearance_test.go says what moved.
var levels = [...]Capabilities{
	None: {},
	C1:   {Timeline: true},
	C2:   {Timeline: true, Attributes: true},
	C3:   {Timeline: true, Attributes: true, Replay: true},
	C4:   {Timeline: true, Attributes: true, Replay: true, Identity: true},
	C5:   {Timeline: true, Attributes: true, Replay: true, Identity: true},
}

// Can returns the level's capabilities. Out-of-range levels can do nothing.
func (l Level) Can() Capabilities {
	if l < None || int(l) >= len(levels) {
		return Capabilities{}
	}
	return levels[l]
}

func (l Level) String() string { return "c" + strconv.Itoa(int(l)) }

// UnmarshalJSON accepts 3 or "c3".
func (l *Level) UnmarshalJSON(b []byte) error {
	var n int
	if err := json.Unmarshal(b, &n); err == nil {
		return l.set(n)
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("clearance level: want 0-5 or \"c0\"-\"c5\", got %s", b)
	}
	n, err := strconv.Atoi(strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "c"))
	if err != nil {
		return fmt.Errorf("clearance level: want 0-5 or \"c0\"-\"c5\", got %q", s)
	}
	return l.set(n)
}

func (l *Level) set(n int) error {
	if n < int(None) || n > int(C5) {
		return fmt.Errorf("clearance level %d out of range 0-5", n)
	}
	*l = Level(n)
	return nil
}

// ClearanceConfig maps Grafana users to levels: by login first, then by org role, else 0.
type ClearanceConfig struct {
	Roles map[string]Level `json:"roles,omitempty"`
	Users map[string]Level `json:"users,omitempty"`
}

// DefaultRoles applies when the configuration has no roles map: Viewer c1, Editor c3, Admin c5.
var DefaultRoles = map[string]Level{"Viewer": C1, "Editor": C3, "Admin": C5}

// Clearance is the caller's resolved level. Every read function of this package takes one.
type Clearance struct {
	Login string `json:"login"`
	Role  string `json:"role"`
	Level Level  `json:"level"`
}

// Can is shorthand for c.Level.Can().
func (c Clearance) Can() Capabilities { return c.Level.Can() }

// Resolve finds a user's level (ADR-0023 section 4.2). Deny by default: a user who is in
// neither map gets 0.
func Resolve(cfg ClearanceConfig, login, role string) Clearance {
	c := Clearance{Login: login, Role: role}
	if lv, ok := cfg.Users[login]; ok && login != "" {
		c.Level = lv
		return c
	}
	roles := cfg.Roles
	if roles == nil {
		roles = DefaultRoles
	}
	if lv, ok := roles[role]; ok && role != "" {
		c.Level = lv
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
