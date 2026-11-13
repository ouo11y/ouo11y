/** Minimal react-native stand-in for the Vitest node environment. */
type Status = "active" | "background" | "inactive";
type Handler = (s: Status) => void;

const handlers = new Set<Handler>();

export const AppState = {
  currentState: "active" as Status,
  addEventListener(_type: "change", handler: Handler) {
    handlers.add(handler);
    return { remove: () => handlers.delete(handler) };
  },
  /** Test helper. */
  __emit(next: Status): void {
    AppState.currentState = next;
    for (const h of handlers) h(next);
  },
};

export const Platform = {
  OS: "ios" as "ios" | "android" | "web",
  Version: "17.5",
  constants: { osVersion: "17.5", systemName: "iOS", interfaceIdiom: "phone" },
  select<T>(spec: Record<string, T>): T | undefined {
    return spec[Platform.OS] ?? spec["default"];
  },
};

export type AppStateStatus = Status;

export function View(): null {
  return null;
}

/** Test helper: a "native tag" for anything with a numeric `__tag`. */
export function findNodeHandle(ref: unknown): number | null {
  const tag = (ref as { __tag?: unknown } | null)?.__tag;
  return typeof tag === "number" ? tag : null;
}
