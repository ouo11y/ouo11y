package replay

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
)

// SessionEntry is one session found by Lister.Sessions. Meta is nil when the
// session has objects but no readable meta.json (an upload or a delete that
// stopped half way); LastModified is then the newest object's time, else
// the meta's UpdatedAt.
type SessionEntry struct {
	ID           string
	Meta         *Meta
	LastModified time.Time
}

// Lister walks every session of a store (the retention sweeper and
// delete-by-project). Both FS and S3 implement it.
type Lister interface {
	Sessions(ctx context.Context, fn func(SessionEntry) error) error
}

// Sessions implements Lister: one directory per session under Root.
func (s *FS) Sessions(ctx context.Context, fn func(SessionEntry) error) error {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !e.IsDir() || !ValidSessionID(e.Name()) {
			continue // schema.json, temp files
		}
		entry := SessionEntry{ID: e.Name()}
		m, err := s.readMeta(e.Name())
		switch {
		case err == nil:
			entry.Meta, entry.LastModified = &m, m.UpdatedAt
		case errors.Is(err, ErrNotFound) || strings.Contains(err.Error(), "corrupt meta.json"):
			entry.LastModified = newestFile(filepath.Join(s.Root, e.Name()))
		default:
			return err
		}
		if err := fn(entry); err != nil {
			return err
		}
	}
	return nil
}

// newestFile is the latest modification time of the files in dir (zero when
// it is empty or unreadable).
func newestFile(dir string) time.Time {
	var newest time.Time
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if fi, err := d.Info(); err == nil && fi.ModTime().After(newest) {
			newest = fi.ModTime()
		}
		return nil
	})
	return newest
}

// Sessions implements Lister: one key prefix per session under replays/.
func (s *S3) Sessions(ctx context.Context, fn func(SessionEntry) error) error {
	root := s.prefix + "replays/"
	for o := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: root}) {
		if o.Err != nil {
			return o.Err
		}
		id, ok := strings.CutSuffix(strings.TrimPrefix(o.Key, root), "/")
		if !ok || !ValidSessionID(id) {
			continue // schema.json
		}
		entry := SessionEntry{ID: id}
		m, _, err := s.readMeta(ctx, id)
		switch {
		case err == nil:
			entry.Meta, entry.LastModified = &m, m.UpdatedAt
		case errors.Is(err, ErrNotFound) || isNoSuchKey(err) || strings.Contains(err.Error(), "corrupt meta.json"):
			for obj := range s.client.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: s.dir(id), Recursive: true}) {
				if obj.Err != nil {
					return obj.Err
				}
				if obj.LastModified.After(entry.LastModified) {
					entry.LastModified = obj.LastModified
				}
			}
		default:
			return err
		}
		if err := fn(entry); err != nil {
			return err
		}
	}
	return nil
}

// RetentionTagKey is the object tag rum-api puts on every replay object it
// writes to S3 (chunks, mp4 segments, meta.json; never replays/schema.json).
// The bucket lifecycle rules expire objects by its value.
const RetentionTagKey = "ouo-retention"

// RetentionTag is the tag value for a retention: whole days, rounded up
// ("30d"), because S3 lifecycle expiration counts days. 0 (keep forever)
// is "keep", which no rule matches.
func RetentionTag(d time.Duration) string {
	if d <= 0 {
		return "keep"
	}
	return strconv.Itoa(RetentionDays(d)) + "d"
}

// RetentionDays is d in whole days, rounded up, at least 1.
func RetentionDays(d time.Duration) int {
	days := int((d + 24*time.Hour - 1) / (24 * time.Hour))
	return max(days, 1)
}

// lifecycleRulePrefix marks the rules rum-api owns; others are left alone.
const lifecycleRulePrefix = "ouo-replays-"

// ApplyLifecycleRules makes the bucket's ouo-replays-* rules one expiration
// rule per retention in retentions (0 entries are skipped): objects under
// [<prefix>/]replays/ tagged ouo-retention=<n>d expire after n days. Rules
// with other ids are kept. Idempotent.
func (s *S3) ApplyLifecycleRules(ctx context.Context, retentions []time.Duration) error {
	cfg, err := s.client.GetBucketLifecycle(ctx, s.bucket)
	if err != nil {
		r := minio.ToErrorResponse(err)
		if r.Code != "NoSuchLifecycleConfiguration" && r.StatusCode != 404 {
			return fmt.Errorf("get bucket lifecycle: %w", err)
		}
		cfg = lifecycle.NewConfiguration()
	}
	rules := cfg.Rules[:0]
	for _, r := range cfg.Rules {
		if !strings.HasPrefix(r.ID, lifecycleRulePrefix) {
			rules = append(rules, r)
		}
	}
	days := map[int]bool{}
	for _, d := range retentions {
		if d > 0 {
			days[RetentionDays(d)] = true
		}
	}
	sorted := make([]int, 0, len(days))
	for n := range days {
		sorted = append(sorted, n)
	}
	sort.Ints(sorted)
	for _, n := range sorted {
		tag := strconv.Itoa(n) + "d"
		rules = append(rules, lifecycle.Rule{
			ID:     lifecycleRulePrefix + tag,
			Status: "Enabled",
			RuleFilter: lifecycle.Filter{And: lifecycle.And{
				Prefix: s.prefix + "replays/",
				Tags:   []lifecycle.Tag{{Key: RetentionTagKey, Value: tag}},
			}},
			Expiration: lifecycle.Expiration{Days: lifecycle.ExpirationDays(n)},
		})
	}
	cfg.Rules = rules
	if len(rules) == 0 {
		return s.client.SetBucketLifecycle(ctx, s.bucket, nil)
	}
	if err := s.client.SetBucketLifecycle(ctx, s.bucket, cfg); err != nil {
		return fmt.Errorf("set bucket lifecycle: %w", err)
	}
	return nil
}
