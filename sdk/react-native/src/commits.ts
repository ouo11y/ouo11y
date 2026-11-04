import { findNodeHandle } from "react-native";

/**
 * UI commits seen from JavaScript, the "screen changed" signal of dead taps (spec C6). React
 * Native's Fabric renderer hands every committed tree to `nativeFabricUIManager.completeRoot`,
 * and only when something on screen changed (a host view was created, removed or got new props).
 * Animations driven natively (`useNativeDriver`, Reanimated) and a press highlight done that way
 * (`TouchableOpacity`) are not commits.
 *
 * The renderer (ReactFabric) reads `completeRoot` once, when its module loads, from the global
 * `nativeFabricUIManager`. That global is a JSI host object, whose properties cannot be replaced,
 * and native code reads it back as a host object (`NativeDOM::linkRootNode` casts it and crashes
 * on anything else), so it cannot stay replaced either. The probe swaps in a proxy only while it
 * makes the renderer load (`findNodeHandle` is a getter of `react-native` that requires it), then
 * puts the host object back: the renderer keeps the counting `completeRoot`, everything else the
 * original.
 *
 * Hence `initRUM` must run before the first render (at the top of the app's entry file). A probe
 * installed after the renderer loaded sees no commit: it counts as live only once it saw one, so
 * an app like that, or an old-architecture one, has no signal and dead taps stay off rather than
 * reporting every tap.
 */
export interface CommitProbe {
  /** Commits seen so far. */
  count(): number;
  /** A commit was seen: the count means something. */
  live(): boolean;
}

interface FabricUIManager {
  completeRoot?: (...args: unknown[]) => unknown;
}

export const NO_COMMITS: CommitProbe = { count: () => 0, live: () => false };

/** One probe per JavaScript runtime: the renderer loads once. */
let installed: CommitProbe | undefined;

/** Reading the getter is the side effect; returning it keeps a bundler from dropping the read. */
function loadRenderer(): unknown {
  return findNodeHandle;
}

export function installCommitProbe(load: () => unknown = loadRenderer): CommitProbe {
  if (installed) return installed;
  const g = globalThis as { nativeFabricUIManager?: FabricUIManager };
  const manager = g.nativeFabricUIManager;
  if (!manager || typeof manager.completeRoot !== "function") return NO_COMMITS;
  let commits = 0;
  const original = manager.completeRoot;
  const completeRoot = (...args: unknown[]): unknown => {
    commits++;
    return original(...args);
  };
  const proxy = new Proxy(manager, {
    get: (target, key) => (key === "completeRoot" ? completeRoot : (target as Record<PropertyKey, unknown>)[key]),
  });
  try {
    g.nativeFabricUIManager = proxy;
    if (g.nativeFabricUIManager !== proxy) return NO_COMMITS;
    load();
  } catch {
    // A renderer that fails to load fails again at the first render, where the app sees it.
  } finally {
    if (g.nativeFabricUIManager === proxy) g.nativeFabricUIManager = manager;
  }
  installed = { count: () => commits, live: () => commits > 0 };
  return installed;
}

/** Tests only: forget the probe, as a new JavaScript runtime would. */
export function _resetCommitProbe(): void {
  installed = undefined;
}
