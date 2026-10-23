package replay

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Options configures an S3 compatible bucket (AWS S3, MinIO, ...).
type S3Options struct {
	Endpoint string // host[:port]; empty means s3.<region>.amazonaws.com
	Bucket   string
	Region   string
	// Static credentials; all empty means the AWS environment variables,
	// shared credentials file and instance / pod role (IRSA) chain.
	AccessKeyID, SecretAccessKey, SessionToken string
	Insecure                                   bool // plain HTTP
	InsecureSkipVerify                         bool // TLS without certificate verification
	ForcePathStyle                             bool // bucket in the path (MinIO), not the host name
	Prefix                                     string
	// Transport overrides the HTTP transport (tests, tracing).
	Transport http.RoundTripper
}

// S3 is the object storage Store. Keys mirror the filesystem layout under an
// optional prefix: [<prefix>/]replays/<session_id>/<seq %06d>.json.gz,
// <seq %06d>.mp4 and meta.json, so `mc mirror <DATA_DIR>/replays
// <bucket>/[<prefix>/]replays` migrates a filesystem store.
//
// meta.json is the only object two uploads of one session both write. Puts
// of one session are serialised inside a process like FS, and meta.json is
// written with a conditional PUT (If-Match on the ETag read, If-None-Match: *
// for a new replay) and re-read on conflict, so several rum-api replicas on
// one bucket never lose a chunk from the meta.
type S3 struct {
	client *minio.Client
	bucket string
	prefix string // "" or "<prefix>/"
	// Now is injected for tests.
	Now func() time.Time
	// MaxVideoBytes limits one decoded video segment (MAX_VIDEO_CHUNK_BYTES);
	// 0 means DefaultMaxVideoBytes. Set it before the first Put.
	MaxVideoBytes int64
	// Retention returns a project's replay retention; every replay object is
	// tagged ouo-retention=RetentionTag(Retention(project)) for the bucket
	// lifecycle rules (ApplyLifecycleRules). Nil: no tag.
	Retention func(projectID string) time.Duration

	mu    sync.Mutex
	locks map[string]*sync.Mutex
	kinds map[string]string // session id -> kind, as FS.kinds
}

// metaRetries bounds the read-modify-write loop on meta.json conflicts.
const metaRetries = 8

// NewS3 connects to the bucket. It does not create it: buckets are
// provisioned by the deployment (compose minio-init, Terraform, ...).
func NewS3(ctx context.Context, o S3Options) (*S3, error) {
	if o.Bucket == "" {
		return nil, errors.New("s3: bucket is required")
	}
	endpoint := o.Endpoint
	if endpoint == "" {
		endpoint = "s3." + o.Region + ".amazonaws.com"
		if o.Region == "" {
			endpoint = "s3.amazonaws.com"
		}
	}
	var creds *credentials.Credentials
	if o.AccessKeyID != "" || o.SecretAccessKey != "" {
		creds = credentials.NewStaticV4(o.AccessKeyID, o.SecretAccessKey, o.SessionToken)
	} else {
		creds = credentials.NewChainCredentials([]credentials.Provider{
			&credentials.EnvAWS{}, &credentials.EnvMinio{}, &credentials.FileAWSCredentials{}, &credentials.IAM{},
		})
	}
	lookup := minio.BucketLookupAuto
	if o.ForcePathStyle {
		lookup = minio.BucketLookupPath
	}
	transport := o.Transport
	if transport == nil {
		t, err := minio.DefaultTransport(!o.Insecure)
		if err != nil {
			return nil, err
		}
		if o.InsecureSkipVerify {
			if t.TLSClientConfig == nil {
				t.TLSClientConfig = &tls.Config{}
			}
			t.TLSClientConfig.InsecureSkipVerify = true //nolint:gosec // operator opt-in (storage.s3.insecure_skip_verify)
		}
		transport = t
	}
	client, err := minio.New(endpoint, &minio.Options{
		Creds:        creds,
		Secure:       !o.Insecure,
		Region:       o.Region,
		BucketLookup: lookup,
		Transport:    transport,
	})
	if err != nil {
		return nil, fmt.Errorf("s3 client: %w", err)
	}
	prefix := ""
	if o.Prefix != "" {
		prefix = o.Prefix + "/"
	}
	s := &S3{client: client, bucket: o.Bucket, prefix: prefix, Now: time.Now,
		locks: map[string]*sync.Mutex{}, kinds: map[string]string{}}
	if err := s.Ready(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// Ready checks that the bucket exists and the credentials can see it (the
// /readyz storage check).
func (s *S3) Ready(ctx context.Context) error {
	ok, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return fmt.Errorf("s3 bucket %s: %w", s.bucket, err)
	}
	if !ok {
		return fmt.Errorf("s3 bucket %s does not exist", s.bucket)
	}
	return nil
}

func (s *S3) lock(sessionID string) func() {
	s.mu.Lock()
	m, ok := s.locks[sessionID]
	if !ok {
		m = &sync.Mutex{}
		s.locks[sessionID] = m
	}
	s.mu.Unlock()
	m.Lock()
	return m.Unlock
}

func (s *S3) dir(sessionID string) string { return s.prefix + "replays/" + sessionID + "/" }

func (s *S3) key(sessionID, name string) string { return s.dir(sessionID) + name }

func isNoSuchKey(err error) bool {
	r := minio.ToErrorResponse(err)
	return r.Code == minio.NoSuchKey || r.StatusCode == http.StatusNotFound
}

// isConflict: a conditional PUT lost against another writer. S3 answers 412
// for a failed precondition and 409 when two conditional writes race.
func isConflict(err error) bool {
	r := minio.ToErrorResponse(err)
	return r.StatusCode == http.StatusPreconditionFailed || r.StatusCode == http.StatusConflict
}

func (s *S3) put(ctx context.Context, key string, data []byte, contentType string, tags map[string]string) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: contentType, DisableMultipart: true, UserTags: tags})
	return err
}

// retentionTags are the object tags of a replay object of projectID.
func (s *S3) retentionTags(projectID string) map[string]string {
	if s.Retention == nil {
		return nil
	}
	return map[string]string{RetentionTagKey: RetentionTag(s.Retention(projectID))}
}

// Put implements Store. Chunk objects are written before meta.json (a meta
// entry always has its objects); a re-posted seq overwrites them and
// replaces its meta entry.
func (s *S3) Put(ctx context.Context, projectID string, body []byte, gzipBody []byte) (Chunk, error) {
	c, data, err := prepareChunk(body, gzipBody, s.MaxVideoBytes)
	if err != nil {
		return c, err
	}

	unlock := s.lock(c.SessionID)
	defer unlock()

	written := false
	for range metaRetries {
		meta, etag, err := s.readMeta(ctx, c.SessionID)
		exists := err == nil
		if err != nil && !errors.Is(err, ErrNotFound) {
			return c, err
		}
		if err := checkMeta(meta, exists, c, projectID); err != nil {
			if written {
				// Another replica turned the session into another kind or
				// project between our writes: drop what we wrote.
				s.removeChunk(c)
			}
			return c, err
		}
		if !written {
			if c.Kind == KindVideo {
				if err := s.put(ctx, s.key(c.SessionID, videoName(c.Seq)), c.mp4, "video/mp4", s.retentionTags(projectID)); err != nil {
					return c, fmt.Errorf("s3 put video: %w", err)
				}
			}
			if err := s.put(ctx, s.key(c.SessionID, chunkName(c.Seq)), data, "application/gzip", s.retentionTags(projectID)); err != nil {
				return c, fmt.Errorf("s3 put chunk: %w", err)
			}
			written = true
		}
		applyChunk(&meta, c, projectID, int64(len(data)), s.Now())
		err = s.writeMeta(ctx, meta, etag, exists)
		if isConflict(err) {
			continue
		}
		if err != nil {
			return c, fmt.Errorf("s3 put meta: %w", err)
		}
		s.mu.Lock()
		s.kinds[c.SessionID] = c.Kind
		s.mu.Unlock()
		return c, nil
	}
	return c, fmt.Errorf("s3 put meta: %d conflicting writers for session %s", metaRetries, c.SessionID)
}

func (s *S3) removeChunk(c Chunk) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = s.client.RemoveObject(ctx, s.bucket, s.key(c.SessionID, chunkName(c.Seq)), minio.RemoveObjectOptions{})
	if c.Kind == KindVideo {
		_ = s.client.RemoveObject(ctx, s.bucket, s.key(c.SessionID, videoName(c.Seq)), minio.RemoveObjectOptions{})
	}
}

// readMeta returns the meta and its ETag, or ErrNotFound.
func (s *S3) readMeta(ctx context.Context, sessionID string) (Meta, string, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, s.key(sessionID, metaName), minio.GetObjectOptions{})
	if err != nil {
		return Meta{}, "", err
	}
	defer obj.Close()
	b, err := io.ReadAll(obj)
	if err != nil {
		if isNoSuchKey(err) {
			return Meta{}, "", ErrNotFound
		}
		return Meta{}, "", err
	}
	info, err := obj.Stat()
	if err != nil {
		return Meta{}, "", err
	}
	m, err := decodeMeta(sessionID, b)
	return m, info.ETag, err
}

func (s *S3) writeMeta(ctx context.Context, m Meta, etag string, exists bool) error {
	b, err := encodeMeta(m)
	if err != nil {
		return err
	}
	opts := minio.PutObjectOptions{ContentType: "application/json", DisableMultipart: true, UserTags: s.retentionTags(m.ProjectID)}
	if exists {
		opts.SetMatchETag(etag)
	} else {
		opts.SetMatchETagExcept("*") // create only
	}
	_, err = s.client.PutObject(ctx, s.bucket, s.key(m.SessionID, metaName), bytes.NewReader(b), int64(len(b)), opts)
	return err
}

// Meta implements Store.
func (s *S3) Meta(ctx context.Context, sessionID string) (Meta, error) {
	if !ValidSessionID(sessionID) {
		return Meta{}, ErrNotFound
	}
	m, _, err := s.readMeta(ctx, sessionID)
	return m, err
}

// Has implements Store (a HEAD of meta.json).
func (s *S3) Has(ctx context.Context, sessionID string) bool {
	if !ValidSessionID(sessionID) {
		return false
	}
	_, err := s.client.StatObject(ctx, s.bucket, s.key(sessionID, metaName), minio.StatObjectOptions{})
	return err == nil
}

// Kind implements Store: a HEAD of meta.json plus a cached kind.
func (s *S3) Kind(ctx context.Context, sessionID string) (string, error) {
	if !s.Has(ctx, sessionID) {
		return "", ErrNotFound
	}
	s.mu.Lock()
	k, ok := s.kinds[sessionID]
	s.mu.Unlock()
	if ok {
		return k, nil
	}
	m, err := s.Meta(ctx, sessionID)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	s.kinds[sessionID] = m.Kind
	s.mu.Unlock()
	return m.Kind, nil
}

type s3GzReadCloser struct {
	*gzip.Reader
	obj *minio.Object
}

func (g s3GzReadCloser) Close() error {
	g.Reader.Close()
	return g.obj.Close()
}

// OpenChunk implements Store.
func (s *S3) OpenChunk(ctx context.Context, sessionID string, seq int) (io.ReadCloser, error) {
	if !ValidSessionID(sessionID) || seq < 0 {
		return nil, ErrNotFound
	}
	obj, err := s.client.GetObject(ctx, s.bucket, s.key(sessionID, chunkName(seq)), minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// GetObject is lazy: the gzip header read is the first request.
	gr, err := gzip.NewReader(obj)
	if err != nil {
		obj.Close()
		if isNoSuchKey(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("chunk %s/%d: %w", sessionID, seq, err)
	}
	return s3GzReadCloser{Reader: gr, obj: obj}, nil
}

// OpenVideo implements Store. The returned content is a *minio.Object: each
// Seek + Read after the first is a ranged GET, so http.ServeContent answers a
// Range request with only the asked bytes from the bucket.
func (s *S3) OpenVideo(ctx context.Context, sessionID string, seq int) (VideoFile, error) {
	if !ValidSessionID(sessionID) || seq < 0 {
		return VideoFile{}, ErrNotFound
	}
	key := s.key(sessionID, videoName(seq))
	// HEAD first: size, mtime and ETag without starting a full download.
	info, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		if isNoSuchKey(err) {
			return VideoFile{}, ErrNotFound
		}
		return VideoFile{}, err
	}
	// Pin the version we stat'ed: a replace in between fails the read
	// instead of mixing two segments.
	var opts minio.GetObjectOptions
	if err := opts.SetMatchETag(info.ETag); err != nil {
		return VideoFile{}, err
	}
	obj, err := s.client.GetObject(ctx, s.bucket, key, opts)
	if err != nil {
		return VideoFile{}, err
	}
	return VideoFile{Content: obj, Size: info.Size, ModTime: info.LastModified, ETag: info.ETag}, nil
}

// Delete implements Store: every object under the session's prefix.
func (s *S3) Delete(ctx context.Context, sessionID string) error {
	if !ValidSessionID(sessionID) {
		return nil
	}
	unlock := s.lock(sessionID)
	defer unlock()
	s.mu.Lock()
	delete(s.kinds, sessionID)
	s.mu.Unlock()
	// meta.json first: without it the session is absent for readers, so a
	// half-done delete never shows a meta whose chunks are gone.
	if err := s.client.RemoveObject(ctx, s.bucket, s.key(sessionID, metaName), minio.RemoveObjectOptions{}); err != nil && !isNoSuchKey(err) {
		return err
	}
	var keys []string
	for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: s.dir(sessionID), Recursive: true}) {
		if o.Err != nil {
			return o.Err
		}
		keys = append(keys, o.Key)
	}
	ch := make(chan minio.ObjectInfo, len(keys))
	for _, k := range keys {
		ch <- minio.ObjectInfo{Key: k}
	}
	close(ch)
	for e := range s.client.RemoveObjects(ctx, s.bucket, ch, minio.RemoveObjectsOptions{}) {
		if e.Err != nil && !isNoSuchKey(e.Err) {
			return e.Err
		}
	}
	return nil
}
