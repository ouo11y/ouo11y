/**
 * UI commits seen from JavaScript, the "screen changed" signal of dead taps (spec C6). React
 * Native's Fabric renderer hands every committed tree to `nativeFabricUIManager.completeRoot`,
 * and only when something on screen changed (a host view was created, removed or got new props).
 * Animations driven natively (`useNativeDriver`, Reanimated) and a press highlight done that way
 * (`TouchableOpacity`) are not commits.
 *
 * The renderer reads `completeRoot` once, when it loads at the first render: the probe must be
 * installed before (`initRUM` at the top of the app's entry file). It counts as live only once it
 * saw a commit, so a probe installed too late, or an old-architecture app, has no signal and dead
 * taps stay off rather than reporting every tap.
 */
export interface CommitProbe {
  /** Commits seen so far. */
  count(): number;
  /** A commit was seen: the count means something. */
  live(): boolean;
  /** Puts the original manager back. */
  uninstall(): void;
}

interface FabricUIManager {
  completeRoot?: (...args: unknown[]) => unknown;
}

const NONE: CommitProbe = { count: () => 0, live: () => false, uninstall: () => {} };

export function installCommitProbe(): CommitProbe {
  const g = globalThis as { nativeFabricUIManager?: FabricUIManager & { __ouoProbe?: CommitProbe } };
  const manager = g.nativeFabricUIManager;
  if (!manager || typeof manager.completeRoot !== "function") return NONE;
  if (manager.__ouoProbe) return manager.__ouoProbe;
  let commits = 0;
  const original = manager.completeRoot;
  const completeRoot = (...args: unknown[]): unknown => {
    commits++;
    return original(...args);
  };
  const probe: CommitProbe = {
    count: () => commits,
    live: () => commits > 0,
    uninstall: () => {
      if (g.nativeFabricUIManager === proxy) g.nativeFabricUIManager = manager;
    },
  };
  // The manager is a JSI host object: its properties cannot be replaced, the global can.
  const proxy = new Proxy(manager, {
    get: (target, key) => (key === "completeRoot" ? completeRoot : key === "__ouoProbe" ? probe : (target as Record<PropertyKey, unknown>)[key]),
  });
  try {
    g.nativeFabricUIManager = proxy;
  } catch {
    return NONE;
  }
  return g.nativeFabricUIManager === proxy ? probe : NONE;
}
