package store

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Config selects an S3-compatible bucket (AWS S3, MinIO, R2, ...).
type S3Config struct {
	Endpoint        string `yaml:"endpoint"` // host[:port], no scheme
	Bucket          string `yaml:"bucket"`
	Region          string `yaml:"region"`
	AccessKeyID     string `yaml:"access_key_id"`
	SecretAccessKey string `yaml:"secret_access_key"`
	Insecure        bool   `yaml:"insecure"` // plain HTTP (local MinIO)
}

// S3 stores objects in one bucket.
type S3 struct {
	c      *minio.Client
	bucket string
}

func NewS3(cfg S3Config) (*S3, error) {
	c, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
		Secure: !cfg.Insecure,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, err
	}
	return &S3{c: c, bucket: cfg.Bucket}, nil
}

// notFound is a missing key only: a missing bucket (NoSuchBucket, also a 404) is a
// configuration fault that must surface as 503, not as "no such replay".
func notFound(err error) bool {
	return minio.ToErrorResponse(err).Code == "NoSuchKey"
}

// Create uses a conditional PUT (If-None-Match: *); the store answers 412 when the
// key exists.
func (s *S3) Create(ctx context.Context, key string, data []byte, tags map[string]string) error {
	opts := minio.PutObjectOptions{ContentType: "application/octet-stream", UserTags: tags, DisableMultipart: true}
	opts.SetMatchETagExcept("*")
	_, err := s.c.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)), opts)
	if err != nil && minio.ToErrorResponse(err).StatusCode == http.StatusPreconditionFailed {
		return ErrExists
	}
	return err
}

func (s *S3) Put(ctx context.Context, key string, data []byte) error {
	_, err := s.c.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: "application/json", DisableMultipart: true})
	return err
}

func (s *S3) Get(ctx context.Context, key string) ([]byte, error) {
	return s.read(ctx, key, minio.GetObjectOptions{})
}

func (s *S3) GetRange(ctx context.Context, key string, off, n int64) ([]byte, error) {
	opts := minio.GetObjectOptions{}
	if err := opts.SetRange(off, off+n-1); err != nil {
		return nil, err
	}
	return s.read(ctx, key, opts)
}

func (s *S3) read(ctx context.Context, key string, opts minio.GetObjectOptions) ([]byte, error) {
	obj, err := s.c.GetObject(ctx, s.bucket, key, opts)
	if err != nil {
		if notFound(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	defer obj.Close()
	b, err := io.ReadAll(obj)
	if err != nil && notFound(err) {
		return nil, ErrNotFound
	}
	return b, err
}

func (s *S3) List(ctx context.Context, prefix string) ([]Object, error) {
	var out []Object
	for o := range s.c.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if o.Err != nil {
			return nil, o.Err
		}
		out = append(out, Object{Key: o.Key, Size: o.Size, Modified: o.LastModified})
	}
	return out, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	return s.c.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

func (s *S3) Ping(ctx context.Context) error {
	ok, err := s.c.BucketExists(ctx, s.bucket)
	if err == nil && !ok {
		err = fmt.Errorf("bucket %q does not exist", s.bucket)
	}
	return err
}
