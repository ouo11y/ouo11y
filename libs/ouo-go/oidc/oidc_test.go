package oidc

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
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

func (p *idp) verifier() *Verifier {
	return &Verifier{Issuer: testIssuer, Audience: testAudience, JWKSURL: p.srv.URL, Now: func() time.Time { return testNow }}
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

func TestGroups(t *testing.T) {
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
	all, err := v.Verify(ctx, sign(t, p.key, p.kid, claims([]string{"a"})))
	if err != nil || all["sub"] != "u-1" || all["iss"] != testIssuer {
		t.Errorf("Verify: %v %v", all, err)
	}
	if p.fetches != 2 {
		t.Errorf("keys fetched %d times, want once per verifier (cached)", p.fetches)
	}
}

func TestRejects(t *testing.T) {
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
		"no token":                            "",
		"not a JWT":                           "privacy",
		"expired":                             sign(t, p.key, p.kid, with("exp", testNow.Add(-time.Hour).Unix())),
		"no expiry":                           sign(t, p.key, p.kid, with("exp", nil)),
		"not valid yet":                       sign(t, p.key, p.kid, with("nbf", testNow.Add(time.Hour).Unix())),
		"wrong issuer":                        sign(t, p.key, p.kid, with("iss", "https://evil.test/realms/ouo")),
		"wrong audience":                      sign(t, p.key, p.kid, with("aud", "another-client")),
		"no audience":                         sign(t, p.key, p.kid, with("aud", nil)),
		"signed by another key, same kid":     sign(t, attacker, p.kid, claims([]string{"privacy"})),
		"signed by another key, other kid":    sign(t, attacker, "k2", claims([]string{"privacy"})),
		"payload changed after signing":       parts[0] + "." + forgedPayload + "." + parts[2],
		"signature removed":                   parts[0] + "." + parts[1] + ".",
		"alg none":                            b64(map[string]any{"alg": "none", "typ": "JWT"}) + "." + forgedPayload + ".",
		"alg HS256 keyed with the public key": hs256(t, &p.key.PublicKey, b64(map[string]any{"alg": "HS256", "typ": "JWT", "kid": p.kid})+"."+forgedPayload),
		"no key id":                           sign(t, p.key, "", claims([]string{"privacy"})),
	}
	for name, tok := range cases {
		if got, err := p.verifier().Groups(ctx, tok); err == nil || got != nil {
			t.Errorf("%s: groups %v, err %v; want an error and no groups", name, got, err)
		}
		if got, err := p.verifier().Verify(ctx, tok); err == nil || got != nil {
			t.Errorf("%s: claims %v, err %v; want an error and no claims", name, got, err)
		}
	}

	// An incomplete configuration verifies nothing.
	for _, v := range []*Verifier{
		{Audience: testAudience, JWKSURL: p.srv.URL}, {Issuer: testIssuer, JWKSURL: p.srv.URL}, {Issuer: testIssuer, Audience: testAudience},
	} {
		v.Now = func() time.Time { return testNow }
		if got, err := v.Groups(ctx, good); err == nil || got != nil {
			t.Errorf("config %+v: groups %v, want an error", v, got)
		}
	}
}

// hs256 signs with the provider's public key as the HMAC secret: the algorithm-confusion attack.
func hs256(t *testing.T, pub *rsa.PublicKey, signingInput string) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, der)
	mac.Write([]byte(signingInput))
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestKeys(t *testing.T) {
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
	// The provider is down and no keys are held: an error, not a pass, and one attempt a
	// minute, not one per call.
	attempts := 0
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer dead.Close()
	down := &Verifier{Issuer: testIssuer, Audience: testAudience, JWKSURL: dead.URL, Now: v.Now}
	for range 5 {
		if _, err := down.Groups(ctx, sign(t, p.key, p.kid, c)); err == nil {
			t.Errorf("verified without keys")
		}
	}
	if attempts != 1 {
		t.Errorf("provider down: %d fetches for 5 calls, want 1", attempts)
	}
	// It comes back: verified again after the interval.
	down.JWKSURL = p.srv.URL
	now = now.Add(2 * time.Minute)
	c["exp"] = now.Add(time.Minute).Unix()
	if _, err := down.Groups(ctx, sign(t, p.key, p.kid, c)); err != nil {
		t.Errorf("provider back: %v", err)
	}
}
