package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func envMap(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func writeFile(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDefaultsWithoutFile(t *testing.T) {
	c, err := Load("", false, envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c, Defaults()) {
		t.Fatalf("got %+v\nwant %+v", c, Defaults())
	}
	if c.Storage.Backend != BackendFilesystem || c.Storage.Filesystem.Dir != "/data" || c.Server.HTTPListenAddress != ":8080" {
		t.Fatalf("defaults: %+v", c)
	}
}

func TestExampleFileIsValid(t *testing.T) {
	// The shipped example must load as is (with the secrets it references).
	c, err := Load("../../config.example.yaml", true, envMap(map[string]string{
		"OUO_INGEST_TOKEN": "it", "OUO_READ_TOKEN": "rt",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Auth.IngestToken != "it" || c.Auth.ReadToken != "rt" {
		t.Fatalf("tokens: %+v", c.Auth)
	}
}

func TestFileExpandAndOverride(t *testing.T) {
	p := writeFile(t, `
server:
  http_listen_address: ":9090"
  cors_allowed_origins: ["http://a.test/", " http://b.test "]
auth:
  ingest_token: ${INGEST}
  read_token: ${READ:-rt_default}
loki:
  url: http://loki.internal:3100
  datasource_uid: my-loki
tempo:
  url: http://tempo.internal:3200
  concurrency: 4
  cache_ttl: 2m
session:
  inactivity: 15m
limits:
  max_chunk_bytes: 1000
  max_video_chunk_bytes: 10
storage:
  backend: S3
  s3:
    endpoint: minio:9000
    bucket: ouo-replays
    access_key_id: ${S3_KEY}
    secret_access_key: "${S3_SECRET}"
    insecure: true
    force_path_style: true
    prefix: /tenant-a/
`)
	env := map[string]string{"INGEST": "it_file", "S3_KEY": "minioadmin", "S3_SECRET": "pa$$w${rd}"}
	c, err := Load(p, true, envMap(env))
	if err != nil {
		t.Fatal(err)
	}
	if c.Server.HTTPListenAddress != ":9090" || !reflect.DeepEqual(c.Server.CORSAllowedOrigins, []string{"http://a.test", "http://b.test"}) {
		t.Fatalf("server: %+v", c.Server)
	}
	if c.Auth.IngestToken != "it_file" || c.Auth.ReadToken != "rt_default" {
		t.Fatalf("auth: %+v", c.Auth)
	}
	if c.Loki.DatasourceUID != "my-loki" || c.Tempo.DatasourceUID != "tempo" || c.Tempo.Concurrency != 4 || c.Tempo.CacheTTL != 2*time.Minute {
		t.Fatalf("backends: %+v %+v", c.Loki, c.Tempo)
	}
	if c.Session.Inactivity != 15*time.Minute || c.Session.MaxDuration != 4*time.Hour {
		t.Fatalf("session: %+v", c.Session)
	}
	// Frames and video limits never below the rrweb limit.
	if c.Limits.MaxChunkBytes != 1000 || c.Limits.MaxVideoChunkBytes != 1000 || c.Limits.MaxFrameChunkBytes != 8<<20 {
		t.Fatalf("limits: %+v", c.Limits)
	}
	s3 := c.Storage.S3
	if c.Storage.Backend != BackendS3 || s3.Bucket != "ouo-replays" || s3.AccessKeyID != "minioadmin" ||
		s3.SecretAccessKey != "pa$$w${rd}" || !s3.Insecure || !s3.ForcePathStyle || s3.Prefix != "tenant-a" || s3.Region != "us-east-1" {
		t.Fatalf("s3: %+v", s3)
	}

	// Environment variables override the file.
	env["RUM_API_ADDR"] = ":7070"
	env["OUO_READ_TOKEN"] = "rt_env"
	env["S3_BUCKET"] = "other"
	env["S3_INSECURE"] = "false"
	env["SESSION_INACTIVITY"] = "5m"
	env["CORS_ALLOWED_ORIGINS"] = "http://c.test"
	env["MAX_VIDEO_CHUNK_BYTES"] = "5000"
	env["LOKI_URL"] = "" // empty means unset, as before
	c, err = Load(p, true, envMap(env))
	if err != nil {
		t.Fatal(err)
	}
	if c.Server.HTTPListenAddress != ":7070" || c.Auth.ReadToken != "rt_env" || c.Storage.S3.Bucket != "other" ||
		c.Storage.S3.Insecure || c.Session.Inactivity != 5*time.Minute || c.Loki.URL != "http://loki.internal:3100" ||
		!reflect.DeepEqual(c.Server.CORSAllowedOrigins, []string{"http://c.test"}) || c.Limits.MaxVideoChunkBytes != 5000 {
		t.Fatalf("env override: %+v", c)
	}
}

func TestExpandEnvOff(t *testing.T) {
	// Without -config.expand-env, ${VAR} is literal text.
	p := writeFile(t, "auth:\n  read_token: ${READ}\n")
	c, err := Load(p, false, envMap(map[string]string{"READ": "x"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Auth.ReadToken != "${READ}" {
		t.Fatalf("read token: %q", c.Auth.ReadToken)
	}
}

func TestExpandEnv(t *testing.T) {
	env := envMap(map[string]string{"A": "1", "EMPTY": ""})
	for in, want := range map[string]string{
		"${A}":              "1",
		"x${A}y":            "x1y",
		"${MISSING}":        "",
		"${MISSING:-d}":     "d",
		"${EMPTY:-d}":       "d",
		"${A:-d}":           "1",
		"$A and $":          "$A and $",
		"$${A}":             "${A}",
		"${MISSING:-a b:c}": "a b:c",
	} {
		if got := string(ExpandEnv([]byte(in), env)); got != want {
			t.Errorf("ExpandEnv(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEmptyFile(t *testing.T) {
	c, err := Load(writeFile(t, "# nothing\n"), true, envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c, Defaults()) {
		t.Fatalf("empty file changed defaults: %+v", c)
	}
}

func TestInvalid(t *testing.T) {
	cases := map[string]struct {
		file string
		env  map[string]string
		want string
	}{
		"unknown key":      {file: "storage:\n  backnd: s3\n", want: "backnd"},
		"bad duration":     {file: "session:\n  inactivity: soon\n", want: "soon"},
		"bad backend":      {file: "storage:\n  backend: gcs\n", want: `storage.backend "gcs"`},
		"s3 no bucket":     {file: "storage:\n  backend: s3\n", want: "storage.s3.bucket is required"},
		"s3 scheme":        {file: "storage:\n  backend: s3\n  s3: {bucket: b, endpoint: 'http://minio:9000'}\n", want: "without scheme"},
		"s3 half creds":    {file: "storage:\n  backend: s3\n  s3: {bucket: b, access_key_id: k}\n", want: "set together"},
		"bad url":          {file: "loki:\n  url: loki:3100\n", want: "loki.url"},
		"bad env int":      {env: map[string]string{"MAX_CHUNK_BYTES": "4MiB"}, want: "MAX_CHUNK_BYTES"},
		"bad env bool":     {env: map[string]string{"S3_INSECURE": "maybe"}, want: "S3_INSECURE"},
		"env backend":      {env: map[string]string{"STORAGE_BACKEND": "s3"}, want: "bucket is required"},
		"zero concurrency": {file: "tempo:\n  concurrency: 0\n", want: "tempo.concurrency"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			p := ""
			if tc.file != "" {
				p = writeFile(t, tc.file)
			}
			_, err := Load(p, true, envMap(tc.env))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %v, want it to mention %q", err, tc.want)
			}
		})
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing.yaml"), false, envMap(nil)); err == nil {
		t.Fatal("missing file must fail")
	}
}

func TestRedactedYAML(t *testing.T) {
	c := Defaults()
	c.Auth.IngestToken, c.Auth.ReadToken = "it_secret", "rt_secret"
	c.Storage.S3.AccessKeyID, c.Storage.S3.SecretAccessKey = "AKIA", "s3_secret"
	out, err := c.Redacted().YAML()
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"it_secret", "rt_secret", "s3_secret"} {
		if strings.Contains(string(out), s) {
			t.Fatalf("secret %s in %s", s, out)
		}
	}
	if !strings.Contains(string(out), "inactivity: 30m0s") || !strings.Contains(string(out), "access_key_id: AKIA") {
		t.Fatalf("yaml: %s", out)
	}
	// The rendered YAML loads back to the same config.
	p := writeFile(t, string(out))
	back, err := Load(p, false, envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	if back.Session != c.Session || back.Storage.S3.AccessKeyID != "AKIA" {
		t.Fatalf("round trip: %+v", back)
	}
}

func TestRetentionProjectsAndAdmin(t *testing.T) {
	p := writeFile(t, `
auth:
  admin_token: ${ADMIN}
retention:
  replays: 168h
  sweep_interval: 10m
projects:
  ttltest:
    retention: { replays: 1m }
    sampling: { session_rate: 0.5, replay_rate: 0.1, replay_on_error_rate: 0.7 }
  demo: {}
`)
	c, err := Load(p, true, envMap(map[string]string{"ADMIN": "at", "LOG_RETENTION": "336h", "LOKI_DELETE_API": "false"}))
	if err != nil {
		t.Fatal(err)
	}
	tt := c.Projects["ttltest"]
	if c.Auth.AdminToken != "at" || c.Retention.Replays != 168*time.Hour || c.Retention.Logs != 336*time.Hour ||
		c.Retention.SweepInterval != 10*time.Minute || c.Retention.OrphanGrace != time.Hour || c.Loki.DeleteAPI ||
		tt.Retention.Replays != time.Minute || *tt.Sampling.SessionRate != 0.5 || *tt.Sampling.ReplayRate != 0.1 || *tt.Sampling.ReplayOnErrorRate != 0.7 ||
		c.Projects["demo"].Sampling.ReplayRate != nil {
		t.Fatalf("%+v", c)
	}
	if r := c.Redacted(); r.Auth.AdminToken != "<redacted>" {
		t.Fatal("admin token not redacted")
	}

	bad := writeFile(t, `
retention: { replays: -1h }
projects:
  "Bad Id": {}
  ok:
    sampling: { replay_rate: 1.5 }
`)
	_, err = Load(bad, false, envMap(nil))
	for _, want := range []string{"retention.replays", `"Bad Id"`, "projects.ok.sampling.replay_rate"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("error %v does not mention %s", err, want)
		}
	}
}

func TestSourceMapSettings(t *testing.T) {
	c, err := Load("", false, envMap(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.Retention.SourceMaps != 2160*time.Hour || c.Limits.MaxSourceMapBytes != 64<<20 || c.Limits.MaxDSYMBytes != 512<<20 || c.SourceMaps.CacheEntries != 128 || c.SourceMaps.CacheBytes != 512<<20 ||
		c.SourceMaps.CacheTTL != 10*time.Minute || len(c.Warnings()) != 0 {
		t.Fatalf("defaults: %+v %+v warnings %v", c.Retention, c.SourceMaps, c.Warnings())
	}
	p := writeFile(t, `
projects:
  shop:
    upload_token: ut_file_0000000000000000
    retention: { sourcemaps: 24h }
`)
	c, err = Load(p, false, envMap(map[string]string{
		"OUO_UPLOAD_TOKENS":   "web-store:ut_env_web_00000000000000, shop:ut_env_shop_0000000000000",
		"SOURCEMAP_RETENTION": "4320h", "SOURCEMAP_CACHE_ENTRIES": "16", "MAX_SOURCEMAP_BYTES": "1024", "MAX_DSYM_BYTES": "2048", "SOURCEMAP_CACHE_BYTES": "4096",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Projects["shop"].UploadToken != "ut_env_shop_0000000000000" || c.Projects["web-store"].UploadToken != "ut_env_web_00000000000000" ||
		c.Projects["shop"].Retention.SourceMaps != 24*time.Hour || c.Retention.SourceMaps != 4320*time.Hour ||
		c.SourceMaps.CacheEntries != 16 || c.Limits.MaxSourceMapBytes != 1024 || c.Limits.MaxDSYMBytes != 2048 || c.SourceMaps.CacheBytes != 4096 {
		t.Fatalf("%+v", c)
	}
	if w := c.Warnings(); len(w) != 1 || !strings.Contains(w[0], "projects.shop.retention.sourcemaps") {
		t.Errorf("warnings = %v", w)
	}
	if r := c.Redacted(); r.Projects["shop"].UploadToken != "<redacted>" || c.Projects["shop"].UploadToken == "<redacted>" {
		t.Error("upload token not redacted in the copy only")
	}
	for env, want := range map[string]string{"OUO_UPLOAD_TOKENS": "not <project>:<token>", "SOURCEMAP_CACHE_ENTRIES": "SOURCEMAP_CACHE_ENTRIES"} {
		val := map[string]string{"OUO_UPLOAD_TOKENS": "nocolon", "SOURCEMAP_CACHE_ENTRIES": "x"}[env]
		if _, err := Load("", false, envMap(map[string]string{env: val})); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s=%s: %v", env, val, err)
		}
	}
	if _, err := Load("", false, envMap(map[string]string{"OUO_UPLOAD_TOKENS": "shop:short"})); err == nil || !strings.Contains(err.Error(), "at least 16") {
		t.Errorf("short token: %v", err)
	}
}
