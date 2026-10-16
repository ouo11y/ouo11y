package ouosentryreceiver

import (
	"bytes"
	"compress/flate"
	"compress/zlib"
	"strings"
	"testing"
)

func TestParseEnvelope(t *testing.T) {
	env, err := ParseEnvelope([]byte(sampleEnvelope))
	if err != nil {
		t.Fatal(err)
	}
	if env.Header.EventID != "9ec79c33ec9942ab8353589fcb2e04dc" || env.Header.SDK.Name != "sentry.cocoa" {
		t.Errorf("header: %+v", env.Header)
	}
	if len(env.Items) != 2 || env.Items[0].Type != "session" || env.Items[1].Type != "event" {
		t.Fatalf("items: %+v", env.Items)
	}
	if !strings.HasPrefix(string(env.Items[0].Payload), `{"sid"`) || !strings.HasSuffix(string(env.Items[0].Payload), `}}`) {
		t.Errorf("session payload: %q", env.Items[0].Payload)
	}
	if string(env.Items[1].Payload) != `{"event_id":"9ec79c33ec9942ab8353589fcb2e04dc","level":"error"}` {
		t.Errorf("event payload: %q", env.Items[1].Payload)
	}
}

func TestParseEnvelopeBinaryAndEdges(t *testing.T) {
	bin := []byte{0x83, 0x0a, 0x00, 0xff, 0x0a} // contains newlines: only length framing works
	b := append([]byte("{}\n{\"type\":\"replay_video\",\"length\":5}\n"), bin...)
	env, err := ParseEnvelope(b) // no trailing newline after a length payload is allowed (EOF)
	if err != nil {
		t.Fatal(err)
	}
	if len(env.Items) != 1 || !bytes.Equal(env.Items[0].Payload, bin) {
		t.Fatalf("binary payload: %+v", env.Items)
	}
	ok := map[string]int{
		"{}":                               0,
		"{}\n":                             0,
		"{}\n{\"type\":\"session\"}\n{}\n": 1,
		"{}\n{\"type\":\"session\"}\n{}":   1, // last payload without newline
		"{}\n{\"type\":\"attachment\",\"length\":0}\n\n": 1,
		"{}\n{\"type\":\"session\"}":                     1, // header at EOF, empty payload
	}
	for in, n := range ok {
		env, err := ParseEnvelope([]byte(in))
		if n < 0 {
			if err == nil {
				t.Errorf("%q: want error", in)
			}
			continue
		}
		if err != nil || len(env.Items) != n {
			t.Errorf("%q: items %v err %v, want %d", in, env, err, n)
		}
	}
	for _, in := range []string{
		"not json\n",
		"{}\n{\"type\":\"event\",\"length\":50}\n{}\n",
		"{}\n{\"type\":\"event\",\"length\":2}\n{}X",
		"{}\n{\"length\":2}\n{}\n",
	} {
		if _, err := ParseEnvelope([]byte(in)); err == nil {
			t.Errorf("%q: want error", in)
		}
	}
}

func TestDecompress(t *testing.T) {
	plain := []byte(sampleEnvelope)
	var zl, fl bytes.Buffer
	zw := zlib.NewWriter(&zl)
	_, _ = zw.Write(plain)
	_ = zw.Close()
	fw, _ := flate.NewWriter(&fl, flate.DefaultCompression)
	_, _ = fw.Write(plain)
	_ = fw.Close()
	for enc, body := range map[string][]byte{"": plain, "identity": plain, "gzip": gz(t, plain), "deflate": zl.Bytes()} {
		got, err := Decompress(body, enc, 1<<20)
		if err != nil || !bytes.Equal(got, plain) {
			t.Errorf("%s: %v", enc, err)
		}
	}
	if got, err := Decompress(fl.Bytes(), "deflate", 1<<20); err != nil || !bytes.Equal(got, plain) {
		t.Errorf("raw deflate: %v", err)
	}
	if _, err := Decompress(gz(t, plain), "gzip", 10); err == nil {
		t.Error("limit not enforced")
	}
	if _, err := Decompress(plain, "br", 1<<20); err == nil {
		t.Error("br must be unsupported")
	}
}

func TestKeyFromAuthHeader(t *testing.T) {
	for in, want := range map[string]string{
		"Sentry sentry_key=abc, sentry_version=7":                 "abc",
		"Sentry sentry_version=7,sentry_client=x/1,sentry_key=k1": "k1",
		"sentry sentry_key = k2":                                  "k2",
		"Basic abc":                                               "",
		"":                                                        "",
	} {
		if got := keyFromAuthHeader(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
	if keyFromDSN("https://pub:sec@o1.ingest.sentry.io/1") != "pub" || keyFromDSN("nope") != "" {
		t.Error("keyFromDSN")
	}
}
