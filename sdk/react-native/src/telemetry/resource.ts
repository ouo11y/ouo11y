import { defaultResource, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { Platform } from "react-native";
import type { Attrs, DeviceOptions, ServiceOptions } from "../types";
import { SDK_NAME, SDK_VERSION } from "../version";
import { PLATFORM } from "./correlation";

interface PlatformConstants {
  osVersion?: string;
  systemName?: string;
  interfaceIdiom?: string;
  Model?: string;
  Manufacturer?: string;
  Brand?: string;
  Release?: string;
}

/** Constants of expo-device's native module (`ExpoDevice`), when the app has expo-device installed. */
export interface ExpoDeviceConstants {
  modelId?: unknown;
  modelName?: unknown;
  manufacturer?: unknown;
  isDevice?: unknown;
}

/** CPU names `uname` returns on the iOS simulator instead of a model identifier. */
const SIMULATOR_MACHINES = new Set(["arm64", "x86_64", "i386"]);

/**
 * Reads expo-device's native constants from the Expo module registry, so the device model needs
 * no app code (checklist G5). No import: the SDK does not depend on expo-device, and the
 * registry is where every Expo module is (`src/replay.ts` reads its own module the same way).
 */
export function expoDeviceConstants(): ExpoDeviceConstants | undefined {
  try {
    const mod = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules?.["ExpoDevice"];
    return mod && typeof mod === "object" ? (mod as ExpoDeviceConstants) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * OS and device attributes. Order: values the app passes (`device`), then expo-device's native
 * constants when installed, then `Platform` (Android has the model there; iOS has none).
 */
export function deviceAttributes(device: DeviceOptions = {}, expo: ExpoDeviceConstants | undefined = expoDeviceConstants()): Record<string, string | boolean> {
  const os = Platform.OS;
  const constants = ((Platform as { constants?: PlatformConstants }).constants ?? {}) as PlatformConstants;
  const attrs: Record<string, string | boolean> = {};
  const osName =
    device.osName ?? (os === "ios" ? (constants.interfaceIdiom === "pad" ? "iPadOS" : "iOS") : os === "android" ? "Android" : os);
  if (osName) attrs["os.name"] = osName;
  const osVersion = device.osVersion ?? (os === "android" ? constants.Release ?? String(Platform.Version) : String(Platform.Version));
  if (osVersion && osVersion !== "undefined") attrs["os.version"] = osVersion;
  const simulator = expo?.isDevice === false;
  const expoModel = str(expo?.modelId);
  const model =
    device.modelIdentifier ??
    (expoModel && !(simulator && SIMULATOR_MACHINES.has(expoModel)) ? expoModel : undefined) ??
    (os === "android" ? constants.Model : undefined);
  if (model) attrs["device.model.identifier"] = model;
  const modelName = device.modelName ?? str(expo?.modelName);
  if (modelName) attrs["device.model.name"] = modelName;
  if (simulator) attrs["ouo.device.simulator"] = true;
  const manufacturer = device.manufacturer ?? str(expo?.manufacturer) ?? (os === "ios" ? "Apple" : constants.Manufacturer ?? constants.Brand);
  if (manufacturer) attrs["device.manufacturer"] = manufacturer;
  return attrs;
}

/** `bundle`: `ouo.app.bundle.*` of the OTA bundle given at init (src/attributes.ts), next to `service.version`. */
export function buildResource(service: ServiceOptions, device: DeviceOptions = {}, extra: Attrs = {}, bundle: Attrs = {}): Resource {
  const attrs: Record<string, string | number | boolean> = {
    ...extra,
    ...bundle,
    "service.name": service.name,
    "service.version": service.version,
    "deployment.environment.name": service.environment,
    "ouo.platform": PLATFORM,
    "ouo.sdk.name": SDK_NAME,
    "ouo.sdk.version": SDK_VERSION,
    ...deviceAttributes(device),
  };
  // Order: telemetry.sdk.* defaults < app attributes (`resource`) < the SDK's own attributes.
  return defaultResource().merge(resourceFromAttributes(attrs));
}
