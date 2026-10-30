/** Demo-only native module (ios/OuoChaosModule.swift); undefined in Expo Go and on web. */
export interface OuoChaos {
  blockMainThread(ms: number): Promise<void>;
  stutterMainThread(ms: number, times: number): void;
  simulateOutOfMemory(): void;
}

// Expo registers every native module on `globalThis.expo.modules` (as the SDK reads its own).
export const chaos = (globalThis as { expo?: { modules?: { OuoChaos?: OuoChaos } } }).expo?.modules?.OuoChaos;
