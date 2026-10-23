package replay

import (
	"context"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
)

func sessionIDs(t *testing.T, l Lister) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	if err := l.Sessions(context.Background(), func(e SessionEntry) error {
		out[e.ID] = e.Meta != nil
		if e.LastModified.IsZero() {
			t.Errorf("%s: zero LastModified", e.ID)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestFSSessions(t *testing.T) {
	ctx := context.Background()
	st, err := NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"s1", "s2"} {
		if _, err := st.Put(ctx, "demo", chunkJSON(id, 0, 1000, map[string]any{"type": 4, "timestamp": 1000}), nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.WriteSchemaMarker(ctx, SchemaMarker{MaxSchemaVersion: 1, RumAPIVersion: "test"}); err != nil {
		t.Fatal(err)
	}
	if got := sessionIDs(t, st); !reflect.DeepEqual(got, map[string]bool{"s1": true, "s2": true}) {
		t.Fatalf("sessions: %v", got)
	}
}

func TestRetentionTag(t *testing.T) {
	for d, want := range map[time.Duration]string{0: "keep", time.Minute: "1d", 24 * time.Hour: "1d", 25 * time.Hour: "2d", 720 * time.Hour: "30d"} {
		if got := RetentionTag(d); got != want {
			t.Errorf("RetentionTag(%s) = %s, want %s", d, got, want)
		}
	}
}

func TestS3SessionsTagsAndLifecycle(t *testing.T) {
	ctx := context.Background()
	admin, bucket := testBucket(t)
	st := openS3(t, bucket, "env")
	st.Retention = func(p string) time.Duration {
		if p == "ttltest" {
			return time.Hour
		}
		return 30 * 24 * time.Hour
	}
	if _, err := st.Put(ctx, "demo", chunkJSON("s-demo", 0, 1000, map[string]any{"type": 4, "timestamp": 1000}), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(ctx, "ttltest", mustJSON(t, videoChunk("s-ttl", 0, 1000, tinyMP4(500, 'a'), nil)), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.WriteSchemaMarker(ctx, SchemaMarker{MaxSchemaVersion: 1, RumAPIVersion: "test"}); err != nil {
		t.Fatal(err)
	}
	// An orphan prefix (chunk without meta.json).
	if err := st.put(ctx, st.key("s-orphan", chunkName(0)), []byte("x"), "application/gzip", nil); err != nil {
		t.Fatal(err)
	}
	if got := sessionIDs(t, st); !reflect.DeepEqual(got, map[string]bool{"s-demo": true, "s-ttl": true, "s-orphan": false}) {
		t.Fatalf("sessions: %v", got)
	}

	tags := func(key string) string {
		tg, err := admin.GetObjectTagging(ctx, bucket, key, minio.GetObjectTaggingOptions{})
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		return tg.ToMap()[RetentionTagKey]
	}
	for key, want := range map[string]string{
		"env/replays/s-demo/000000.json.gz": "30d", "env/replays/s-demo/meta.json": "30d",
		"env/replays/s-ttl/000000.mp4": "1d", "env/replays/s-ttl/000000.json.gz": "1d", "env/replays/s-ttl/meta.json": "1d",
		"env/replays/schema.json": "",
	} {
		if got := tags(key); got != want {
			t.Errorf("%s: tag %q, want %q", key, got, want)
		}
	}

	// A rule the operator owns survives; ours are replaced on every apply.
	theirs := lifecycle.NewConfiguration()
	theirs.Rules = []lifecycle.Rule{{ID: "tmp-cleanup", Status: "Enabled", RuleFilter: lifecycle.Filter{Prefix: "tmp/"},
		Expiration: lifecycle.Expiration{Days: 7}}}
	if err := admin.SetBucketLifecycle(ctx, bucket, theirs); err != nil {
		t.Fatal(err)
	}
	for range 2 { // idempotent
		if err := st.ApplyLifecycleRules(ctx, []time.Duration{30 * 24 * time.Hour, time.Hour, 0, 720 * time.Hour}); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := admin.GetBucketLifecycle(ctx, bucket)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, r := range cfg.Rules {
		desc := r.ID
		if strings.HasPrefix(r.ID, lifecycleRulePrefix) {
			tagsOf := r.RuleFilter.And.Tags
			if r.RuleFilter.And.Prefix != "env/replays/" || len(tagsOf) != 1 || tagsOf[0].Key != RetentionTagKey {
				t.Errorf("rule %s filter %+v", r.ID, r.RuleFilter)
			}
			desc += "=" + tagsOf[0].Value + "/" + strconv.Itoa(int(r.Expiration.Days))
		}
		got = append(got, desc)
	}
	sort.Strings(got)
	if want := []string{"ouo-replays-1d=1d/1", "ouo-replays-30d=30d/30", "tmp-cleanup"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("rules %v, want %v", got, want)
	}
}

func TestS3AuditObjects(t *testing.T) {
	ctx := context.Background()
	_, bucket := testBucket(t)
	st := openS3(t, bucket, "p")
	a := AuditObjects{S3: st}
	if err := a.PutNew(ctx, "20261023T120000.000000000Z-abc-started.json", []byte(`{"id":"abc"}`)); err != nil {
		t.Fatal(err)
	}
	if err := a.PutNew(ctx, "20261023T120000.000000000Z-abc-started.json", []byte(`{"id":"evil"}`)); err == nil {
		t.Fatal("an audit object was overwritten")
	}
	names, err := a.Names(ctx)
	if err != nil || len(names) != 1 {
		t.Fatalf("%v %v", names, err)
	}
	b, err := a.Get(ctx, names[0])
	if err != nil || string(b) != `{"id":"abc"}` {
		t.Fatalf("%s %v", b, err)
	}
	// Audit objects are not sessions.
	if got := sessionIDs(t, st); len(got) != 0 {
		t.Fatalf("sessions: %v", got)
	}
}
