import type { Context } from "@opentelemetry/api";
import type { LogRecordProcessor, SdkLogRecord } from "@opentelemetry/sdk-logs";
import { SamplingDecision, type Sampler, type SamplingResult } from "@opentelemetry/sdk-trace-base";
import type { SessionManager } from "../session/manager";

/**
 * Head sampling by session (`sampling.sessionSampleRate`, roadmap 8b): a span is recorded and
 * sampled when its session is, whatever the parent says, so a session is either complete or
 * absent. The decision travels in `traceparent` (flag 00 for unsampled sessions), so a
 * ParentBased backend drops its side of the trace too.
 */
export class SessionSampler implements Sampler {
  constructor(private readonly session: SessionManager) {}

  shouldSample(): SamplingResult {
    return { decision: this.session.sampled() ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD };
  }

  toString(): string {
    return "OuoSessionSampler";
  }
}

/**
 * Wraps the export processor and drops log records of unsampled sessions. Runs after
 * `SessionLogProcessor`, so every record names its session; a `session.end` is checked against
 * the session it ends, never the active one.
 */
export class SampledLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly session: SessionManager,
    private readonly inner: LogRecordProcessor,
  ) {}

  onEmit(record: SdkLogRecord, context?: Context): void {
    const id = record.attributes["session.id"];
    if (typeof id === "string" && !this.session.sampledFor(id)) return;
    this.inner.onEmit(record, context);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
