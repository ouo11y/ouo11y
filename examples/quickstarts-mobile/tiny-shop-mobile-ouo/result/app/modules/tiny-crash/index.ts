import { requireNativeModule } from "expo";

// The native module in ios/TinyCrashModule.swift. Not in Expo Go: it needs a build of this app.
const TinyCrash = requireNativeModule<{ crash(): void }>("TinyCrash");

export const crash = () => TinyCrash.crash();
