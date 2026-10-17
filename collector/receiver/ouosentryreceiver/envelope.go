package ouosentryreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouosentryreceiver"

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Envelope is a parsed Sentry envelope (develop.sentry.dev "Envelopes").
type Envelope struct {
	Header EnvelopeHeader
	Items  []Item
}

// EnvelopeHeader holds the envelope header fields the bridge reads. Raw keeps
// the whole header line.
type EnvelopeHeader struct {
	EventID string          `json:"event_id"`
	DSN     string          `json:"dsn"`
	SentAt  string          `json:"sent_at"`
	SDK     SDKInfo         `json:"sdk"`
	Trace   json.RawMessage `json:"trace"`
	Raw     json.RawMessage `json:"-"`
}

// SDKInfo is the `sdk` object of envelope headers and events.
type SDKInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// Item is one envelope item: its header and raw payload bytes.
type Item struct {
	Type    string
	Header  json.RawMessage
	Payload []byte
}

var errMalformed = errors.New("malformed envelope")

// ParseEnvelope parses the decompressed body. Grammar:
//
//	Envelope = Headers { "\n" Item } [ "\n" ]
//	Item     = Headers "\n" Payload
//
// A payload is exactly `length` bytes when the item header has a length,
// otherwise it runs to the next newline or the end of input.
func ParseEnvelope(b []byte) (*Envelope, error) {
	line, rest, _ := bytes.Cut(b, []byte("\n"))
	env := &Envelope{}
	if err := json.Unmarshal(line, &env.Header); err != nil {
		return nil, fmt.Errorf("%w: header: %v", errMalformed, err)
	}
	env.Header.Raw = append(json.RawMessage(nil), line...)
	for len(rest) > 0 {
		// Tolerate blank lines between items (trailing newline, CRLF tails).
		if rest[0] == '\n' {
			rest = rest[1:]
			continue
		}
		hdrLine, after, found := bytes.Cut(rest, []byte("\n"))
		var ih struct {
			Type   string `json:"type"`
			Length *int64 `json:"length"`
		}
		if err := json.Unmarshal(hdrLine, &ih); err != nil {
			return nil, fmt.Errorf("%w: item %d header: %v", errMalformed, len(env.Items), err)
		}
		if ih.Type == "" {
			return nil, fmt.Errorf("%w: item %d has no type", errMalformed, len(env.Items))
		}
		it := Item{Type: ih.Type, Header: append(json.RawMessage(nil), hdrLine...)}
		if !found {
			// Header at end of input: empty payload.
			env.Items = append(env.Items, it)
			break
		}
		if ih.Length != nil {
			n := *ih.Length
			if n < 0 || n > int64(len(after)) {
				return nil, fmt.Errorf("%w: item %d (%s) length %d exceeds remaining %d bytes", errMalformed, len(env.Items), ih.Type, n, len(after))
			}
			it.Payload = after[:n]
			rest = after[n:]
			if len(rest) > 0 {
				if rest[0] != '\n' {
					return nil, fmt.Errorf("%w: item %d (%s) payload not followed by newline", errMalformed, len(env.Items), ih.Type)
				}
				rest = rest[1:]
			}
		} else {
			p, r, _ := bytes.Cut(after, []byte("\n"))
			it.Payload = p
			rest = r
		}
		env.Items = append(env.Items, it)
	}
	return env, nil
}

// Decompress returns the body decoded according to Content-Encoding. The
// limit bounds the decompressed size.
func Decompress(body []byte, contentEncoding string, limit int64) ([]byte, error) {
	var rd io.Reader
	switch enc := strings.ToLower(strings.TrimSpace(contentEncoding)); enc {
	case "", "identity":
		return body, nil
	case "gzip", "x-gzip":
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		rd = zr
	case "deflate":
		// HTTP "deflate" is zlib-wrapped; some clients send raw deflate.
		if zr, err := zlib.NewReader(bytes.NewReader(body)); err == nil {
			defer zr.Close()
			rd = zr
		} else {
			fr := flate.NewReader(bytes.NewReader(body))
			defer fr.Close()
			rd = fr
		}
	default:
		return nil, fmt.Errorf("unsupported content encoding %q", contentEncoding)
	}
	out, err := io.ReadAll(io.LimitReader(rd, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(out)) > limit {
		return nil, fmt.Errorf("decompressed envelope larger than %d bytes", limit)
	}
	return out, nil
}
