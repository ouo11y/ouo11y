// Package oidc is an optional helper that verifies a user's OpenID Connect ID token and
// returns its claims. It maps them to nothing: what a group, a role or a subject may see
// is the caller's decision.
//
// A Grafana plugin backend receives the signed-in user's ID token only through a
// datasource with jsonData.oauthPassThru (as X-Id-Token); see
// project/kb/plugin/idp-tokens/idp-tokens-in-a-plugin-backend.md in the ouo11y repo.
package oidc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// Verifier verifies ID tokens from one OpenID Connect provider: the signature against the
// provider's published keys (asymmetric algorithms only), the issuer, the audience and
// the expiry. A token that fails any check gives an error and no claims: a caller treats
// every error as "not verified", never as a reason to trust the token less strictly.
//
// It does not bind the token to the caller: whoever presents a valid, unexpired token
// gets its claims. A caller that receives tokens from a channel a user can write to
// (an HTTP header a browser can set) must account for that.
type Verifier struct {
	// Issuer is the token's expected `iss`, exactly as the provider writes it.
	Issuer string `json:"issuer"`
	// Audience must be in the token's `aud`: the OAuth client id Grafana signs in with.
	Audience string `json:"audience"`
	// JWKSURL is where the provider publishes its signing keys (`jwks_uri`).
	JWKSURL string `json:"jwksUrl"`
	// GroupsClaim is the claim Groups reads; "groups" when empty.
	GroupsClaim string `json:"groupsClaim,omitempty"`

	// HTTP fetches the keys; http.DefaultClient with a 10 second timeout when nil.
	HTTP *http.Client `json:"-"`
	// Now is the clock; time.Now when nil.
	Now func() time.Time `json:"-"`

	mu      sync.Mutex
	keys    *jose.JSONWebKeySet
	fetched time.Time // when keys were fetched
	tried   time.Time // when a fetch was last attempted, successful or not
}

// Asymmetric algorithms only: with HS256 the "key" would be a secret the verifier must
// hold, and "none" is no signature at all.
var algs = []jose.SignatureAlgorithm{jose.RS256, jose.RS384, jose.RS512, jose.PS256, jose.PS384, jose.PS512, jose.ES256, jose.ES384, jose.ES512, jose.EdDSA}

const (
	// leeway allows for clock difference between the provider and this host.
	leeway = 30 * time.Second
	// A token signed with a key id we do not hold makes us fetch the keys again (the
	// provider rotated), but not more often than this, whether the last fetch worked or
	// not: a forged kid, or a provider that is down, must not become a request (and a
	// wait) per call.
	jwksMinRefetch = time.Minute
	// Keys are fetched again after this long, so a key the provider withdrew stops working.
	jwksMaxAge = time.Hour
)

func (o *Verifier) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// Verify checks the token (signature against the provider's keys, issuer, audience,
// expiry) and returns all its claims. Any failure is an error and no claims.
func (o *Verifier) Verify(ctx context.Context, token string) (map[string]any, error) {
	if o.Issuer == "" || o.Audience == "" || o.JWKSURL == "" {
		return nil, errors.New("oidc: issuer, audience and jwksUrl must all be set")
	}
	if token == "" {
		return nil, errors.New("oidc: no token")
	}
	tok, err := jwt.ParseSigned(token, algs)
	if err != nil {
		return nil, fmt.Errorf("oidc: parse: %w", err)
	}
	if len(tok.Headers) != 1 {
		return nil, errors.New("oidc: want exactly one signature")
	}
	key, err := o.key(ctx, tok.Headers[0].KeyID)
	if err != nil {
		return nil, err
	}
	var std jwt.Claims
	var all map[string]any
	if err := tok.Claims(key, &std, &all); err != nil {
		return nil, fmt.Errorf("oidc: signature: %w", err)
	}
	if std.Expiry == nil {
		return nil, errors.New("oidc: token has no expiry")
	}
	if err := std.ValidateWithLeeway(jwt.Expected{Issuer: o.Issuer, AnyAudience: jwt.Audience{o.Audience}, Time: o.now()}, leeway); err != nil {
		return nil, fmt.Errorf("oidc: %w", err)
	}
	return all, nil
}

// Groups verifies the token like Verify and returns the GroupsClaim claim as a list
// (a single string claim is a list of one; no claim, no groups and no error).
func (o *Verifier) Groups(ctx context.Context, token string) ([]string, error) {
	claims, err := o.Verify(ctx, token)
	if err != nil {
		return nil, err
	}
	claim := o.GroupsClaim
	if claim == "" {
		claim = "groups"
	}
	return Strings(claims[claim]), nil
}

// Strings reads a claim that is a string or a list of strings; anything else gives nil.
func Strings(claim any) []string {
	switch v := claim.(type) {
	case []any:
		out := make([]string, 0, len(v))
		for _, g := range v {
			if s, ok := g.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case string:
		return []string{v}
	}
	return nil
}

// key returns the provider's public key with this id, fetching the key set when it is not
// held yet or the id is unknown.
//
// The lock is held across a fetch, so calls wait for it (up to the client's timeout) and
// do not honour their own context meanwhile; with at most one fetch a minute that is rare.
func (o *Verifier) key(ctx context.Context, kid string) (*jose.JSONWebKey, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	find := func() *jose.JSONWebKey {
		if o.keys == nil {
			return nil
		}
		for i := range o.keys.Keys {
			k := &o.keys.Keys[i]
			// Public signing keys only, matched by key id.
			if k.KeyID == kid && k.IsPublic() && (k.Use == "" || k.Use == "sig") {
				return k
			}
		}
		return nil
	}
	if o.keys != nil && o.now().Sub(o.fetched) > jwksMaxAge {
		o.keys = nil
	}
	if k := find(); k != nil {
		return k, nil
	}
	if !o.tried.IsZero() && o.now().Sub(o.tried) < jwksMinRefetch {
		return nil, fmt.Errorf("oidc: no key %q", kid)
	}
	o.tried = o.now()
	client := o.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.JWKSURL, nil)
	if err != nil {
		return nil, fmt.Errorf("oidc: keys: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oidc: keys: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("oidc: keys: %s answered %d", o.JWKSURL, resp.StatusCode)
	}
	var set jose.JSONWebKeySet
	// A key set is a few KiB; a provider answering more is not read further.
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&set); err != nil {
		return nil, fmt.Errorf("oidc: keys: %w", err)
	}
	o.keys, o.fetched = &set, o.now()
	if k := find(); k != nil {
		return k, nil
	}
	return nil, fmt.Errorf("oidc: no key %q", kid)
}
