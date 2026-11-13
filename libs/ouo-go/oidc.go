package ouogo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// OIDC verifies a user's ID token from an OpenID Connect identity provider and reads the
// user's groups from it (ADR-0024). A token that is not verified gives no groups: the
// caller treats every error as "no groups", never as a reason to trust the token less
// strictly.
type OIDC struct {
	// Issuer is the token's expected `iss`, exactly as the provider writes it.
	Issuer string `json:"issuer"`
	// Audience must be in the token's `aud`: the OAuth client id Grafana signs in with.
	Audience string `json:"audience"`
	// JWKSURL is where the provider publishes its signing keys (`jwks_uri`).
	JWKSURL string `json:"jwksUrl"`
	// GroupsClaim is the claim that lists the user's groups; "groups" when empty.
	GroupsClaim string `json:"groupsClaim,omitempty"`

	// HTTP fetches the keys; http.DefaultClient with a 10 second timeout when nil.
	HTTP *http.Client `json:"-"`
	// Now is the clock; time.Now when nil.
	Now func() time.Time `json:"-"`

	mu      sync.Mutex
	keys    *jose.JSONWebKeySet
	fetched time.Time
}

// Asymmetric algorithms only: with HS256 the "key" would be a secret the verifier must
// hold, and "none" is no signature at all.
var oidcAlgs = []jose.SignatureAlgorithm{jose.RS256, jose.RS384, jose.RS512, jose.PS256, jose.PS384, jose.PS512, jose.ES256, jose.ES384, jose.ES512, jose.EdDSA}

const (
	// oidcLeeway allows for clock difference between the provider and this host.
	oidcLeeway = 30 * time.Second
	// A token signed with a key id we do not hold makes us fetch the keys again (the
	// provider rotated), but not more often than this: a forged kid must not become a
	// request to the provider per call.
	jwksMinRefetch = time.Minute
	// Keys are fetched again after this long, so a key the provider withdrew stops working.
	jwksMaxAge = time.Hour
)

func (o *OIDC) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

// Groups verifies the token (signature against the provider's keys, issuer, audience,
// expiry) and returns the groups claim. Any failure is an error and no groups.
func (o *OIDC) Groups(ctx context.Context, token string) ([]string, error) {
	if o.Issuer == "" || o.Audience == "" || o.JWKSURL == "" {
		return nil, errors.New("oidc: issuer, audience and jwksUrl must all be set")
	}
	if token == "" {
		return nil, errors.New("oidc: no token")
	}
	tok, err := jwt.ParseSigned(token, oidcAlgs)
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
	var rest map[string]any
	if err := tok.Claims(key, &std, &rest); err != nil {
		return nil, fmt.Errorf("oidc: signature: %w", err)
	}
	if std.Expiry == nil {
		return nil, errors.New("oidc: token has no expiry")
	}
	if err := std.ValidateWithLeeway(jwt.Expected{Issuer: o.Issuer, AnyAudience: jwt.Audience{o.Audience}, Time: o.now()}, oidcLeeway); err != nil {
		return nil, fmt.Errorf("oidc: %w", err)
	}
	claim := o.GroupsClaim
	if claim == "" {
		claim = "groups"
	}
	switch v := rest[claim].(type) {
	case []any:
		groups := make([]string, 0, len(v))
		for _, g := range v {
			if s, ok := g.(string); ok {
				groups = append(groups, s)
			}
		}
		return groups, nil
	case string:
		return []string{v}, nil
	}
	return nil, nil
}

// key returns the provider's public key with this id, fetching the key set when it is not
// held yet or the id is unknown.
func (o *OIDC) key(ctx context.Context, kid string) (*jose.JSONWebKey, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	find := func() *jose.JSONWebKey {
		if o.keys == nil {
			return nil
		}
		for i := range o.keys.Keys {
			k := &o.keys.Keys[i]
			// Public signing keys only; a token without a kid is accepted only when the
			// provider publishes a single key.
			if !k.IsPublic() || (k.Use != "" && k.Use != "sig") {
				continue
			}
			if k.KeyID == kid || (kid == "" && len(o.keys.Keys) == 1) {
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
	if o.keys != nil && o.now().Sub(o.fetched) < jwksMinRefetch {
		return nil, fmt.Errorf("oidc: no key %q", kid)
	}
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
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		return nil, fmt.Errorf("oidc: keys: %w", err)
	}
	o.keys, o.fetched = &set, o.now()
	if k := find(); k != nil {
		return k, nil
	}
	return nil, fmt.Errorf("oidc: no key %q", kid)
}
