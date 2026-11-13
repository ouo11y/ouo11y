package store

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// FS stores objects as files under a root directory.
type FS struct{ root string }

// NewFS creates the root directory if needed.
func NewFS(root string) (*FS, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	return &FS{root: root}, nil
}

const tmpPrefix = ".tmp-"

func (s *FS) path(key string) string { return filepath.Join(s.root, filepath.FromSlash(key)) }

// Create writes a temporary file, syncs it, hard-links it to the final name (which
// fails if the name exists) and syncs the directory (MUN-16, MUN-20).
func (s *FS) Create(_ context.Context, key string, data []byte, _ map[string]string) error {
	final := s.path(key)
	dir := filepath.Dir(final)
	if err := s.mkdirSynced(dir); err != nil {
		return err
	}
	tmp, err := writeTemp(dir, data)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	if err := os.Link(tmp, final); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return ErrExists
		}
		return err
	}
	return syncDir(dir)
}

// Put replaces key atomically (rename).
func (s *FS) Put(_ context.Context, key string, data []byte) error {
	final := s.path(key)
	dir := filepath.Dir(final)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := writeTemp(dir, data)
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, final); err != nil {
		os.Remove(tmp)
		return err
	}
	return syncDir(dir)
}

// mkdirSynced creates dir like MkdirAll and syncs every directory whose entry it
// added, so a new session's path survives a crash after the 2xx (MUN-16).
func (s *FS) mkdirSynced(dir string) error {
	if _, err := os.Stat(dir); err == nil {
		return nil
	}
	var created []string
	for d := dir; d != s.root && d != filepath.Dir(d); d = filepath.Dir(d) {
		if _, err := os.Stat(d); err == nil {
			break
		}
		created = append(created, d)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, d := range created {
		if err := syncDir(filepath.Dir(d)); err != nil {
			return err
		}
	}
	return nil
}

func writeTemp(dir string, data []byte) (string, error) {
	f, err := os.CreateTemp(dir, tmpPrefix+"*")
	if err != nil {
		return "", err
	}
	_, werr := f.Write(data)
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		os.Remove(f.Name())
		return "", werr
	}
	return f.Name(), nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s *FS) Get(_ context.Context, key string) ([]byte, error) {
	b, err := os.ReadFile(s.path(key))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return b, err
}

func (s *FS) GetRange(_ context.Context, key string, off, n int64) ([]byte, error) {
	f, err := os.Open(s.path(key))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.NewSectionReader(f, off, n))
	return b, err
}

func (s *FS) List(_ context.Context, prefix string) ([]Object, error) {
	// Walk the deepest directory the prefix names, then filter on the full prefix.
	start := s.root
	if i := strings.LastIndex(prefix, "/"); i >= 0 {
		start = s.path(prefix[:i])
	}
	var out []Object
	err := filepath.WalkDir(start, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), tmpPrefix) {
			return nil
		}
		rel, err := filepath.Rel(s.root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		out = append(out, Object{Key: key, Size: info.Size(), Modified: info.ModTime()})
		return nil
	})
	return out, err
}

func (s *FS) Delete(_ context.Context, key string) error {
	err := os.Remove(s.path(key))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (s *FS) Ping(context.Context) error {
	_, err := os.Stat(s.root)
	return err
}
