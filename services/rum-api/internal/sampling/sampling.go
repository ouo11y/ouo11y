// Package sampling is the deterministic session sampling rule shared by the
// SDKs and rum-api (docs/operations/data-lifecycle.md, section Sampling): a
// session is in the sample of rate r for decision salt s when
//
//	mix(fnv1a32(s + ":" + sessionID)) / 2^32 < r
//
// FNV-1a runs over the UTF-16 code units of the string (JavaScript's
// charCodeAt) and mix is MurmurHash3's 32-bit finalizer (FNV alone leaves the
// high bits of similar ids correlated across salts), so @ouo11y/react-native and rum-api agree on every session
// id. The same id always gets the same answer, which is what lets a
// server-side cap below the SDK's rate keep a subset of the SDK's sample.
package sampling

import "unicode/utf16"

// Decision salts.
const (
	Session       = "session"
	Replay        = "replay"
	ReplayOnError = "replay_on_error"
)

// Hash is FNV-1a 32 over the UTF-16 code units of s, then MurmurHash3's
// fmix32.
func Hash(s string) uint32 {
	h := uint32(0x811c9dc5)
	for _, c := range utf16.Encode([]rune(s)) {
		h ^= uint32(c)
		h *= 0x01000193
	}
	h ^= h >> 16
	h *= 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return h
}

// Sampled reports whether sessionID is in the sample of rate for salt. A
// rate of 1 or more keeps everything, 0 or less nothing.
func Sampled(sessionID string, rate float64, salt string) bool {
	if rate >= 1 {
		return true
	}
	if rate <= 0 {
		return false
	}
	return float64(Hash(salt+":"+sessionID))/4294967296 < rate
}
