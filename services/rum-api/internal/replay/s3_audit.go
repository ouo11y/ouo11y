package replay

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/minio/minio-go/v7"
)

// AuditObjects is the deletion audit log's view of the bucket: create-only
// objects under [<prefix>/]audit/ (internal/audit.Bucket). They are never
// tagged, so the replay lifecycle rules never expire them.
type AuditObjects struct{ S3 *S3 }

func (a AuditObjects) dir() string { return a.S3.prefix + "audit/" }

// PutNew writes name with If-None-Match: * (fails if it exists).
func (a AuditObjects) PutNew(ctx context.Context, name string, data []byte) error {
	opts := minio.PutObjectOptions{ContentType: "application/json", DisableMultipart: true}
	opts.SetMatchETagExcept("*")
	_, err := a.S3.client.PutObject(ctx, a.S3.bucket, a.dir()+name, bytes.NewReader(data), int64(len(data)), opts)
	if err != nil {
		return fmt.Errorf("s3 put audit %s: %w", name, err)
	}
	return nil
}

// Names lists the audit object names.
func (a AuditObjects) Names(ctx context.Context) ([]string, error) {
	var out []string
	for o := range a.S3.client.ListObjects(ctx, a.S3.bucket, minio.ListObjectsOptions{Prefix: a.dir(), Recursive: true}) {
		if o.Err != nil {
			return nil, o.Err
		}
		out = append(out, strings.TrimPrefix(o.Key, a.dir()))
	}
	return out, nil
}

// Get reads one audit object.
func (a AuditObjects) Get(ctx context.Context, name string) ([]byte, error) {
	obj, err := a.S3.client.GetObject(ctx, a.S3.bucket, a.dir()+name, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(obj)
}
