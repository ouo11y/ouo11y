import { propagation, type Context, type TextMapGetter, type TextMapPropagator, type TextMapSetter } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import type { SessionManager } from "../session/manager";

/**
 * W3C TraceContext propagator of the SDK. With `propagation.sessionBaggage` it also sends W3C
 * `baggage: session.id=<id>` (spec PRP-6), to the same URLs and with the value the records
 * carry; off by default, and nothing but the session id is ever added. React Native has no
 * async context manager, so the baggage is merged at inject time.
 */
export class SessionPropagator implements TextMapPropagator {
  private readonly inner = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });

  constructor(
    private readonly session: SessionManager,
    private readonly sessionBaggage = false,
  ) {}

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    // The valid session's id, as on the records; none while no session is valid.
    const id = this.session.active()?.id;
    if (!this.sessionBaggage || !id) {
      this.inner.inject(context, carrier, setter);
      return;
    }
    const existing = propagation.getBaggage(context) ?? propagation.createBaggage();
    this.inner.inject(propagation.setBaggage(context, existing.setEntry("session.id", { value: id })), carrier, setter);
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.inner.extract(context, carrier, getter);
  }

  fields(): string[] {
    return this.inner.fields();
  }
}
