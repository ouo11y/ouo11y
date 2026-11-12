// Local stand-in for @ouo11y/browser, used only when VITE_RUM_STUB=1. It has the functions
// src/rum.ts imports and logs every call to the console, so the storefront can be developed
// and demoed without the real package.

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

const log = (...args: unknown[]): void => console.info("[ouo stub]", ...args);
const sessionId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
let recording = false;

export function init(config: Record<string, unknown>): void {
  recording = (config["replay"] as { mode?: string } | undefined)?.mode !== "off";
  log("init", { ...config, projectToken: "<redacted>" });
}
export const setUser = (id: string | null): void => log("setUser", id);
export const recordEvent = (name: string, attrs?: Attrs): void => log("recordEvent", name, attrs);
export const recordException = (err: unknown, attrs?: Attrs): void => log("recordException", err, attrs);
export const trackNavigation = (name: string): void => log("trackNavigation", name);
export const getSessionId = (): string | undefined => sessionId;
export const diagnostics = (): { replayRecording: boolean } => ({ replayRecording: recording });
export const flush = async (): Promise<void> => log("flush");
export const replay = {
  start(): void {
    recording = true;
    log("replay.start");
  },
  stop(): void {
    recording = false;
    log("replay.stop");
  },
  capture: (): void => log("replay.capture"),
};
