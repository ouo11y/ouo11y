import { describe, expect, it } from "vitest";
import { buildResource, deviceAttributes } from "../src/telemetry/resource";

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

describe("device model without app code (G5)", () => {
  it("reads expo-device's native constants from the Expo module registry", () => {
    const expo = { modelId: "iPhone17,2", modelName: "iPhone 16 Pro Max", manufacturer: "Apple", isDevice: true };
    expect(deviceAttributes({}, expo)).toMatchObject({ "device.model.identifier": "iPhone17,2", "device.model.name": "iPhone 16 Pro Max", "device.manufacturer": "Apple" });
    const g = globalThis as { expo?: { modules?: Record<string, unknown> } };
    g.expo = { modules: { ExpoDevice: expo } };
    try {
      expect(buildResource(service).attributes["device.model.identifier"]).toBe("iPhone17,2");
    } finally {
      delete g.expo;
    }
  });

  it("app values win; the simulator's CPU name is not a model", () => {
    expect(deviceAttributes({ modelIdentifier: "iPhone15,2" }, { modelId: "iPhone17,2" })["device.model.identifier"]).toBe("iPhone15,2");
    const sim = deviceAttributes({}, { modelId: "arm64", modelName: "Simulator iOS", isDevice: false });
    expect(sim["device.model.identifier"]).toBeUndefined();
    expect(sim["ouo.device.simulator"]).toBe(true);
    expect(deviceAttributes({}, undefined)["device.model.identifier"]).toBeUndefined();
  });
});
