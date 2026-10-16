package replay

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// The S3 store is tested against a real MinIO, never a fake:
//
//   - OUO_TEST_S3_ENDPOINT=host:port (plus OUO_TEST_S3_ACCESS_KEY /
//     OUO_TEST_S3_SECRET_KEY, default minioadmin) uses a running one, e.g.
//     the compose MinIO (deploy/README.md);
//   - otherwise the tests start a throwaway container with `docker run`
//     (image OUO_TEST_MINIO_IMAGE, default testMinioImage) and remove it.
//
// Without either the tests skip on a laptop but FAIL when CI is set, so CI
// can never pass by silently skipping them.
const testMinioImage = "pgsty/minio:RELEASE.2026-08-04T00-00-00Z"

var minioEnv struct {
	once               sync.Once
	endpoint, ak, sk   string
	container, skipWhy string
	err                error
}

func TestMain(m *testing.M) {
	code := m.Run()
	if minioEnv.container != "" {
		_ = exec.Command("docker", "rm", "-f", minioEnv.container).Run()
	}
	os.Exit(code)
}

func setupMinio() {
	e := &minioEnv
	if ep := os.Getenv("OUO_TEST_S3_ENDPOINT"); ep != "" {
		e.endpoint = ep
		e.ak, e.sk = envOr("OUO_TEST_S3_ACCESS_KEY", "minioadmin"), envOr("OUO_TEST_S3_SECRET_KEY", "minioadmin")
		e.err = waitMinio(e.endpoint, 20*time.Second)
		return
	}
	if _, err := exec.LookPath("docker"); err != nil {
		e.skipWhy = "no OUO_TEST_S3_ENDPOINT and no docker binary"
		return
	}
	if err := exec.Command("docker", "info").Run(); err != nil {
		e.skipWhy = "no OUO_TEST_S3_ENDPOINT and the docker daemon is not reachable"
		return
	}
	e.ak, e.sk = "minioadmin", "minioadmin"
	image := envOr("OUO_TEST_MINIO_IMAGE", testMinioImage)
	// Pull first: on a fresh runner `docker run` would print the pull
	// progress, and only stdout may be read as the container id.
	if out, err := exec.Command("docker", "pull", "-q", image).CombinedOutput(); err != nil {
		e.err = fmt.Errorf("docker pull %s: %v: %s", image, err, out)
		return
	}
	// No --rm: when MinIO exits at once, its state and logs are what the
	// failure must show (TestMain removes the container).
	cmd := exec.Command("docker", "run", "-d", "-p", "127.0.0.1::9000",
		"-e", "MINIO_ROOT_USER="+e.ak, "-e", "MINIO_ROOT_PASSWORD="+e.sk, image, "server", "/data")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		e.err = fmt.Errorf("docker run minio: %v: %s", err, stderr.String())
		return
	}
	e.container = strings.TrimSpace(string(out))
	deadline := time.Now().Add(20 * time.Second)
	for {
		port, err := exec.Command("docker", "port", e.container, "9000/tcp").CombinedOutput()
		if err == nil {
			// "127.0.0.1:55012" (first line; IPv6 lines may follow)
			e.endpoint = strings.TrimSpace(strings.SplitN(string(port), "\n", 2)[0])
			break
		}
		if time.Now().After(deadline) {
			e.err = fmt.Errorf("docker port: %v: %s%s", err, port, containerDiag(e.container))
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	if e.err = waitMinio(e.endpoint, 60*time.Second); e.err != nil {
		e.err = fmt.Errorf("%w%s", e.err, containerDiag(e.container))
	}
}

// containerDiag is the container's state and last log lines, for failures.
func containerDiag(id string) string {
	state, _ := exec.Command("docker", "inspect", "-f",
		"status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}} platform={{.Platform}} image={{.Config.Image}}", id).CombinedOutput()
	logs, _ := exec.Command("docker", "logs", "--tail", "40", id).CombinedOutput()
	return fmt.Sprintf("\ncontainer %s\n%s\nlogs:\n%s", id, strings.TrimSpace(string(state)), logs)
}

func waitMinio(endpoint string, d time.Duration) error {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		resp, err := http.Get("http://" + endpoint + "/minio/health/ready")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("minio at %s not ready after %s", endpoint, d)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// testBucket returns a MinIO admin client and a fresh bucket for t.
func testBucket(t *testing.T) (*minio.Client, string) {
	t.Helper()
	minioEnv.once.Do(setupMinio)
	if minioEnv.skipWhy != "" {
		if os.Getenv("CI") != "" {
			t.Fatalf("S3 store tests need MinIO on CI: %s", minioEnv.skipWhy)
		}
		t.Skip(minioEnv.skipWhy)
	}
	if minioEnv.err != nil {
		t.Fatal(minioEnv.err)
	}
	c, err := minio.New(minioEnv.endpoint, &minio.Options{Creds: credentials.NewStaticV4(minioEnv.ak, minioEnv.sk, "")})
	if err != nil {
		t.Fatal(err)
	}
	bucket := fmt.Sprintf("rum-api-test-%d", time.Now().UnixNano())
	if err := c.MakeBucket(context.Background(), bucket, minio.MakeBucketOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		for o := range c.ListObjects(ctx, bucket, minio.ListObjectsOptions{Recursive: true}) {
			_ = c.RemoveObject(ctx, bucket, o.Key, minio.RemoveObjectOptions{})
		}
		_ = c.RemoveBucket(ctx, bucket)
	})
	return c, bucket
}

func openS3(t *testing.T, bucket, prefix string) *S3 {
	t.Helper()
	st, err := NewS3(context.Background(), S3Options{
		Endpoint: minioEnv.endpoint, Bucket: bucket, Region: "us-east-1",
		AccessKeyID: minioEnv.ak, SecretAccessKey: minioEnv.sk,
		Insecure: true, ForcePathStyle: true, Prefix: prefix,
	})
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestS3Contract(t *testing.T) {
	testStoreContract(t, func(t *testing.T, maxVideo int64) Store {
		_, bucket := testBucket(t)
		st := openS3(t, bucket, "tenant-a")
		st.MaxVideoBytes = maxVideo
		return st
	})
}

func TestS3Layout(t *testing.T) {
	admin, bucket := testBucket(t)
	st := openS3(t, bucket, "env/prod")
	ctx := context.Background()
	id := "layout-1"
	plain := chunkJSON(id, 0, 1000, map[string]any{"type": 4, "timestamp": 1000})
	if _, err := st.Put(ctx, "demo", plain, gz(plain)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Put(ctx, "demo", mustJSON(t, videoChunk("layout-2", 0, 1000, tinyMP4(500, 'a'), nil)), nil); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"env/prod/replays/layout-1/000000.json.gz": "application/gzip",
		"env/prod/replays/layout-1/meta.json":      "application/json",
		"env/prod/replays/layout-2/000000.json.gz": "application/gzip",
		"env/prod/replays/layout-2/000000.mp4":     "video/mp4",
		"env/prod/replays/layout-2/meta.json":      "application/json",
	}
	got := map[string]string{}
	for o := range admin.ListObjects(ctx, bucket, minio.ListObjectsOptions{Recursive: true, WithMetadata: true}) {
		if o.Err != nil {
			t.Fatal(o.Err)
		}
		info, err := admin.StatObject(ctx, bucket, o.Key, minio.StatObjectOptions{})
		if err != nil {
			t.Fatal(err)
		}
		got[o.Key] = info.ContentType
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("objects:\n got %v\nwant %v", got, want)
	}
	// The gzip upload is stored byte for byte.
	obj, _ := admin.GetObject(ctx, bucket, "env/prod/replays/layout-1/000000.json.gz", minio.GetObjectOptions{})
	var buf bytes.Buffer
	buf.ReadFrom(obj)
	if !bytes.Equal(buf.Bytes(), gz(plain)) {
		t.Fatal("gzip body not stored as is")
	}
}

// TestS3Replicas: two stores (two rum-api replicas) on one bucket write
// chunks of the same session at once; the conditional meta.json write keeps
// every chunk.
func TestS3Replicas(t *testing.T) {
	_, bucket := testBucket(t)
	a, b := openS3(t, bucket, ""), openS3(t, bucket, "")
	ctx := context.Background()
	id := "replicas-1"
	var wg sync.WaitGroup
	for i := range 30 {
		st := a
		if i%2 == 1 {
			st = b
		}
		wg.Go(func() {
			if _, err := st.Put(ctx, "demo", chunkJSON(id, i, int64(i*1000), map[string]any{"type": 3, "n": i}), nil); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	for _, st := range []*S3{a, b} {
		m, err := st.Meta(ctx, id)
		if err != nil || m.ChunkCount != 30 || m.LastSeq != 29 {
			t.Fatalf("meta after concurrent replicas: chunks %d %v", m.ChunkCount, err)
		}
	}
	// A replica sees the other's delete.
	if err := a.Delete(ctx, id); err != nil {
		t.Fatal(err)
	}
	if b.Has(ctx, id) {
		t.Fatal("replica b still sees the replay")
	}
}

func TestS3Errors(t *testing.T) {
	_, bucket := testBucket(t)
	ctx := context.Background()
	if _, err := NewS3(ctx, S3Options{Endpoint: minioEnv.endpoint, Bucket: bucket + "-missing", AccessKeyID: minioEnv.ak,
		SecretAccessKey: minioEnv.sk, Insecure: true, ForcePathStyle: true}); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing bucket: %v", err)
	}
	if _, err := NewS3(ctx, S3Options{Endpoint: minioEnv.endpoint, Bucket: bucket, AccessKeyID: minioEnv.ak,
		SecretAccessKey: "wrong-secret", Insecure: true, ForcePathStyle: true}); err == nil {
		t.Fatal("wrong secret accepted")
	}
	// Unreachable endpoint fails fast with the context.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	dead := l.Addr().String()
	l.Close()
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if _, err := NewS3(cctx, S3Options{Endpoint: dead, Bucket: bucket, AccessKeyID: "a", SecretAccessKey: "b", Insecure: true}); err == nil {
		t.Fatal("dead endpoint accepted")
	}
}

// TestS3ServeContentRange: an S3 VideoFile behind http.ServeContent answers
// Range requests with 206 and exactly the asked bytes (the plugin's <video>
// seeks this way).
func TestS3ServeContentRange(t *testing.T) {
	_, bucket := testBucket(t)
	st := openS3(t, bucket, "")
	ctx := context.Background()
	mp4 := tinyMP4(5000, 'r')
	if _, err := st.Put(ctx, "demo", mustJSON(t, videoChunk("range-1", 0, 1000, mp4, nil)), nil); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		rng    string
		status int
		body   []byte
	}{
		{"", http.StatusOK, mp4},
		{"bytes=0-1", http.StatusPartialContent, mp4[:2]},
		{"bytes=4000-", http.StatusPartialContent, mp4[4000:]},
		{"bytes=-10", http.StatusPartialContent, mp4[4990:]},
		{"bytes=6000-", http.StatusRequestedRangeNotSatisfiable, nil},
	} {
		v, err := st.OpenVideo(ctx, "range-1", 0)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodGet, "/x.mp4", nil)
		if tc.rng != "" {
			req.Header.Set("Range", tc.rng)
		}
		rec := httptest.NewRecorder()
		http.ServeContent(rec, req, "000000.mp4", v.ModTime, v.Content)
		v.Content.Close()
		if rec.Code != tc.status {
			t.Fatalf("%q: status %d", tc.rng, rec.Code)
		}
		if tc.body != nil && !bytes.Equal(rec.Body.Bytes(), tc.body) {
			t.Fatalf("%q: %d bytes, want %d", tc.rng, rec.Body.Len(), len(tc.body))
		}
	}
}
