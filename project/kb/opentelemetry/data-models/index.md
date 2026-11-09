# OpenTelemetry data models

| File | Question it answers |
|---|---|
| [common-model.md](common-model.md) | What do all OTel signals share: versions read, Resource and Scope nesting, AnyValue, attribute limits, trace identity and `traceparent`, timestamps and clock skew, stability? |
| [logs.md](logs.md) | What is a log record field by field, what makes it an Event, what can the body hold, and where does OTEP 4430 really stand? |
| [traces.md](traces.md) | What is a span field by field: kinds, status, links, sampling, and why are long-lived or never-ended spans a client-side problem? |
| [metrics.md](metrics.md) | How do instruments become data points, what are the point types, and why are temporality and cardinality hard for browsers? |
