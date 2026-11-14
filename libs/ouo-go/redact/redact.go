// Package redact is an optional helper for callers that hide some attributes from some
// users. It decides nothing: the caller says which keys to drop or keep, and when.
//
// Keys match in both spellings: an OTel attribute name ("enduser.id") and the same name
// as Loki writes it as a label ("enduser_id").
package redact

import (
	"strings"

	ouogo "github.com/ouo11y/ouo11y/libs/ouo-go"
)

// Match reports whether an attribute key is one the caller means.
type Match func(key string) bool

func norm(key string) string { return strings.ReplaceAll(key, ".", "_") }

// identityKeys name a person: OTel user.* attributes and the client address. Every
// enduser.* attribute does too (Identity matches the prefix).
var identityKeys = map[string]bool{
	"user_id": true, "user_email": true, "user_name": true, "user_full_name": true,
	"user_hash": true, "user_roles": true, "client_address": true,
}

// Identity matches the attributes that name a person: enduser.*, user.id, user.email,
// user.name, user.full_name, user.hash, user.roles and client.address. It does not look
// inside values: personal data in a URL or a message is not found.
func Identity(key string) bool {
	k := norm(key)
	return identityKeys[k] || strings.HasPrefix(k, "enduser_")
}

// Keys matches exactly the given keys, in either spelling.
func Keys(keys ...string) Match {
	set := make(map[string]bool, len(keys))
	for _, k := range keys {
		set[norm(k)] = true
	}
	return func(key string) bool { return set[norm(key)] }
}

// Prefixes matches keys that start with one of the prefixes, in either spelling.
func Prefixes(prefixes ...string) Match {
	ps := make([]string, len(prefixes))
	for i, p := range prefixes {
		ps[i] = norm(p)
	}
	return func(key string) bool {
		k := norm(key)
		for _, p := range ps {
			if strings.HasPrefix(k, p) {
				return true
			}
		}
		return false
	}
}

// Any matches a key that any of the matchers matches.
func Any(ms ...Match) Match {
	return func(key string) bool {
		for _, m := range ms {
			if m(key) {
				return true
			}
		}
		return false
	}
}

// Drop returns a copy of attrs without the keys drop matches. nil stays nil.
func Drop[V any](attrs map[string]V, drop Match) map[string]V {
	return filter(attrs, func(k string) bool { return !drop(k) })
}

// Keep returns a copy of attrs with only the keys keep matches (an allow list: a key
// nobody thought of is dropped). nil stays nil.
func Keep[V any](attrs map[string]V, keep Match) map[string]V {
	return filter(attrs, keep)
}

func filter[V any](attrs map[string]V, keep Match) map[string]V {
	if attrs == nil {
		return nil
	}
	out := make(map[string]V, len(attrs))
	for k, v := range attrs {
		if keep(k) {
			out[k] = v
		}
	}
	return out
}

// Events drops the matching attributes from every event, in place.
func Events(events []ouogo.Event, drop Match) {
	for i := range events {
		events[i].Attributes = Drop(events[i].Attributes, drop)
	}
}

// Manifest drops the matching attributes from every chunk of a manifest, in place.
// Muninn returns every stored chunk attribute (MUN-6), so a chunk may carry identity.
func Manifest(m *ouogo.Manifest, drop Match) {
	for i := range m.Streams {
		for j := range m.Streams[i].Chunks {
			c := &m.Streams[i].Chunks[j]
			c.Attributes = Drop(c.Attributes, drop)
		}
	}
}
