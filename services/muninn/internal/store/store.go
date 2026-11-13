// Package store is Muninn's object storage: an S3-compatible bucket or a local
// directory with the same relative paths (docs/specs/muninn.md section 6). Keys use
// "/" as separator on both backends.
package store

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrExists is returned by Create when the key is already stored.
	ErrExists = errors.New("object exists")
	// ErrNotFound is returned by Get and GetRange when the key is not stored.
	ErrNotFound = errors.New("object not found")
)

// Object is one entry of a listing.
type Object struct {
	Key      string
	Size     int64
	Modified time.Time
}

// Store is the small set of operations Muninn needs. Every error other than
// ErrExists and ErrNotFound is transient for the caller (ingest answers 503).
type Store interface {
	// Create writes data under key only if the key does not exist (MUN-20), and
	// returns once the write is durable (MUN-16). tags are S3 object tags; the
	// filesystem backend ignores them.
	Create(ctx context.Context, key string, data []byte, tags map[string]string) error
	// Put writes or overwrites key. Only schema.json uses it (MUN-21).
	Put(ctx context.Context, key string, data []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
	// GetRange reads at most n bytes from off; fewer at the end of the object.
	GetRange(ctx context.Context, key string, off, n int64) ([]byte, error)
	// List returns every object whose key starts with prefix, at any depth.
	List(ctx context.Context, prefix string) ([]Object, error)
	// Delete removes key; a missing key is not an error.
	Delete(ctx context.Context, key string) error
	// Ping reports whether the store is reachable (GET /ready).
	Ping(ctx context.Context) error
}
