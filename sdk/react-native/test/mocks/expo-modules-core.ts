/**
 * Stand-in for `expo-modules-core`: `requireNativeModule("OuoReplay")` returns a fake of the
 * Swift module, or throws when `setNativeAvailable(false)` simulates Expo Go / web.
 */
import { vi } from "vitest";
import type { NativeReplayModule } from "../../src/replay";

let recording = false;
export const nativeReplay = {
  start: vi.fn((_endpoint: string, _options: unknown) => {
    recording = true;
  }),
  pause: vi.fn(() => {
    recording = false;
  }),
  resume: vi.fn(() => {
    recording = true;
  }),
  isRecording: vi.fn(() => recording),
  flush: vi.fn(() => Promise.resolve()),
  sessionDidRotate: vi.fn((_id: string) => undefined),
  setSessionId: vi.fn((_id: string) => undefined),
  stop: vi.fn(() => {
    recording = false;
  }),
} satisfies NativeReplayModule;

let available = true;
export function setNativeAvailable(v: boolean): void {
  available = v;
}
export function resetNative(): void {
  recording = false;
  available = true;
  for (const fn of Object.values(nativeReplay)) (fn as { mockClear(): void }).mockClear();
}

export function requireNativeModule(name: string): NativeReplayModule {
  if (!available || name !== "OuoReplay") {
    throw new Error(`Cannot find native module '${name}'`);
  }
  return nativeReplay;
}
