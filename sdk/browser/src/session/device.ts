import { uuidv4 } from "./ids";
import type { KeyValueStorage } from "./storage";

export const DEVICE_STORAGE_KEY = "ouo.device";

/**
 * The browser's `device.id` (OTel semantic conventions): random, persisted under its own key so
 * it survives session rotation, login and logout. Never derived from the IP address or anything
 * else that identifies a person. Where storage is blocked it lives as long as the page (the
 * storage's memory fallback).
 */
export function loadDeviceId(storage: KeyValueStorage): string {
  const raw = storage.get(DEVICE_STORAGE_KEY);
  try {
    const id = raw ? (JSON.parse(raw) as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id) return id;
  } catch {
    // Unreadable: replaced below.
  }
  const id = uuidv4();
  storage.set(DEVICE_STORAGE_KEY, JSON.stringify({ id }));
  return id;
}
