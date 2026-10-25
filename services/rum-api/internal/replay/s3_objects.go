package replay

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"strings"

	"github.com/minio/minio-go/v7"
)

// Objects is a plain key / value view of the bucket under [<prefix>/]<Dir>/,
// for data that lives next to the replays but is not a replay (source maps,
// ADR-0011). Its objects are never tagged, so the replay lifecycle rules
// never expire them; their own sweeper does.
type Objects struct {
	S3  *S3
	Dir string // e.g. "sourcemaps"
}

func (o Objects) key(k string) string { return o.S3.prefix + o.Dir + "/" + k }

// Put writes one object.
func (o Objects) Put(ctx context.Context, key string, data []byte) error {
	opts := minio.PutObjectOptions{ContentType: "application/octet-stream", DisableMultipart: len(data) < 64<<20}
	if _, err := o.S3.client.PutObject(ctx, o.S3.bucket, o.key(key), bytes.NewReader(data), int64(len(data)), opts); err != nil {
		return fmt.Errorf("s3 put %s: %w", key, err)
	}
	return nil
}

// Get reads one object; a missing key wraps fs.ErrNotExist.
func (o Objects) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := o.S3.client.GetObject(ctx, o.S3.bucket, o.key(key), minio.GetObjectOptions{})
	if err != nil {
		return nil, o.notFound(key, err)
	}
	defer obj.Close()
	b, err := io.ReadAll(obj)
	if err != nil {
		return nil, o.notFound(key, err)
	}
	return b, nil
}

func (o Objects) notFound(key string, err error) error {
	if isNoSuchKey(err) {
		return fmt.Errorf("s3 get %s: %w", key, fs.ErrNotExist)
	}
	return fmt.Errorf("s3 get %s: %w", key, err)
}

// ObjectInfo is one listed object (key relative to Dir).
type ObjectInfo struct {
	Key     string
	ModTime int64 // unix nanoseconds
}

// List returns every key under prefix, relative to Dir.
func (o Objects) List(ctx context.Context, prefix string) ([]ObjectInfo, error) {
	root := o.key("")
	var out []ObjectInfo
	for obj := range o.S3.client.ListObjects(ctx, o.S3.bucket, minio.ListObjectsOptions{Prefix: root + prefix, Recursive: true}) {
		if obj.Err != nil {
			return nil, obj.Err
		}
		out = append(out, ObjectInfo{Key: strings.TrimPrefix(obj.Key, root), ModTime: obj.LastModified.UnixNano()})
	}
	return out, nil
}

// Delete removes one object (no error when absent).
func (o Objects) Delete(ctx context.Context, key string) error {
	if err := o.S3.client.RemoveObject(ctx, o.S3.bucket, o.key(key), minio.RemoveObjectOptions{}); err != nil && !isNoSuchKey(err) {
		return fmt.Errorf("s3 delete %s: %w", key, err)
	}
	return nil
}
