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

// UnmarshalJSON accepts an integer from 0 to 5.
func (l *Level) UnmarshalJSON(b []byte) error {
	var n int
	if err := json.Unmarshal(b, &n); err != nil || n < int(None) || n > int(C5) {
		return fmt.Errorf("clearance level: want an integer 0-5, got %s", b)
	}
	*l = Level(n)
	return nil
}

// Clearance modes (ADR-0024).
const (
	// ModeGroups: the level comes from the user's identity-provider groups, read from a
	// verified ID token.
	ModeGroups = "groups"
	// ModeRoles: the level comes from the user's Grafana org role. For a Grafana with no
	// identity provider (local development).
	ModeRoles = "roles"
)

// ClearanceConfig says where a user's level comes from. Exactly one mode applies; any
// other Mode value, the empty one included, gives every user level 0.
type ClearanceConfig struct {
	Mode string `json:"mode"`
	// Groups maps an identity-provider group to a level (ModeGroups). A user gets the
	// highest level among their groups.
	Groups map[string]Level `json:"groups,omitempty"`
	// Roles maps a Grafana org role (Viewer, Editor, Admin) to a level (ModeRoles).
	Roles map[string]Level `json:"roles,omitempty"`
}

// Clearance is the caller's resolved level. Every read function of this package takes one.
type Clearance struct {
	Login string `json:"login"`
	Role  string `json:"role"`
	// Mode is the ClearanceConfig mode the level was decided in.
	Mode  string `json:"mode"`
	Level Level  `json:"level"`
}

// Can is shorthand for c.Level.Can().
func (c Clearance) Can() Capabilities { return c.Level.Can() }

// Resolve finds a user's level (ADR-0024). Deny by default: no mode, an unknown mode, a
// user whose groups (or role) are not in the map, all get 0. In ModeGroups the role is
// not read, and in ModeRoles the groups are not: the caller passes the groups of a token
// it has verified, or nil.
func Resolve(cfg ClearanceConfig, login, role string, groups []string) Clearance {
	c := Clearance{Login: login, Role: role, Mode: cfg.Mode}
	switch cfg.Mode {
	case ModeGroups:
		for _, g := range groups {
			if lv, ok := cfg.Groups[g]; ok && lv > c.Level {
				c.Level = lv
			}
		}
	case ModeRoles:
		if lv, ok := cfg.Roles[role]; ok && role != "" {
			c.Level = lv
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
