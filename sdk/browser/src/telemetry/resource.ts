import { browserDetector } from "@opentelemetry/opentelemetry-browser-detector";
import { defaultResource, detectResources, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ServiceOptions } from "../types";
import { SDK_NAME, SDK_VERSION } from "../version";

/** Minimal OS detection from the user agent; `browser.*` comes from the OTel browser detector. */
export function detectOs(userAgent: string): { name: string; version?: string } | undefined {
  const ua = userAgent;
  let m: RegExpMatchArray | null;
  if ((m = ua.match(/iPhone OS (\d+[._]\d+(?:[._]\d+)?)/))) return { name: "iOS", version: m[1]!.replace(/_/g, ".") };
  if ((m = ua.match(/iPad; CPU OS (\d+[._]\d+(?:[._]\d+)?)/))) return { name: "iPadOS", version: m[1]!.replace(/_/g, ".") };
  if ((m = ua.match(/Android (\d+(?:\.\d+)*)/))) return { name: "Android", version: m[1]! };
  if ((m = ua.match(/Windows NT (\d+(?:\.\d+)*)/))) return { name: "Windows", version: m[1]! };
  if ((m = ua.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/))) return { name: "macOS", version: m[1]!.replace(/_/g, ".") };
  if (/CrOS/.test(ua)) return { name: "ChromeOS" };
  if (/Linux/.test(ua)) return { name: "Linux" };
  return undefined;
}

/** `deviceId`: the browser's `device.id` (session/device.ts), on every exported batch. */
export function buildResource(service: ServiceOptions, deviceId?: string): Resource {
  const attrs: Record<string, string | number | boolean> = {
    "service.name": service.name,
    "service.version": service.version,
    "deployment.environment.name": service.environment,
    "ouo.platform": "web",
    "ouo.sdk.name": SDK_NAME,
    "ouo.sdk.version": SDK_VERSION,
  };
  if (deviceId) attrs["device.id"] = deviceId;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const os = detectOs(ua);
  if (os) {
    attrs["os.name"] = os.name;
    if (os.version) attrs["os.version"] = os.version;
  }
  const detected = detectResources({ detectors: [browserDetector] });
  // Order: telemetry.sdk.* defaults < browser detector < our explicit attributes.
  return defaultResource().merge(detected).merge(resourceFromAttributes(attrs));
}
