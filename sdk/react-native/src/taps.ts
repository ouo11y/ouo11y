/**
 * Tap targets (checklist G4), the way @sentry/react-native's TouchEventBoundary finds them: from
 * the touched host view's fiber (`event._targetInst`) up to the provider, each component's label
 * (`ouo-label`, `sentry-label`, `accessibilityLabel`, `aria-label`, `testID`, in that order) or
 * its display name. Text content is never read (replays and timelines mask text by default).
 * The view type and the gesture make the tap a readable user step (spec C6).
 */

/** The fields of a React fiber the walk reads. */
export interface FiberLike {
  elementType?: unknown;
  memoizedProps?: unknown;
  return?: FiberLike | null;
}

export interface TouchedComponent {
  /** The first label up the tree, else the innermost component name. */
  target: string;
  /** Every labelled or named component, innermost first, joined with ` > `. */
  path: string;
  /**
   * What was touched, never its label: the control's accessibility role (`button`, `link`), else
   * the name of the component that carries the label (`Pressable`), else the innermost component
   * name, else the native view (`RCTView`).
   */
  viewType: string;
}

export type Gesture = "tap" | "long_press" | "swipe";

export const MAX_TAP_PATH = 20;
/** A touch held this long is a long press (React Native's `delayLongPress` default). */
export const LONG_PRESS_MS = 500;
/** A touch that moved this far (points) between start and end is a swipe. */
export const SWIPE_DISTANCE = 10;
const LABEL_PROPS = ["ouo-label", "sentry-label", "accessibilityLabel", "aria-label", "testID"];

/** The gesture of a touch from its start and end: a move beats a hold. */
export function gestureOf(durationMs: number, dx: number, dy: number): Gesture {
  if (Math.hypot(dx, dy) >= SWIPE_DISTANCE) return "swipe";
  return durationMs >= LONG_PRESS_MS ? "long_press" : "tap";
}

function labelOf(props: Record<string, unknown>): string | undefined {
  for (const key of LABEL_PROPS) {
    const v = props[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

const CONTEXT_TYPES = new Set([Symbol.for("react.context"), Symbol.for("react.provider"), Symbol.for("react.consumer")]);

/** Context providers and consumers (`ThemeContext`, `SafeAreaInsetsContext`): plumbing, not what was touched. */
function isContext(elementType: object): boolean {
  const t = elementType as { $$typeof?: unknown; _context?: unknown; _currentValue?: unknown };
  return CONTEXT_TYPES.has(t.$$typeof as symbol) || "_currentValue" in t || t._context !== undefined;
}

function roleOf(props: Record<string, unknown>): string | undefined {
  const v = props.accessibilityRole ?? props.role;
  return typeof v === "string" && v.length > 0 && v !== "none" ? v : undefined;
}

function nameOf(elementType: unknown): string | undefined {
  if (!elementType || (typeof elementType !== "object" && typeof elementType !== "function")) return undefined;
  if (isContext(elementType)) return undefined;
  const displayName = (elementType as { displayName?: unknown }).displayName;
  return typeof displayName === "string" && displayName.length > 0 ? displayName : undefined;
}

/**
 * Walks from the touched fiber to the root (or `stop`, the provider's own view). Returns
 * undefined when nothing on the way has a label or a display name.
 */
export function touchedComponent(fiber: FiberLike | null | undefined, stop?: (f: FiberLike) => boolean): TouchedComponent | undefined {
  const parts: string[] = [];
  let label: string | undefined;
  // The touched control: the fibers up to the last one that carries the target's label
  // (React Native passes a Pressable's testID and role down to its View).
  let inControl = true;
  let role: string | undefined;
  let labelledName: string | undefined;
  let innermostName: string | undefined;
  const hostView = typeof fiber?.elementType === "string" ? fiber.elementType : undefined;
  let cursor = fiber ?? undefined;
  let steps = 0;
  while (cursor && parts.length < MAX_TAP_PATH && steps < 200) {
    steps++;
    if (stop?.(cursor)) break;
    const props = cursor.memoizedProps && typeof cursor.memoizedProps === "object" ? (cursor.memoizedProps as Record<string, unknown>) : undefined;
    const l = props ? labelOf(props) : undefined;
    const name = nameOf(cursor.elementType);
    if (l && !label) label = l;
    if (label && l !== label) inControl = false;
    if (inControl) {
      role ??= props ? roleOf(props) : undefined;
      if (l && name) labelledName = name;
      innermostName ??= name;
    }
    const part = l ?? name;
    if (part && parts[parts.length - 1] !== part) parts.push(part);
    cursor = cursor.return ?? undefined;
  }
  if (parts.length === 0) return undefined;
  return { target: label ?? parts[0]!, path: parts.join(" > "), viewType: role ?? labelledName ?? innermostName ?? hostView ?? "View" };
}
