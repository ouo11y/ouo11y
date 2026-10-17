import { describe, expect, it } from "vitest";
import { buildResource } from "../src/telemetry/resource";

const service = { name: "mobile-store", version: "2.3.0", environment: "test" };

describe("buildResource", () => {
  it("adds the app's resource attributes, such as the rollout cohort", () => {
    const attrs = buildResource(service, {}, { "ouo.rum.mode": "parallel", "ouo.rollout.bucket": 42 }).attributes;
    expect(attrs["ouo.rum.mode"]).toBe("parallel");
    expect(attrs["ouo.rollout.bucket"]).toBe(42);
    expect(attrs["service.name"]).toBe("mobile-store");
  });

  it("keeps the SDK's own attributes on a clash", () => {
    const attrs = buildResource(service, {}, { "service.name": "spoofed", "ouo.platform": "web" }).attributes;
    expect(attrs["service.name"]).toBe("mobile-store");
    expect(attrs["ouo.platform"]).toBe("mobile");
  });
});
