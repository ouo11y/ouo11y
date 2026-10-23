package replay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/minio/minio-go/v7"
)

// SchemaVersion is the highest replay chunk `schema_version` this rum-api
// reads (docs/specs/mobile-replay.md). Bump it together with parse.go when a
// new schema lands, never for a change older releases can still read.
const SchemaVersion = 1

// schemaMarkerName is the store-wide marker next to the session folders:
// DATA_DIR/replays/schema.json, or [<prefix>/]replays/schema.json on S3
// (docs/operations/upgrade.md section 4). It is a file, so no session folder
// can be called that.
const schemaMarkerName = "schema.json"

// SchemaMarker is the content of schema.json: the schema the last rum-api
// that started on this store knew, and its version.
type SchemaMarker struct {
	MaxSchemaVersion int       `json:"max_schema_version"`
	RumAPIVersion    string    `json:"rum_api_version"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// ErrSchemaTooNew is returned by CheckSchema when the store was last opened
// by a rum-api that knows a newer replay schema than this one.
var ErrSchemaTooNew = errors.New("replay store written by a newer replay schema")

// SchemaMarkerStore is implemented by FS and S3.
type SchemaMarkerStore interface {
	// ReadSchemaMarker returns the marker, or ErrNotFound when the store has
	// none (new, or written before rum-api 0.4.0).
	ReadSchemaMarker(ctx context.Context) (SchemaMarker, error)
	WriteSchemaMarker(ctx context.Context, m SchemaMarker) error
}

// CheckSchema is the start-up guard: it refuses a store whose marker names a
// newer schema than SchemaVersion (an old binary must never half-read new
// data, so a rollback across a schema bump stops here) and otherwise records
// this release in the marker. A store without a marker was written by a
// release that only knew schema 1 and is adopted.
func CheckSchema(ctx context.Context, st SchemaMarkerStore, rumAPIVersion string, now time.Time) error {
	m, err := st.ReadSchemaMarker(ctx)
	switch {
	case errors.Is(err, ErrNotFound):
	case err != nil:
		return fmt.Errorf("read replay schema marker: %w", err)
	case m.MaxSchemaVersion > SchemaVersion:
		return fmt.Errorf("%w: the store was last opened by rum-api %s, which reads replay schema_version up to %d; "+
			"this rum-api %s reads up to %d. Run rum-api %s or newer on this store; do not roll back across a schema bump "+
			"(docs/operations/upgrade.md section 4)",
			ErrSchemaTooNew, m.RumAPIVersion, m.MaxSchemaVersion, rumAPIVersion, SchemaVersion, m.RumAPIVersion)
	case m.MaxSchemaVersion == SchemaVersion && m.RumAPIVersion == rumAPIVersion:
		return nil // nothing to record; spares a write on every restart
	}
	if err := st.WriteSchemaMarker(ctx, SchemaMarker{MaxSchemaVersion: SchemaVersion, RumAPIVersion: rumAPIVersion, UpdatedAt: now.UTC()}); err != nil {
		return fmt.Errorf("write replay schema marker: %w", err)
	}
	return nil
}

func decodeSchemaMarker(b []byte) (SchemaMarker, error) {
	var m SchemaMarker
	if err := json.Unmarshal(b, &m); err != nil {
		return m, fmt.Errorf("%s: %w", schemaMarkerName, err)
	}
	if m.MaxSchemaVersion < 1 {
		return m, fmt.Errorf("%s: max_schema_version must be >= 1, got %d", schemaMarkerName, m.MaxSchemaVersion)
	}
	return m, nil
}

func encodeSchemaMarker(m SchemaMarker) ([]byte, error) {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// ReadSchemaMarker implements SchemaMarkerStore.
func (s *FS) ReadSchemaMarker(ctx context.Context) (SchemaMarker, error) {
	b, err := os.ReadFile(filepath.Join(s.Root, schemaMarkerName))
	if errors.Is(err, os.ErrNotExist) {
		return SchemaMarker{}, ErrNotFound
	}
	if err != nil {
		return SchemaMarker{}, err
	}
	return decodeSchemaMarker(b)
}

// WriteSchemaMarker implements SchemaMarkerStore.
func (s *FS) WriteSchemaMarker(ctx context.Context, m SchemaMarker) error {
	b, err := encodeSchemaMarker(m)
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.Root, schemaMarkerName), b)
}

func (s *S3) schemaMarkerKey() string { return s.prefix + "replays/" + schemaMarkerName }

// ReadSchemaMarker implements SchemaMarkerStore.
func (s *S3) ReadSchemaMarker(ctx context.Context) (SchemaMarker, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, s.schemaMarkerKey(), minio.GetObjectOptions{})
	if err != nil {
		return SchemaMarker{}, err
	}
	defer obj.Close()
	b, err := io.ReadAll(obj)
	if err != nil {
		if isNoSuchKey(err) {
			return SchemaMarker{}, ErrNotFound
		}
		return SchemaMarker{}, err
	}
	return decodeSchemaMarker(b)
}

// WriteSchemaMarker implements SchemaMarkerStore. Replicas starting together
// write the same content, so the last writer winning is fine.
func (s *S3) WriteSchemaMarker(ctx context.Context, m SchemaMarker) error {
	b, err := encodeSchemaMarker(m)
	if err != nil {
		return err
	}
	return s.put(ctx, s.schemaMarkerKey(), b, "application/json", nil)
}
