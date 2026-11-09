# OpenTelemetry metrics

Sources: `specification/metrics/data-model.md` (Mixed), `metrics/api.md`, `metrics/sdk.md`, `metrics/v1/metrics.proto`. Versions in [otel-common-model.md](otel-common-model.md).

## Two models: what you call and what is sent

**Instruments** are the API. You call them per measurement. The SDK **aggregates** measurements in memory and, on a timer, exports **metric points**. A browser calling `histogram.record(143)` 50 times sends one data point, not 50.

| Instrument | Sync? | Default result on the wire |
|---|---|---|
| Counter | sync | Sum, monotonic |
| Asynchronous Counter | callback | Sum, monotonic |
| UpDownCounter | sync | Sum, not monotonic |
| Asynchronous UpDownCounter | callback | Sum, not monotonic |
| Histogram | sync | Histogram (explicit buckets) |
| Gauge | sync | Gauge |
| Asynchronous Gauge | callback | Gauge |

The SDK's Views can change names, drop attributes and pick another aggregation. No instrument produces a Summary.

## Wire shape

```
ResourceMetrics → ScopeMetrics → Metric → one of {Gauge, Sum, Histogram, ExponentialHistogram, Summary} → data points
```

`Metric`: `name` 1, `description` 2, `unit` 3 (UCUM), then the oneof: `gauge` 5, `sum` 7, `histogram` 9, `exponential_histogram` 10, `summary` 11, then `metadata` 12.

| Data type | Extra fields | Point type |
|---|---|---|
| `Gauge` | none | `NumberDataPoint` |
| `Sum` | `aggregation_temporality`, `is_monotonic` | `NumberDataPoint` |
| `Histogram` | `aggregation_temporality` | `HistogramDataPoint` |
| `ExponentialHistogram` | `aggregation_temporality` | `ExponentialHistogramDataPoint` |
| `Summary` (legacy) | none, always cumulative | `SummaryDataPoint` |

`NumberDataPoint`: `attributes` 7, `start_time_unix_nano` 2, `time_unix_nano` 3, `as_double` 4 or `as_int` 6, `exemplars` 5, `flags` 8.

`HistogramDataPoint`: `attributes` 9, start 2, time 3, `count` 4, `sum` 5, `bucket_counts` 6, `explicit_bounds` 7, `exemplars` 8, `flags` 10, `min` 11, `max` 12.

`ExponentialHistogramDataPoint` also has `scale`, `zero_count`, `positive`, `negative` and `zero_threshold`.

A series is defined by metric name plus resource plus scope plus point attributes. **Every distinct combination is one time series.** The flag value 1 on a point means "no recorded value", a staleness marker.

## The types in plain terms

- **Sum**: a running total or a change in it. Requests, errors.
- **Gauge**: the current value of something, where adding two makes no sense. Memory in use.
- **Histogram**: how many values fell in each bucket, plus count, sum, min, max. Bucket edges are fixed by the producer. Default edges 0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000. Latency in ms suits those edges. CLS, a score usually below 1, does not.
- **ExponentialHistogram**: buckets at powers of `base = 2^(2^-scale)`, with the scale automatically reduced to fit. Default up to 160 buckets, max scale 20. No edge configuration, relative error is bounded, and it merges well. Good for values with an unknown range.
- **Summary**: pre-computed quantiles. Cannot be merged across instances. Legacy; do not use it. Averaging p95s from many browsers is meaningless, which is why we want histograms.

## Temporality, and why browsers are the hard case

Every Sum and Histogram point covers a time window `(start, end]`.

| | Cumulative | Delta |
|---|---|---|
| Value is | Total since a fixed start | Change since the last export |
| Windows | `(T0,T1] (T0,T2] (T0,T3]` | `(T0,T1] (T1,T2] (T2,T3]` |
| Sender keeps | State for every series, forever | Almost nothing |
| One lost export | Absorbed by the next point | That interval is gone |
| Backend needs | Nothing special | Rate logic for deltas, or conversion |
| Used by | Prometheus style | StatsD style |

SDK default is `cumulative`. The Delta and LowMemory settings are chosen through `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`.

The underlying rule is **single writer**: every metric stream MUST have exactly one logical source (spec, Stable). The Prometheus-style model assumes that writer lives a long time.

A browser tab breaks those assumptions in one of two ways:

- **Give each tab its own identity** (for example a per-page `service.instance.id`). Cumulative is now well-defined, but each page view is a **new series for every metric and label combination**. A site with a million daily page views creates millions of short-lived series. On Mimir, the default is 150,000 active series per tenant.
- **Give tabs a shared identity.** Now thousands of writers report one series, which the spec calls an error state. Cumulative values jump up and down and look like constant resets. Deltas overlap.

Delta avoids the sender-side state, and survives a tab dying better, but does not by itself resolve the identity problem:

- The spec's delta-to-cumulative conversion needs all points of a stream to reach one place, and **resets the counter when a point does not line up with the expected next window**. Thousands of overlapping tabs do not line up.
- The contrib `deltatocumulative` processor is **alpha** and tracks streams in memory.
- Mimir **rejects delta by default**; `otel_native_delta_ingestion` is experimental (source).
- VictoriaMetrics stores delta as-is from v1.132 but says it works best with cumulative, and warns against dedup and downsampling on delta series (source).

What fits short-lived clients is usually to not make the client a metrics writer: send events, and aggregate on the server into a small number of series with a server as the single writer. That has its own costs (see the [comparison](otel-signal-choice-and-backends.md)). The final decision is Step 2's.

## Exemplars

An exemplar is one real measurement attached to a data point: `filtered_attributes`, `time_unix_nano`, value, and optional `trace_id` and `span_id`. They are how a chart links to a trace. SDK default filter is `TraceBased`, which only keeps measurements inside a sampled trace.

Mimir has exemplars **off by default** (`max_global_exemplars_per_user` = 0; source). I found no exemplar parsing in VictoriaMetrics' OTLP path (source; not run).

## Cardinality

Cardinality is the number of distinct attribute combinations. SDK limit per instrument defaults to **2000**; beyond that, new combinations merge into a single point with `otel.metric.overflow=true` (spec, Stable). The limit applies per collection cycle within one SDK, so it protects the browser's memory but does nothing about the total across a million browsers.

Backend caps: Mimir defaults are 150,000 series per tenant, 30 label names per series, 2048 bytes per value. Resource attributes only become labels if promoted, and otherwise land on `target_info`.

Never use `session.id`, `user.id`, full URLs or device ids as metric attributes. Each one multiplies series.

## Time and client clocks

`time_unix_nano` is required, `start_time_unix_nano` is strongly encouraged. Mimir rejects samples more than 10 minutes in the future by default, and the out-of-order window defaults to none (source), so a skewed client can lose points.

## Status

Core data model, exemplars, single writer and temporality are **Stable**. Resets and Gaps, Overlap, and Stream Manipulations (where delta-to-cumulative lives) are **Development**. Summary is legacy.
