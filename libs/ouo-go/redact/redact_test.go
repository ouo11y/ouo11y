package redact

import (
	"fmt"
	"testing"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

func TestIdentity(t *testing.T) {
	for key, want := range map[string]bool{
		"enduser.id": true, "enduser_id": true, "enduser.pseudo.id": true, "enduser_role": true,
		"user.id": true, "user_id": true, "user.email": true, "user_full_name": true, "user.roles": true,
		"client.address": true, "client_address": true,
		"user_agent_original": false, "user.agent": false, "browser_document_url_full": false,
		"client.port": false, "enduserx": false, "session_id": false, "": false,
	} {
		if got := Identity(key); got != want {
			t.Errorf("Identity(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestMatchers(t *testing.T) {
	keys := Keys("http.url", "exception_message")
	pre := Prefixes("http.request.header.")
	both := Any(keys, pre)
	cases := []struct {
		key                 string
		keys, prefixes, any bool
	}{
		{"http.url", true, false, true},
		{"http_url", true, false, true},
		{"exception.message", true, false, true},
		{"http.request.header.cookie", false, true, true},
		{"http_request_header_authorization", false, true, true},
		{"http.method", false, false, false},
	}
	for _, c := range cases {
		if keys(c.key) != c.keys || pre(c.key) != c.prefixes || both(c.key) != c.any {
			t.Errorf("%s: keys %v prefixes %v any %v", c.key, keys(c.key), pre(c.key), both(c.key))
		}
	}
	if Any()("x") {
		t.Errorf("Any() matches nothing")
	}
}

func TestDropKeep(t *testing.T) {
	attrs := map[string]string{"enduser_id": "u", "user_agent_original": "M", "http_url": "/x", "client_address": "1.2.3.4"}
	if got := fmt.Sprint(Drop(attrs, Identity)); got != "map[http_url:/x user_agent_original:M]" {
		t.Errorf("Drop: %s", got)
	}
	if got := fmt.Sprint(Keep(attrs, Keys("http.url"))); got != "map[http_url:/x]" {
		t.Errorf("Keep: %s", got)
	}
	if len(attrs) != 4 {
		t.Errorf("the input was changed: %v", attrs)
	}
	if Drop[string](nil, Identity) != nil || Keep[any](nil, Identity) != nil {
		t.Errorf("nil must stay nil")
	}
}

func TestEventsAndManifest(t *testing.T) {
	events := []ouogo.Event{
		{Name: "a", Attributes: map[string]string{"enduser_id": "u", "x": "1"}},
		{Name: "b"},
	}
	Events(events, Identity)
	if fmt.Sprint(events[0].Attributes) != "map[x:1]" || events[1].Attributes != nil {
		t.Errorf("events: %+v", events)
	}
	m := &ouogo.Manifest{Streams: []ouogo.Stream{{Chunks: []ouogo.Chunk{
		{Attributes: map[string]any{"enduser.id": "u", "ouo.replay.masked": true}},
		{},
	}}}}
	Manifest(m, Identity)
	if fmt.Sprint(m.Streams[0].Chunks[0].Attributes) != "map[ouo.replay.masked:true]" || m.Streams[0].Chunks[1].Attributes != nil {
		t.Errorf("manifest: %+v", m.Streams[0].Chunks)
	}
}
