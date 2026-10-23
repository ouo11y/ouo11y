package replay

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testSchemaGuard(t *testing.T, open func(t *testing.T) SchemaMarkerStore) {
	ctx := context.Background()
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

	t.Run("adopts a store without a marker", func(t *testing.T) {
		st := open(t)
		if _, err := st.ReadSchemaMarker(ctx); !errors.Is(err, ErrNotFound) {
			t.Fatalf("fresh store marker: %v, want ErrNotFound", err)
		}
		if err := CheckSchema(ctx, st, "0.4.0", now); err != nil {
			t.Fatal(err)
		}
		m, err := st.ReadSchemaMarker(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if m.MaxSchemaVersion != SchemaVersion || m.RumAPIVersion != "0.4.0" || !m.UpdatedAt.Equal(now) {
			t.Fatalf("marker %+v", m)
		}
	})

	t.Run("records a newer release on the same schema", func(t *testing.T) {
		st := open(t)
		if err := st.WriteSchemaMarker(ctx, SchemaMarker{MaxSchemaVersion: SchemaVersion, RumAPIVersion: "0.4.0"}); err != nil {
			t.Fatal(err)
		}
		if err := CheckSchema(ctx, st, "0.5.0", now); err != nil {
			t.Fatal(err)
		}
		if m, _ := st.ReadSchemaMarker(ctx); m.RumAPIVersion != "0.5.0" {
			t.Fatalf("marker %+v, want rum_api_version 0.5.0", m)
		}
		// A rollback on the same schema is allowed: it is not a schema bump.
		if err := CheckSchema(ctx, st, "0.4.0", now); err != nil {
			t.Fatalf("rollback on the same schema: %v", err)
		}
	})

	t.Run("refuses a store written by a newer schema", func(t *testing.T) {
		st := open(t)
		newer := SchemaMarker{MaxSchemaVersion: SchemaVersion + 1, RumAPIVersion: "9.0.0", UpdatedAt: now}
		if err := st.WriteSchemaMarker(ctx, newer); err != nil {
			t.Fatal(err)
		}
		err := CheckSchema(ctx, st, "0.4.0", now.Add(time.Hour))
		if !errors.Is(err, ErrSchemaTooNew) {
			t.Fatalf("err = %v, want ErrSchemaTooNew", err)
		}
		for _, want := range []string{"rum-api 9.0.0", "this rum-api 0.4.0", "docs/operations/upgrade.md"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("message %q lacks %q", err, want)
			}
		}
		if m, _ := st.ReadSchemaMarker(ctx); m != newer {
			t.Fatalf("refused start rewrote the marker: %+v", m)
		}
	})
}

func TestFSSchemaGuard(t *testing.T) {
	testSchemaGuard(t, func(t *testing.T) SchemaMarkerStore {
		st, err := NewFS(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		return st
	})
}

func TestS3SchemaGuard(t *testing.T) {
	testSchemaGuard(t, func(t *testing.T) SchemaMarkerStore {
		_, bucket := testBucket(t)
		return openS3(t, bucket, "env/prod")
	})
}

func TestFSSchemaMarkerFile(t *testing.T) {
	dir := t.TempDir()
	st, err := NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	path := filepath.Join(dir, "replays", "schema.json")
	// The layout the operator sees (upgrade.md section 4).
	if err := CheckSchema(ctx, st, "0.4.0", time.Unix(0, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	// A hand-edited or truncated marker stops the start instead of being overwritten.
	for name, body := range map[string]string{"garbage": "{", "zero": `{"max_schema_version":0}`} {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := CheckSchema(ctx, st, "0.4.0", time.Unix(0, 0)); err == nil || errors.Is(err, ErrSchemaTooNew) {
			t.Errorf("%s marker: err = %v, want a read error", name, err)
		}
	}
	// A store holding replays from a release without the guard is adopted, the sessions untouched.
	os.Remove(path)
	if _, err := st.Put(ctx, "demo", chunkJSON("old-1", 0, 1000, map[string]any{"type": 4, "timestamp": 1000}), nil); err != nil {
		t.Fatal(err)
	}
	if err := CheckSchema(ctx, st, "0.4.0", time.Unix(0, 0)); err != nil {
		t.Fatal(err)
	}
	if !st.Has(ctx, "old-1") {
		t.Fatal("session lost")
	}
}
