package sourcemap

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrNotFound is returned when no map matches. It wraps fs.ErrNotExist, which
// is what every Objects.Get returns (wrapped) for a missing key.
var ErrNotFound = fmt.Errorf("source map not found: %w", fs.ErrNotExist)

// ObjectInfo is one listed object.
type ObjectInfo struct {
	Key     string
	ModTime time.Time
}

// Objects is the key / value view of the replay bucket the maps live in:
// files under <data dir>/sourcemaps (FSObjects) or objects under
// [<prefix>/]sourcemaps/ (replay.Objects on S3). Keys use "/" separators and
// are relative to that root.
type Objects interface {
	Put(ctx context.Context, key string, data []byte) error
	// Get returns an error wrapping fs.ErrNotExist for a missing key.
	Get(ctx context.Context, key string) ([]byte, error)
	// List returns every key under prefix (recursive).
	List(ctx context.Context, prefix string) ([]ObjectInfo, error)
	// Delete removes a key; no error when absent.
	Delete(ctx context.Context, key string) error
}

// FSObjects stores keys as files under Root.
type FSObjects struct{ Root string }

// NewFSObjects creates <dataDir>/sourcemaps.
func NewFSObjects(dataDir string) (*FSObjects, error) {
	root := filepath.Join(dataDir, "sourcemaps")
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create %s: %w", root, err)
	}
	return &FSObjects{Root: root}, nil
}

func (o *FSObjects) path(key string) (string, error) {
	if key == "" || strings.Contains(key, "..") || strings.HasPrefix(key, "/") {
		return "", fmt.Errorf("invalid key %q", key)
	}
	return filepath.Join(o.Root, filepath.FromSlash(key)), nil
}

// Put writes the file through a temporary name, so a reader never sees half a map.
func (o *FSObjects) Put(_ context.Context, key string, data []byte) error {
	p, err := o.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".upload-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), p)
}

func (o *FSObjects) Get(_ context.Context, key string) ([]byte, error) {
	p, err := o.path(key)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return b, err
}

func (o *FSObjects) List(_ context.Context, prefix string) ([]ObjectInfo, error) {
	var out []ObjectInfo
	start := filepath.Join(o.Root, filepath.FromSlash(prefix))
	err := filepath.WalkDir(start, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".upload-") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil // removed meanwhile
		}
		rel, _ := filepath.Rel(o.Root, p)
		out = append(out, ObjectInfo{Key: filepath.ToSlash(rel), ModTime: info.ModTime()})
		return nil
	})
	return out, err
}

func (o *FSObjects) Delete(_ context.Context, key string) error {
	p, err := o.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	// Drop empty parent directories up to the root (best effort).
	for d := filepath.Dir(p); d != o.Root && strings.HasPrefix(d, o.Root); d = filepath.Dir(d) {
		if os.Remove(d) != nil {
			break
		}
	}
	return nil
}
