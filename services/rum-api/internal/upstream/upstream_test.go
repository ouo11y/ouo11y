package upstream

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientSetsHeaders(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = r.Header.Clone() }))
	defer srv.Close()

	base := &http.Client{}
	h := http.Header{}
	h.Set("X-Scope-OrgID", "pilot")
	h.Set("Authorization", "Basic dTpw")
	c := Client(base, h)
	if base.Transport != nil {
		t.Fatal("base client modified")
	}
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("X-Scope-OrgID", "caller")
	if _, err := c.Do(req); err != nil {
		t.Fatal(err)
	}
	if got.Get("X-Scope-OrgID") != "pilot" || got.Get("Authorization") != "Basic dTpw" || len(got.Values("X-Scope-OrgID")) != 1 {
		t.Fatalf("headers: %v", got)
	}
	// The caller's request is untouched (RoundTripper contract).
	if req.Header.Get("X-Scope-OrgID") != "caller" || req.Header.Get("Authorization") != "" {
		t.Fatalf("request modified: %v", req.Header)
	}
	// Changing the header map afterwards does not leak into the client.
	h.Set("X-Scope-OrgID", "other")
	if _, err := c.Get(srv.URL); err != nil {
		t.Fatal(err)
	}
	if got.Get("X-Scope-OrgID") != "pilot" {
		t.Fatalf("headers not copied: %v", got)
	}
}

func TestClientWithoutHeaders(t *testing.T) {
	base := &http.Client{}
	if Client(base, nil) != base {
		t.Fatal("no headers must return the same client")
	}
}
