import { describe, expect, it } from "vitest";
import { exceptionAttributes, serializeConsoleArgs, serializeError } from "../src/errors/classify";
import { isFailedRequest } from "../src/network";

describe("error classification (ADR-0004)", () => {
  it("uncaught errors are fatal and unhandled", () => {
    const a = exceptionAttributes(new TypeError("boom"), "uncaught");
    expect(a["exception.type"]).toBe("TypeError");
    expect(a["exception.message"]).toBe("boom");
    expect(String(a["exception.stacktrace"])).toContain("boom");
    expect(a["ouo.exception.fatal"]).toBe(true);
    expect(a["ouo.exception.handled"]).toBe(false);
    expect(a["ouo.exception.kind"]).toBe("uncaught");
  });

  it("unhandled rejections are fatal", () => {
    const a = exceptionAttributes("nope", "unhandledrejection");
    expect(a["ouo.exception.fatal"]).toBe(true);
    expect(a["exception.message"]).toBe("nope");
    expect(a["exception.type"]).toBe("Error");
  });

  it("captureError, console.error and resource errors are non-fatal and handled", () => {
    for (const kind of ["captured", "console", "resource"] as const) {
      const a = exceptionAttributes(new Error("x"), kind);
      expect(a["ouo.exception.fatal"]).toBe(false);
      expect(a["ouo.exception.handled"]).toBe(true);
      expect(a["ouo.exception.kind"]).toBe(kind);
    }
  });

  it("extra context is merged", () => {
    const a = exceptionAttributes(new Error("x"), "captured", { "cart.id": "c1", retries: 2 });
    expect(a["cart.id"]).toBe("c1");
    expect(a["retries"]).toBe(2);
  });

  it("serializes non-Error throwables", () => {
    expect(serializeError({ name: "Custom", message: "m", stack: "s" })).toEqual({ type: "Custom", message: "m", stacktrace: "s" });
    expect(serializeError({ code: 7 })).toEqual({ type: "Object", message: '{"code":7}', stacktrace: "" });
    expect(serializeError(42)).toEqual({ type: "Number", message: "42", stacktrace: "" });
    expect(serializeError(undefined).type).toBe("Undefined");
  });

  it("serializes console.error args and keeps the first Error's stack", () => {
    const err = new RangeError("bad range");
    const { error, message } = serializeConsoleArgs(["failed:", err, { a: 1 }]);
    expect(message).toBe('failed: RangeError: bad range {"a":1}');
    const s = serializeError(error);
    expect(s.type).toBe("RangeError");
    expect(s.message).toBe(message);
    expect(s.stacktrace).toBe(err.stack);
    expect(serializeError(serializeConsoleArgs(["only text"]).error)).toEqual({ type: "ConsoleError", message: "only text", stacktrace: "" });
  });
});

describe("failed request rule (ADR-0004)", () => {
  it("5xx and network failures are failed, 4xx and 2xx are not", () => {
    expect(isFailedRequest(500)).toBe(true);
    expect(isFailedRequest(503)).toBe(true);
    expect(isFailedRequest(599)).toBe(true);
    expect(isFailedRequest(0)).toBe(true);
    expect(isFailedRequest(undefined)).toBe(true);
    expect(isFailedRequest(404)).toBe(false);
    expect(isFailedRequest(400)).toBe(false);
    expect(isFailedRequest(200)).toBe(false);
    expect(isFailedRequest(302)).toBe(false);
  });
});
