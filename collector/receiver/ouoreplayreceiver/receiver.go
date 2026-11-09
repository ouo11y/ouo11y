package ouoreplayreceiver // import "github.com/ouo11y/ouo11y/collector/receiver/ouoreplayreceiver"

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"go.opentelemetry.io/collector/client"
	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/component/componentstatus"
	"go.opentelemetry.io/collector/config/confighttp"
	"go.opentelemetry.io/collector/consumer"
	"go.opentelemetry.io/collector/consumer/consumererror"
	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/receiver"
	"go.opentelemetry.io/collector/receiver/receiverhelper"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"go.uber.org/zap"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ouo11y/ouo11y/collector/receiver/ouoreplayreceiver/internal/metadata"
)

// Attribute names of the emitted log records (ADR-0007 section 1).
const (
	AttrProjectID      = "ouo.project.id"
	AttrSessionID      = "session.id"
	AttrReplaySeq      = "ouo.replay.seq"
	AttrReplayKind     = "ouo.replay.kind"
	AttrReplayEncoding = "ouo.replay.encoding"
	// ResourceServiceName is the service.name of the replay stream's resource.
	ResourceServiceName = "ouo-replay"
	// AuthUsernameAttribute is the client.Info.Auth attribute the basicauth
	// extension fills with the authenticated username (= project id).
	AuthUsernameAttribute = "username"
	// dataFormat is the format label reported to receiverhelper.
	dataFormat = "json"
	// retryAfterDefault is sent with 503 when the consumer gave no delay.
	retryAfterDefault = 1 * time.Second
)

// projectIDRe is the project id format rum-api's sink accepts in
// X-Ouo-Project-Id (services/rum-api, project/kb-archive/ingest-gateway.md).
var projectIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

type replayReceiver struct {
	cfg    *Config
	set    receiver.Settings
	next   consumer.Logs
	obsrep *receiverhelper.ObsReport
	chunks metric.Int64Counter

	server     *http.Server
	shutdownWG sync.WaitGroup
}

func newReceiver(set receiver.Settings, cfg *Config, next consumer.Logs) (*replayReceiver, error) {
	obsrep, err := receiverhelper.NewObsReport(receiverhelper.ObsReportSettings{
		ReceiverID:             set.ID,
		Transport:              "http",
		ReceiverCreateSettings: set,
	})
	if err != nil {
		return nil, err
	}
	meter := set.MeterProvider.Meter(metadata.ScopeName)
	chunks, err := meter.Int64Counter("ouo_replay_chunks_total",
		metric.WithDescription("Replay chunks received, by project, kind and outcome (accepted, rejected, throttled, failed)."),
		metric.WithUnit("{chunk}"))
	if err != nil {
		return nil, err
	}
	return &replayReceiver{cfg: cfg, set: set, next: next, obsrep: obsrep, chunks: chunks}, nil
}

// Start implements component.Component.
func (r *replayReceiver) Start(ctx context.Context, host component.Host) error {
	mux := http.NewServeMux()
	mux.HandleFunc(DefaultPath, r.handleChunk)

	srv, err := r.cfg.ServerConfig.ToServer(ctx, host.GetExtensions(), r.set.TelemetrySettings, mux,
		confighttp.WithErrorHandler(writeMiddlewareError),
		// confighttp's default decoder list knows "" and gzip but not the
		// explicit "identity" token; rum-api accepts it, so do we.
		confighttp.WithDecoder("identity", func(body io.ReadCloser) (io.ReadCloser, error) { return body, nil }),
	)
	if err != nil {
		return err
	}
	r.server = srv

	var ln net.Listener
	if ln, err = r.cfg.ServerConfig.ToListener(ctx); err != nil {
		return err
	}
	r.set.Logger.Info("Starting replay HTTP server", zap.String("endpoint", ln.Addr().String()), zap.String("path", DefaultPath))

	r.shutdownWG.Go(func() {
		if errHTTP := r.server.Serve(ln); errHTTP != nil && !errors.Is(errHTTP, http.ErrServerClosed) {
			componentstatus.ReportStatus(host, componentstatus.NewFatalErrorEvent(errHTTP))
		}
	})
	return nil
}

// Shutdown implements component.Component.
func (r *replayReceiver) Shutdown(ctx context.Context) error {
	var err error
	if r.server != nil {
		err = r.server.Shutdown(ctx)
	}
	r.shutdownWG.Wait()
	return err
}

// handleChunk is POST /v1/replay/chunks. By the time it runs confighttp has
// already applied CORS, the authenticator (401), the body-size interceptor
// and content decompression (gzip or identity), so r.Body is the plain JSON
// bounded by max_request_body_size.
func (r *replayReceiver) handleChunk(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ctx := req.Context()

	projectID := authenticatedProject(ctx)
	if projectID == "" {
		// basicauth answers 401 before we are reached when configured;
		// this is defence in depth for a receiver started without `auth`.
		w.Header().Set("WWW-Authenticate", `Basic realm="ouo"`)
		writeError(w, http.StatusUnauthorized, "missing project credentials")
		return
	}

	if !projectIDRe.MatchString(projectID) {
		// rum-api's sink rejects such ids with a permanent 400, which would
		// drop the chunk after the 202; refuse it here instead.
		r.reject(ctx, projectID, "", "project")
		writeError(w, http.StatusForbidden, "project id "+strconv.Quote(projectID)+" must match "+projectIDRe.String()+" to record replays")
		return
	}

	limit := r.cfg.ServerConfig.MaxRequestBodySize
	if limit <= 0 {
		limit = DefaultMaxRequestBodySize
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			r.reject(ctx, projectID, "", "size")
			writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("chunk larger than %d bytes", limit))
			return
		}
		r.reject(ctx, projectID, "", "decode")
		writeError(w, http.StatusBadRequest, "read body: "+err.Error())
		return
	}
	if rrwebLimit := r.cfg.MaxRRWebChunkBytes; rrwebLimit > 0 && int64(len(body)) > rrwebLimit && peekKind(body) != KindFrames {
		r.reject(ctx, projectID, KindRRWeb, "size")
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("rrweb chunk larger than %d bytes (only kind \"frames\" may be up to %d bytes)", rrwebLimit, limit))
		return
	}

	c, err := parseChunk(body)
	if err != nil {
		r.reject(ctx, projectID, c.Kind, "decode")
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ld := buildLogs(projectID, c, body)
	opCtx := r.obsrep.StartLogsOp(ctx)
	err = r.next.ConsumeLogs(opCtx, ld)
	r.obsrep.EndLogsOp(opCtx, dataFormat, 1, err)
	if err != nil {
		code, retryAfter := statusFromConsumerError(err)
		outcome := "failed"
		if code == http.StatusTooManyRequests || code == http.StatusServiceUnavailable {
			outcome = "throttled"
		}
		r.chunks.Add(ctx, 1, metric.WithAttributes(
			attribute.String(AttrProjectID, projectID),
			attribute.String(AttrReplayKind, c.Kind),
			attribute.String("outcome", outcome)))
		if retryAfter > 0 {
			w.Header().Set("Retry-After", strconv.FormatInt(int64(retryAfter/time.Second), 10))
		}
		r.set.Logger.Warn("replay chunk not accepted downstream",
			zap.String("project", projectID), zap.String("session", c.SessionID), zap.Int("seq", c.Seq),
			zap.Int("status", code), zap.Error(err))
		msg := err.Error()
		if st, ok := status.FromError(err); ok {
			msg = st.Message()
		}
		writeError(w, code, msg)
		return
	}
	r.chunks.Add(ctx, 1, metric.WithAttributes(
		attribute.String(AttrProjectID, projectID),
		attribute.String(AttrReplayKind, c.Kind),
		attribute.String("outcome", "accepted")))

	if h := req.Header.Get("X-Ouo-Session-Id"); h != "" && h != c.SessionID {
		r.set.Logger.Warn("x-ouo-session-id header differs from body", zap.String("header", h), zap.String("body", c.SessionID))
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"accepted":   1,
		"session_id": c.SessionID,
		"kind":       c.Kind,
		"seq":        c.Seq,
		"events":     c.Events,
		"frames":     c.Frames,
		"touches":    c.Touches,
		"bytes":      len(body),
	})
}

func (r *replayReceiver) reject(ctx context.Context, projectID, kind, reason string) {
	if kind == "" {
		kind = "unknown"
	}
	r.chunks.Add(ctx, 1, metric.WithAttributes(
		attribute.String(AttrProjectID, projectID),
		attribute.String(AttrReplayKind, kind),
		attribute.String("outcome", "rejected"),
		attribute.String("reason", reason)))
}

// authenticatedProject returns the username the server authenticator put in
// the client context, "" when the request was not authenticated.
func authenticatedProject(ctx context.Context) string {
	ci := client.FromContext(ctx)
	if ci.Auth == nil {
		return ""
	}
	if s, ok := ci.Auth.GetAttribute(AuthUsernameAttribute).(string); ok {
		return s
	}
	return ""
}

// buildLogs turns one validated chunk into a plog.Logs with a single record:
// resource {ouo.project.id, service.name=ouo-replay}, body = chunk JSON bytes.
func buildLogs(projectID string, c chunk, body []byte) plog.Logs {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	res := rl.Resource().Attributes()
	res.PutStr("service.name", ResourceServiceName)
	res.PutStr(AttrProjectID, projectID)
	sl := rl.ScopeLogs().AppendEmpty()
	sl.Scope().SetName(metadata.ScopeName)
	lr := sl.LogRecords().AppendEmpty()
	now := pcommon.NewTimestampFromTime(time.Now())
	lr.SetObservedTimestamp(now)
	if c.StartedAt > 0 {
		lr.SetTimestamp(pcommon.Timestamp(uint64(c.StartedAt) * uint64(time.Millisecond)))
	} else {
		lr.SetTimestamp(now)
	}
	lr.Body().SetEmptyBytes().FromRaw(body)
	attrs := lr.Attributes()
	attrs.PutStr(AttrProjectID, projectID)
	attrs.PutStr(AttrSessionID, c.SessionID)
	attrs.PutInt(AttrReplaySeq, int64(c.Seq))
	attrs.PutStr(AttrReplayKind, c.Kind)
	attrs.PutStr(AttrReplayEncoding, dataFormat)
	return ld
}

// statusFromConsumerError maps the error returned by the next consumer to an
// HTTP status, following the OTLP receiver's own rules: a gRPC status wins
// (ResourceExhausted 429, Unavailable 503, InvalidArgument 400, ...), then a
// consumererror.Error with an HTTP status, then permanent = 500 and anything
// else is retryable = 503. The second value is the Retry-After to send with
// 429 / 503 (RetryInfo when the status carries one, else 1 second).
func statusFromConsumerError(err error) (int, time.Duration) {
	if st, ok := status.FromError(err); ok && st.Code() != codes.Unknown {
		code := httpStatusFromGRPC(st.Code())
		var ra time.Duration
		if code == http.StatusTooManyRequests || code == http.StatusServiceUnavailable {
			ra = retryAfterDefault
			for _, d := range st.Details() {
				if ri, ok := d.(*errdetails.RetryInfo); ok && ri.GetRetryDelay() != nil {
					ra = ri.GetRetryDelay().AsDuration()
				}
			}
		}
		return code, ra
	}
	var ce *consumererror.Error
	if errors.As(err, &ce) {
		code := consumererror.ToHTTPStatus(err)
		if code == http.StatusTooManyRequests || code == http.StatusServiceUnavailable {
			return code, retryAfterDefault
		}
		return code, 0
	}
	if consumererror.IsPermanent(err) {
		return http.StatusInternalServerError, 0
	}
	return http.StatusServiceUnavailable, retryAfterDefault
}

func httpStatusFromGRPC(c codes.Code) int {
	switch c {
	case codes.Canceled, codes.DeadlineExceeded, codes.Aborted, codes.OutOfRange, codes.Unavailable, codes.DataLoss:
		return http.StatusServiceUnavailable
	case codes.ResourceExhausted:
		return http.StatusTooManyRequests
	case codes.InvalidArgument:
		return http.StatusBadRequest
	case codes.Unauthenticated:
		return http.StatusUnauthorized
	case codes.PermissionDenied:
		return http.StatusForbidden
	case codes.Unimplemented:
		return http.StatusNotFound
	default:
		return http.StatusInternalServerError
	}
}

// writeMiddlewareError is the confighttp error handler: 401 from the
// authenticator, 400 from the decompressor. JSON like rum-api's errors.
func writeMiddlewareError(w http.ResponseWriter, _ *http.Request, msg string, code int) {
	if code == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Basic realm="ouo"`)
	}
	writeError(w, code, msg)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
