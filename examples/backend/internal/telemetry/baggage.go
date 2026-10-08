package telemetry

import (
	"context"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// BaggageKeys lists the W3C Baggage members that the ouo SDKs propagate and
// that must be copied onto every backend span so that Tempo can find backend
// spans by session (ADR-0001, "Correlation").
var BaggageKeys = []string{"session.id", "user.id", "ouo.platform"}

// BaggageSpanProcessor copies selected baggage members from the span's start
// context onto the span as attributes. It is a no-op for every other
// SpanProcessor hook.
type BaggageSpanProcessor struct {
	keys []string
}

var _ sdktrace.SpanProcessor = (*BaggageSpanProcessor)(nil)

// NewBaggageSpanProcessor returns a processor that copies the given baggage
// keys (defaults to BaggageKeys) onto spans.
func NewBaggageSpanProcessor(keys ...string) *BaggageSpanProcessor {
	if len(keys) == 0 {
		keys = BaggageKeys
	}
	return &BaggageSpanProcessor{keys: keys}
}

// OnStart implements sdktrace.SpanProcessor.
func (p *BaggageSpanProcessor) OnStart(ctx context.Context, span sdktrace.ReadWriteSpan) {
	span.SetAttributes(AttributesFromBaggage(ctx, p.keys...)...)
}

// OnEnd implements sdktrace.SpanProcessor.
func (p *BaggageSpanProcessor) OnEnd(sdktrace.ReadOnlySpan) {}

// Shutdown implements sdktrace.SpanProcessor.
func (p *BaggageSpanProcessor) Shutdown(context.Context) error { return nil }

// ForceFlush implements sdktrace.SpanProcessor.
func (p *BaggageSpanProcessor) ForceFlush(context.Context) error { return nil }

// AttributesFromBaggage returns one attribute per requested key that is
// present (and non-empty) in the baggage carried by ctx. Handlers use the
// same helper to put session.id on log records.
func AttributesFromBaggage(ctx context.Context, keys ...string) []attribute.KeyValue {
	if len(keys) == 0 {
		keys = BaggageKeys
	}
	bag := baggage.FromContext(ctx)
	if bag.Len() == 0 {
		return nil
	}
	attrs := make([]attribute.KeyValue, 0, len(keys))
	for _, k := range keys {
		if v := bag.Member(k).Value(); v != "" {
			attrs = append(attrs, attribute.String(k, v))
		}
	}
	return attrs
}

// BaggageValue returns the value of a single baggage member, or "" if absent.
func BaggageValue(ctx context.Context, key string) string {
	return baggage.FromContext(ctx).Member(key).Value()
}
