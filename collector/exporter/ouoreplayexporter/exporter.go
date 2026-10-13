package ouoreplayexporter // import "github.com/ZiadMansourM/ouo/collector/exporter/ouoreplayexporter"

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.opentelemetry.io/collector/exporter"
	"go.opentelemetry.io/collector/exporter/exporterhelper"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.uber.org/zap"
)

// Header and attribute names shared with the receiver and rum-api.
const (
	HeaderProjectID = "X-Ouo-Project-Id"
	HeaderSessionID = "X-Ouo-Session-Id"
	HeaderSeq       = "X-Ouo-Seq"

	AttrProjectID  = "ouo.project.id"
	AttrSessionID  = "session.id"
	AttrReplaySeq  = "ouo.replay.seq"
	AttrReplayKind = "ouo.replay.kind"

	// maxResponseBytes bounds how much of an error response is read for the message.
	maxResponseBytes = 4 << 10
)

type replayExporter struct {
	cfg    *Config
	set    exporter.Settings
	client *http.Client
	url    string
	logger *zap.Logger
}

func newExporter(cfg *Config, set exporter.Settings) *replayExporter {
	return &replayExporter{
		cfg:    cfg,
		set:    set,
		url:    strings.TrimSuffix(cfg.ClientConfig.Endpoint, "/") + ChunksPath,
		logger: set.Logger,
	}
}

func (e *replayExporter) start(ctx context.Context, host component.Host) error {
	client, err := e.cfg.ClientConfig.ToClient(ctx, host.GetExtensions(), e.set.TelemetrySettings)
	if err != nil {
		return err
	}
	e.client = client
	return nil
}

// pushLogs posts every record as one chunk. Records are processed in order;
// on the first failure the error is returned together with the records not
// yet delivered, so a retry (retryable errors only) re-sends just those.
// rum-api overwrites a chunk with the same session and seq, so a duplicate
// delivery is harmless.
func (e *replayExporter) pushLogs(ctx context.Context, ld plog.Logs) error {
	type item struct {
		rl int
		sl int
		lr int
	}
	var items []item
	rls := ld.ResourceLogs()
	for i := 0; i < rls.Len(); i++ {
		sls := rls.At(i).ScopeLogs()
		for j := 0; j < sls.Len(); j++ {
			for k := 0; k < sls.At(j).LogRecords().Len(); k++ {
				items = append(items, item{i, j, k})
			}
		}
	}
	for n, it := range items {
		rl := rls.At(it.rl)
		lr := rl.ScopeLogs().At(it.sl).LogRecords().At(it.lr)
		if err := e.postChunk(ctx, rl.Resource().Attributes(), lr); err != nil {
			if n == 0 || consumererror.IsPermanent(err) {
				return err
			}
			// Return only the undelivered records for the retry.
			rest := plog.NewLogs()
			for _, r := range items[n:] {
				src := rls.At(r.rl)
				dst := rest.ResourceLogs().AppendEmpty()
				src.Resource().CopyTo(dst.Resource())
				dsl := dst.ScopeLogs().AppendEmpty()
				src.ScopeLogs().At(r.sl).Scope().CopyTo(dsl.Scope())
				src.ScopeLogs().At(r.sl).LogRecords().At(r.lr).CopyTo(dsl.LogRecords().AppendEmpty())
			}
			return consumererror.NewLogs(err, rest)
		}
	}
	return nil
}

// chunkBody returns the chunk JSON from the record body (bytes or string).
func chunkBody(lr plog.LogRecord) ([]byte, error) {
	switch lr.Body().Type() {
	case pcommon.ValueTypeBytes:
		return lr.Body().Bytes().AsRaw(), nil
	case pcommon.ValueTypeStr:
		return []byte(lr.Body().Str()), nil
	default:
		return nil, fmt.Errorf("log record body must be bytes or string, got %s", lr.Body().Type())
	}
}

func (e *replayExporter) postChunk(ctx context.Context, res pcommon.Map, lr plog.LogRecord) error {
	body, err := chunkBody(lr)
	if err != nil {
		return consumererror.NewPermanent(err)
	}
	attrs := lr.Attributes()
	projectID := strAttr(attrs, AttrProjectID)
	if projectID == "" {
		projectID = strAttr(res, AttrProjectID)
	}
	if projectID == "" {
		return consumererror.NewPermanent(errors.New("log record has no " + AttrProjectID + " attribute"))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url, bytes.NewReader(body))
	if err != nil {
		return consumererror.NewPermanent(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HeaderProjectID, projectID)
	if sid := strAttr(attrs, AttrSessionID); sid != "" {
		req.Header.Set(HeaderSessionID, sid)
	}
	if v, ok := attrs.Get(AttrReplaySeq); ok {
		req.Header.Set(HeaderSeq, strconv.FormatInt(v.Int(), 10))
	}
	if tok := string(e.cfg.IngestToken); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	resp, err := e.client.Do(req)
	if err != nil {
		// Network errors (connection refused, timeout) are retryable.
		return fmt.Errorf("post replay chunk to %s: %w", e.url, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseBytes))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
		return nil
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	ferr := fmt.Errorf("rum-api answered %d for project %s session %s seq %s: %s",
		resp.StatusCode, projectID, req.Header.Get(HeaderSessionID), req.Header.Get(HeaderSeq), strings.TrimSpace(string(msg)))
	switch {
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable:
		if d := retryAfter(resp.Header.Get("Retry-After")); d > 0 {
			return exporterhelper.NewThrottleRetry(ferr, d)
		}
		return ferr
	case resp.StatusCode >= 500:
		return ferr
	default:
		// 400 invalid, 401 bad ingest token, 403 wrong project, 409 kind
		// mismatch, 413 too large: retrying cannot help.
		return consumererror.NewPermanent(ferr)
	}
}

func strAttr(m pcommon.Map, key string) string {
	if v, ok := m.Get(key); ok && v.Type() == pcommon.ValueTypeStr {
		return v.Str()
	}
	return ""
}

// retryAfter parses a delay-seconds Retry-After value (0 when absent or not a number).
func retryAfter(v string) time.Duration {
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	return 0
}
