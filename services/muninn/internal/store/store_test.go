package store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"
)

// Both backends behave the same. The S3 run needs a MinIO: set OUO_TEST_S3_ENDPOINT
// (host:port), OUO_TEST_S3_BUCKET, OUO_TEST_S3_ACCESS_KEY and OUO_TEST_S3_SECRET_KEY,
// e.g. against `docker compose --profile s3` of deploy/compose.
func backends(t *testing.T) map[string]Store {
	fs, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]Store{"filesystem": fs}
	if ep := os.Getenv("OUO_TEST_S3_ENDPOINT"); ep != "" {
		s3, err := NewS3(S3Config{Endpoint: ep, Bucket: os.Getenv("OUO_TEST_S3_BUCKET"), Insecure: true,
			AccessKeyID: os.Getenv("OUO_TEST_S3_ACCESS_KEY"), SecretAccessKey: os.Getenv("OUO_TEST_S3_SECRET_KEY")})
		if err != nil {
			t.Fatal(err)
		}
		out["s3"] = s3
	}
	return out
}

func TestStore(t *testing.T) {
	for name, st := range backends(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			p := fmt.Sprintf("test-%d/", time.Now().UnixNano())
			k := p + "a/c/0000000001"
			if err := st.Create(ctx, k, []byte("first"), map[string]string{"ouo-retention": "37d"}); err != nil {
				t.Fatal(err)
			}
			if err := st.Create(ctx, k, []byte("second"), nil); !errors.Is(err, ErrExists) {
				t.Fatalf("second create: %v", err)
			}
			if b, err := st.Get(ctx, k); err != nil || string(b) != "first" {
				t.Fatalf("get %q %v", b, err)
			}
			if b, err := st.GetRange(ctx, k, 1, 100); err != nil || string(b) != "irst" {
				t.Fatalf("range %q %v", b, err)
			}
			if _, err := st.Get(ctx, p+"missing"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("missing: %v", err)
			}
			if _, err := st.GetRange(ctx, p+"missing", 0, 1); !errors.Is(err, ErrNotFound) {
				t.Fatalf("missing range: %v", err)
			}
			_ = st.Create(ctx, p+"b/ended.json", []byte("{}"), nil)
			_ = st.Create(ctx, p+"ab", []byte("x"), nil) // shares the "a" prefix as a string only
			objs, err := st.List(ctx, p+"a/")
			if err != nil || len(objs) != 1 || objs[0].Key != k || objs[0].Size != 5 || objs[0].Modified.IsZero() {
				t.Fatalf("list %v %v", objs, err)
			}
			if objs, _ = st.List(ctx, p); len(objs) != 3 {
				t.Fatalf("list all %v", objs)
			}
			if err := st.Put(ctx, p+"schema.json", []byte("1")); err != nil {
				t.Fatal(err)
			}
			if err := st.Put(ctx, p+"schema.json", []byte("2")); err != nil {
				t.Fatal(err)
			}
			if b, _ := st.Get(ctx, p+"schema.json"); string(b) != "2" {
				t.Fatalf("put %q", b)
			}
			for _, o := range []string{k, p + "b/ended.json", p + "ab", p + "schema.json", p + "never"} {
				if err := st.Delete(ctx, o); err != nil {
					t.Fatal(err)
				}
			}
			if objs, _ = st.List(ctx, p); len(objs) != 0 {
				t.Fatalf("left %v", objs)
			}
			if err := st.Ping(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// MUN-20: concurrent create-only writes of one key, one winner.
func TestCreateRace(t *testing.T) {
	for name, st := range backends(t) {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			k := fmt.Sprintf("race-%d/c/0000000000", time.Now().UnixNano())
			var wg sync.WaitGroup
			var mu sync.Mutex
			wins, exists := 0, 0
			for i := range 8 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					err := st.Create(ctx, k, bytes.Repeat([]byte{byte(i)}, 1000), nil)
					mu.Lock()
					defer mu.Unlock()
					switch {
					case err == nil:
						wins++
					case errors.Is(err, ErrExists):
						exists++
					default:
						t.Errorf("create: %v", err)
					}
				}()
			}
			wg.Wait()
			if wins != 1 || exists != 7 {
				t.Fatalf("wins %d exists %d", wins, exists)
			}
			_ = st.Delete(ctx, k)
		})
	}
}
