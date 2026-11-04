/** Demo-only native module (ios/OuoChaosModule.swift, android/); undefined in Expo Go and on web. */
export interface OuoChaos {
  blockMainThread(ms: number): Promise<void>;
  stutterMainThread(ms: number, times: number): void;
  simulateOutOfMemory(): void;
  /** Android only: an uncaught exception on the main thread. */
  crashNatively?(): void;
  /** Android only: the `ouo_action` extra the activity was started with (the conformance suite's launches). */
  launchAction?(): string;
  /** Android only: `onJourneyCommand` carries the journey's broadcast commands (src/journey.ts). */
  addListener?(event: "onJourneyCommand", listener: (e: { cmd: string }) => void): { remove(): void };
}

// Expo registers every native module on `globalThis.expo.modules` (as the SDK reads its own).
export const chaos = (globalThis as { expo?: { modules?: { OuoChaos?: OuoChaos } } }).expo?.modules?.OuoChaos;
