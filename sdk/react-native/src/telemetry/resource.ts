import { defaultResource, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { Platform } from "react-native";
import type { DeviceOptions, ServiceOptions } from "../types";
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

/** OS and device attributes from `Platform` alone; `expo-device` values passed by the app win. */
export function deviceAttributes(device: DeviceOptions = {}): Record<string, string> {
  const os = Platform.OS;
  const constants = ((Platform as { constants?: PlatformConstants }).constants ?? {}) as PlatformConstants;
  const attrs: Record<string, string> = {};
  const osName =
    device.osName ?? (os === "ios" ? (constants.interfaceIdiom === "pad" ? "iPadOS" : "iOS") : os === "android" ? "Android" : os);
  if (osName) attrs["os.name"] = osName;
  const osVersion = device.osVersion ?? (os === "android" ? constants.Release ?? String(Platform.Version) : String(Platform.Version));
  if (osVersion && osVersion !== "undefined") attrs["os.version"] = osVersion;
  const model = device.modelIdentifier ?? (os === "android" ? constants.Model : undefined);
  if (model) attrs["device.model.identifier"] = model;
  if (device.modelName) attrs["device.model.name"] = device.modelName;
  const manufacturer = device.manufacturer ?? (os === "ios" ? "Apple" : constants.Manufacturer ?? constants.Brand);
  if (manufacturer) attrs["device.manufacturer"] = manufacturer;
  return attrs;
}

export function buildResource(service: ServiceOptions, device: DeviceOptions = {}): Resource {
  const attrs: Record<string, string | number | boolean> = {
    "service.name": service.name,
    "service.version": service.version,
    "deployment.environment.name": service.environment,
    "ouo.platform": PLATFORM,
    "ouo.sdk.name": SDK_NAME,
    "ouo.sdk.version": SDK_VERSION,
    ...deviceAttributes(device),
  };
  // Order: telemetry.sdk.* defaults < our explicit attributes.
  return defaultResource().merge(resourceFromAttributes(attrs));
}
