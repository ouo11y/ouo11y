import { describe, expect, it } from "vitest";
import { exceptionAttributes } from "../src/errors/classify";
import { isInApp, normalizeLocation, normalizeStack } from "../src/errors/stack";

describe("stack normalisation (G5)", () => {
  it("strips per-install container paths: device, simulator and Android", () => {
    expect(normalizeLocation("address at /private/var/containers/Bundle/Application/8F6B2A1C-0D4E-4C1B-9A55-2B7C3D4E5F60/Store.app/main.jsbundle:1:20345")).toBe(
      "app:///main.jsbundle:1:20345",
    );
    expect(
      normalizeLocation(
        "/Users/me/Library/Developer/CoreSimulator/Devices/0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D/data/Containers/Bundle/Application/11111111-2222-3333-4444-555555555555/Store.app/main.jsbundle:1:99",
      ),
    ).toBe("app:///main.jsbundle:1:99");
    expect(normalizeLocation("address at index.android.bundle:1:532")).toBe("app:///index.android.bundle:1:532");
    // Two installs of the same build read the same.
    const a = normalizeStack("Error: x\n    at onPress (address at /var/containers/Bundle/Application/AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA/S.app/main.jsbundle:1:10)");
    const b = normalizeStack("Error: x\n    at onPress (address at /var/containers/Bundle/Application/BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB/S.app/main.jsbundle:1:10)");
    expect(a.stacktrace).toBe(b.stacktrace);
  });

  it("drops the Metro host and query in dev", () => {
    expect(normalizeLocation("http://192.168.1.20:8081/index.bundle//&platform=ios&dev=true&lazy=true:51234:17")).toBe("app:///index.bundle:51234:17");
    expect(normalizeLocation("http://localhost:8081/src/screens/Cart.tsx?platform=ios:10:4")).toBe("app:///src/screens/Cart.tsx:10:4");
  });

  it("marks in-app frames; native, engine and dependency frames are not", () => {
    expect(isInApp("app:///main.jsbundle:1:2")).toBe(true);
    expect(isInApp("native")).toBe(false);
    expect(isInApp("[native code]")).toBe(false);
    expect(isInApp("InternalBytecode.js:1:1234")).toBe(false);
    expect(isInApp("app:///node_modules/react-native/Libraries/Pressability.js:3:4")).toBe(false);
  });

  it("rewrites Hermes and JSC frames into the bridge's form", () => {
    const hermes = [
      "TypeError: Cannot read property 'id' of undefined",
      "    at checkout (address at /var/containers/Bundle/Application/8F6B2A1C-0D4E-4C1B-9A55-2B7C3D4E5F60/Store.app/main.jsbundle:1:20345)",
      "    at apply (native)",
      "    at anonymous (address at InternalBytecode.js:1:1489)",
    ].join("\n");
    const out = normalizeStack(hermes);
    expect(out.stacktrace).toBe(
      [
        "TypeError: Cannot read property 'id' of undefined",
        "  at checkout (app:///main.jsbundle:1:20345) [in app]",
        "  at apply (native)",
        "  at anonymous (InternalBytecode.js:1:1489)",
      ].join("\n"),
    );
    expect(out.frames.map((f) => f.inApp)).toEqual([true, false, false]);

    const jsc = normalizeStack("checkout@/var/containers/Bundle/Application/8F6B2A1C-0D4E-4C1B-9A55-2B7C3D4E5F60/Store.app/main.jsbundle:12:34\n[native code]");
    expect(jsc.stacktrace).toBe("  at checkout (app:///main.jsbundle:12:34) [in app]\n  at ? ([native code])");
  });

  it("exception records carry the normalised stack", () => {
    const err = new Error("boom");
    err.stack = "Error: boom\n    at f (address at /private/var/containers/Bundle/Application/8F6B2A1C-0D4E-4C1B-9A55-2B7C3D4E5F60/Store.app/main.jsbundle:1:7)";
    expect(exceptionAttributes(err, "captured", false)["exception.stacktrace"]).toBe("Error: boom\n  at f (app:///main.jsbundle:1:7) [in app]");
  });
});
