package muninn

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
)

// Identifier syntax, docs/specs/muninn.md section 2. Identifiers become key
// segments, so nothing else is ever accepted (MUN-5).
var (
	reTenant  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	reProject = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	reHex32   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	reHex64   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reFormat  = regexp.MustCompile(`^[a-z0-9./_-]{1,64}$`)
)

const maxSequence = 999_999_999

// keys builds the storage layout of section 6 under an optional prefix.
type keys struct{ root string } // "<prefix>/muninn/" or "muninn/"

func newKeys(prefix string) keys {
	prefix = strings.Trim(prefix, "/")
	if prefix != "" {
		prefix += "/"
	}
	return keys{root: prefix + "muninn/"}
}

func (k keys) schema() string { return k.root + "schema.json" }
func (k keys) session(t, p, s string) string {
	return k.root + t + "/" + p + "/" + s + "/"
}
func (k keys) replay(t, p, s, r string) string { return k.session(t, p, s) + r + "/" }
func (k keys) tombstone(t, p, s, r string) string {
	return k.replay(t, p, s, r) + "deleted.json"
}
func (k keys) chunk(t, p, s, r, st string, seq int64) string {
	return fmt.Sprintf("%s%s/c/%010d", k.replay(t, p, s, r), st, seq)
}
func (k keys) ended(t, p, s, r, st string) string { return k.replay(t, p, s, r) + st + "/ended.json" }

// Chunk container, section 6.1: "OUOC", version 0x01, header length (uint32 BE),
// header JSON, body.
var magic = []byte("OUOC")

const (
	containerVersion = 1
	preamble         = 9
)

type header struct {
	Attributes   map[string]any `json:"attributes"`
	TimeUnixNano string         `json:"time_unix_nano"`
	ReceivedAt   int64          `json:"received_at"`
	Project      string         `json:"project"`
}

func encodeChunk(h header, body []byte) ([]byte, error) {
	hj, err := json.Marshal(h)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, preamble+len(hj)+len(body))
	out = append(out, magic...)
	out = append(out, containerVersion)
	out = binary.BigEndian.AppendUint32(out, uint32(len(hj)))
	out = append(out, hj...)
	return append(out, body...), nil
}

// errCorrupt marks a stored object that cannot be decoded: not a store failure, so not a 503.
var errCorrupt = errors.New("corrupt object")

var errContainer = fmt.Errorf("%w: not a muninn chunk container", errCorrupt)

// headerLen returns the total length of preamble plus header, from the first 9 bytes.
func headerLen(b []byte) (int, error) {
	if len(b) < preamble || !bytes.Equal(b[:4], magic) || b[4] != containerVersion {
		return 0, errContainer
	}
	return preamble + int(binary.BigEndian.Uint32(b[5:9])), nil
}

// decodeChunk parses a container (or its first bytes). body is nil when b holds the
// header only.
func decodeChunk(b []byte) (h header, body []byte, err error) {
	n, err := headerLen(b)
	if err != nil {
		return h, nil, err
	}
	if len(b) < n {
		return h, nil, fmt.Errorf("%w: short header", errContainer)
	}
	d := json.NewDecoder(bytes.NewReader(b[preamble:n]))
	d.UseNumber()
	if err := d.Decode(&h); err != nil {
		return h, nil, fmt.Errorf("%w: header: %v", errCorrupt, err)
	}
	return h, b[n:], nil
}

// jsonValue converts an OTLP AnyValue for the stored header. Numbers keep their
// type through json.Number on read; bytes become base64 strings.
func jsonValue(v *commonpb.AnyValue) any {
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue
	case *commonpb.AnyValue_BoolValue:
		return x.BoolValue
	case *commonpb.AnyValue_IntValue:
		return x.IntValue
	case *commonpb.AnyValue_DoubleValue:
		return x.DoubleValue
	case *commonpb.AnyValue_BytesValue:
		return base64.StdEncoding.EncodeToString(x.BytesValue)
	case *commonpb.AnyValue_ArrayValue:
		out := make([]any, 0, len(x.ArrayValue.GetValues()))
		for _, e := range x.ArrayValue.GetValues() {
			out = append(out, jsonValue(e))
		}
		return out
	case *commonpb.AnyValue_KvlistValue:
		out := map[string]any{}
		for _, kv := range x.KvlistValue.GetValues() {
			out[kv.GetKey()] = jsonValue(kv.GetValue())
		}
		return out
	}
	return nil
}

// Stored attribute readers (header JSON decoded with UseNumber).
func attrInt(m map[string]any, k string) (int64, bool) {
	switch v := m[k].(type) {
	case json.Number:
		i, err := v.Int64()
		if err != nil {
			f, ferr := v.Float64()
			return int64(f), ferr == nil
		}
		return i, true
	case int64:
		return v, true
	case float64:
		return int64(v), true
	}
	return 0, false
}

func attrString(m map[string]any, k string) string { s, _ := m[k].(string); return s }
func attrBool(m map[string]any, k string) bool     { b, _ := m[k].(bool); return b }

func parseSeq(s string) (int64, bool) {
	if len(s) == 0 || len(s) > 10 {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil && n >= 0 && n <= maxSequence
}
