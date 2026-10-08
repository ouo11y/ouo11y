import { propagation, type Context, type TextMapGetter, type TextMapPropagator, type TextMapSetter } from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import type { SessionManager } from "../session/manager";
import { PLATFORM } from "./correlation";

/**
 * W3C TraceContext + Baggage propagator that always injects the session baggage
 * (`session.id`, `user.id`, `ouo.platform`). React Native has no async context manager,
 * so baggage is merged at inject time, exactly like the browser SDK.
 */
export class SessionPropagator implements TextMapPropagator {
  private readonly inner = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });

  constructor(private readonly session: SessionManager) {}

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const existing = propagation.getBaggage(context) ?? propagation.createBaggage();
    const baggage = existing
      .setEntry("session.id", { value: this.session.id() })
      .setEntry("user.id", { value: this.session.userId() })
      .setEntry("ouo.platform", { value: PLATFORM });
    this.inner.inject(propagation.setBaggage(context, baggage), carrier, setter);
  }

  extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
    return this.inner.extract(context, carrier, getter);
  }

  fields(): string[] {
    return this.inner.fields();
  }
}
