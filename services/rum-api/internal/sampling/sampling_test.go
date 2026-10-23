package sampling

import (
	"fmt"
	"testing"
)

// The vectors are shared with sdk/react-native/test/sampling.test.ts: both
// sides must compute the same hash for the same session id.
var vectors = []struct {
	in   string
	hash uint32
}{
	{"", 0xab3e7c0b},
	{"a", 0x1a80b1b3},
	{"replay:3c63803d-6d13-4d79-944a-72c1c26f23cb", 0x1a72a21c},
	{"session:é😀x", 0x30555dd9},
}

func TestHashVectors(t *testing.T) {
	for _, v := range vectors {
		if got := Hash(v.in); got != v.hash {
			t.Errorf("Hash(%q) = %#x, want %#x", v.in, got, v.hash)
		}
	}
}

func TestSampledBounds(t *testing.T) {
	for i := range 100 {
		id := fmt.Sprintf("s-%d", i)
		if !Sampled(id, 1, Replay) || Sampled(id, 0, Replay) {
			t.Fatalf("bounds wrong for %s", id)
		}
	}
}

func TestSampledRateAndSubset(t *testing.T) {
	const n = 20000
	in50, in20 := 0, 0
	for i := range n {
		id := fmt.Sprintf("%08x-session-%d", i*7919, i)
		a, b := Sampled(id, 0.5, Session), Sampled(id, 0.2, Session)
		if b && !a {
			t.Fatalf("%s: in the 0.2 sample but not in the 0.5 sample", id)
		}
		if a {
			in50++
		}
		if b {
			in20++
		}
	}
	if in50 < n*45/100 || in50 > n*55/100 || in20 < n*17/100 || in20 > n*23/100 {
		t.Fatalf("rates off: 0.5 -> %d, 0.2 -> %d of %d", in50, in20, n)
	}
}

func TestSaltsAreIndependent(t *testing.T) {
	same := 0
	for i := range 1000 {
		id := fmt.Sprintf("id-%d", i)
		if Sampled(id, 0.5, Session) == Sampled(id, 0.5, Replay) {
			same++
		}
	}
	if same > 600 || same < 400 {
		t.Fatalf("session and replay decisions look correlated: %d/1000 equal", same)
	}
}
