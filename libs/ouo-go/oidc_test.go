package ouogo

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

const (
	testIssuer   = "https://idp.test/realms/ouo"
	testAudience = "grafana"
)

var testNow = time.Unix(1794400000, 0)

// idp is a stand-in identity provider: a key pair, its JWKS endpoint and a token mint.
type idp struct {
	key     *rsa.PrivateKey
	kid     string
	srv     *httptest.Server
	fetches int
}

func newIDP(t *testing.T) *idp {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &idp{key: key, kid: "k1"}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.fetches++
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &p.key.PublicKey, KeyID: p.kid, Algorithm: "RS256", Use: "sig"}}})
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *idp) verifier() *OIDC {
	return &OIDC{Issuer: testIssuer, Audience: testAudience, JWKSURL: p.srv.URL, Now: func() time.Time { return testNow }}
}

// claims is a valid ID token's payload; tests change one thing at a time.
func claims(groups any) map[string]any {
	return map[string]any{
		"iss": testIssuer, "aud": testAudience, "sub": "u-1",
		"iat": testNow.Add(-time.Minute).Unix(), "exp": testNow.Add(5 * time.Minute).Unix(),
		"groups": groups,
	}
}

func sign(t *testing.T, key *rsa.PrivateKey, kid string, c map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", kid))
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(c)
	jws, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	out, err := jws.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func b64(v any) string {
	b, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(b)
}

func TestOIDCGroups(t *testing.T) {
	p := newIDP(t)
	v := p.verifier()
	ctx := context.Background()

	got, err := v.Groups(ctx, sign(t, p.key, p.kid, claims([]string{"support", "privacy"})))
	if err != nil || strings.Join(got, ",") != "support,privacy" {
		t.Fatalf("valid token: %v %v", got, err)
	}
	if got, err := v.Groups(ctx, sign(t, p.key, p.kid, claims("support"))); err != nil || len(got) != 1 || got[0] != "support" {
		t.Errorf("a single string claim: %v %v", got, err)
	}
	c := claims(nil)
	delete(c, "groups")
	if got, err := v.Groups(ctx, sign(t, p.key, p.kid, c)); err != nil || len(got) != 0 {
		t.Errorf("no groups claim: %v %v, want no groups and no error", got, err)
	}
	other := p.verifier()
	other.GroupsClaim = "roles"
	c = claims([]string{"support"})
	c["roles"] = []string{"privacy"}
	if got, _ := other.Groups(ctx, sign(t, p.key, p.kid, c)); len(got) != 1 || got[0] != "privacy" {
		t.Errorf("groupsClaim=roles: %v", got)
	}
	if p.fetches != 2 {
		t.Errorf("keys fetched %d times, want once per verifier (cached)", p.fetches)
	}
}

func TestOIDCRejects(t *testing.T) {
	p := newIDP(t)
	ctx := context.Background()
	attacker, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	with := func(k string, val any) map[string]any {
		c := claims([]string{"privacy"})
		if val == nil {
			delete(c, k)
		} else {
			c[k] = val
		}
		return c
	}
	good := sign(t, p.key, p.kid, claims([]string{"privacy"}))
	parts := strings.Split(good, ".")
	forgedPayload := b64(claims([]string{"privacy", "admins"}))

	cases := map[string]string{
		"no token":                         "",
		"not a JWT":                        "privacy",
		"expired":                          sign(t, p.key, p.kid, with("exp", testNow.Add(-time.Hour).Unix())),
		"no expiry":                        sign(t, p.key, p.kid, with("exp", nil)),
		"not valid yet":                    sign(t, p.key, p.kid, with("nbf", testNow.Add(time.Hour).Unix())),
		"wrong issuer":                     sign(t, p.key, p.kid, with("iss", "https://evil.test/realms/ouo")),
		"wrong audience":                   sign(t, p.key, p.kid, with("aud", "another-client")),
		"no audience":                      sign(t, p.key, p.kid, with("aud", nil)),
		"signed by another key, same kid":  sign(t, attacker, p.kid, claims([]string{"privacy"})),
		"signed by another key, other kid": sign(t, attacker, "k2", claims([]string{"privacy"})),
		"payload changed after signing":    parts[0] + "." + forgedPayload + "." + parts[2],
		"signature removed":                parts[0] + "." + parts[1] + ".",
		"alg none":                         b64(map[string]any{"alg": "none", "typ": "JWT"}) + "." + forgedPayload + ".",
		"alg HS256 keyed with the public key": b64(map[string]any{"alg": "HS256", "typ": "JWT", "kid": p.kid}) + "." + forgedPayload + "." +
			base64.RawURLEncoding.EncodeToString([]byte("forged")),
	}
	for name, tok := range cases {
		if got, err := p.verifier().Groups(ctx, tok); err == nil || got != nil {
			t.Errorf("%s: groups %v, err %v; want an error and no groups", name, got, err)
		}
	}

	// An incomplete configuration verifies nothing.
	for _, v := range []*OIDC{
		{Audience: testAudience, JWKSURL: p.srv.URL}, {Issuer: testIssuer, JWKSURL: p.srv.URL}, {Issuer: testIssuer, Audience: testAudience},
	} {
		v.Now = func() time.Time { return testNow }
		if got, err := v.Groups(ctx, good); err == nil || got != nil {
			t.Errorf("config %+v: groups %v, want an error", v, got)
		}
	}
}

func TestOIDCKeys(t *testing.T) {
	p := newIDP(t)
	ctx := context.Background()
	now := testNow
	v := p.verifier()
	v.Now = func() time.Time { return now }
	if _, err := v.Groups(ctx, sign(t, p.key, p.kid, claims([]string{"a"}))); err != nil {
		t.Fatal(err)
	}
	// Tokens with unknown key ids do not make a request each.
	attacker, _ := rsa.GenerateKey(rand.Reader, 2048)
	for range 5 {
		_, _ = v.Groups(ctx, sign(t, attacker, "nope", claims([]string{"a"})))
	}
	if p.fetches != 1 {
		t.Errorf("unknown kids caused %d fetches, want 0", p.fetches-1)
	}
	// The provider rotates its key: the new one is picked up after the refetch interval.
	old := p.key
	p.key, p.kid = attacker, "k2"
	now = now.Add(2 * time.Minute)
	c := claims([]string{"a"})
	c["exp"] = now.Add(time.Minute).Unix()
	if _, err := v.Groups(ctx, sign(t, p.key, p.kid, c)); err != nil {
		t.Errorf("rotated key: %v", err)
	}
	// And the withdrawn key stops working.
	if _, err := v.Groups(ctx, sign(t, old, "k1", c)); err == nil {
		t.Errorf("a token signed with the withdrawn key verified")
	}
	// The provider is down and no keys are held: an error, not a pass.
	down := &OIDC{Issuer: testIssuer, Audience: testAudience, JWKSURL: "http://127.0.0.1:1/certs", Now: v.Now}
	if _, err := down.Groups(ctx, sign(t, p.key, p.kid, c)); err == nil {
		t.Errorf("verified without keys")
	}
}
