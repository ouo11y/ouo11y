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
  /** `ouo-frustration={false}` on a component on the way: no rage or dead taps from this touch. */
  optedOut?: true;
}

export type Gesture = "tap" | "long_press" | "swipe";

/** The fields of a React Native touch event the SDK reads: the touched host view's fiber, the position, the fingers down. */
export interface TouchEventLike {
  _targetInst?: FiberLike;
  nativeEvent?: { pageX?: number; pageY?: number; touches?: ArrayLike<unknown> };
}

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

/** One fiber of the walk: its label, display name and accessibility role. */
interface Seen {
  label: string | undefined;
  name: string | undefined;
  role: string | undefined;
}

/**
 * Walks from the touched fiber to the root (or `stop`, the provider's own view). Returns
 * undefined when nothing on the way has a label or a display name.
 */
export function touchedComponent(fiber: FiberLike | null | undefined, stop?: (f: FiberLike) => boolean): TouchedComponent | undefined {
  const parts: string[] = [];
  let label: string | undefined;
  let optedOut = false;
  const seen: Seen[] = [];
  let cursor = fiber ?? undefined;
  let steps = 0;
  while (cursor && parts.length < MAX_TAP_PATH && steps < 200) {
    steps++;
    if (stop?.(cursor)) break;
    const props = cursor.memoizedProps && typeof cursor.memoizedProps === "object" ? (cursor.memoizedProps as Record<string, unknown>) : undefined;
    const l = props ? labelOf(props) : undefined;
    if (props?.["ouo-frustration"] === false) optedOut = true;
    const name = nameOf(cursor.elementType);
    if (l && !label) label = l;
    seen.push({ label: l, name, role: props ? roleOf(props) : undefined });
    const part = l ?? name;
    if (part && parts[parts.length - 1] !== part) parts.push(part);
    cursor = cursor.return ?? undefined;
  }
  if (parts.length === 0) return undefined;
  const touched: TouchedComponent = { target: label ?? parts[0]!, path: parts.join(" > "), viewType: viewTypeOf(seen, label, fiber) };
  if (optedOut) touched.optedOut = true;
  return touched;
}

/**
 * The touched control is the walk up to the last fiber of the first run that carries the target's
 * label (React Native passes a Pressable's testID and role down to its View and host view; a
 * fiber with neither label nor name, such as a host view or a context, does not end the run).
 * Without a label it ends at the innermost named component.
 */
function viewTypeOf(seen: Seen[], label: string | undefined, fiber: FiberLike | null | undefined): string {
  let end = label ? seen.findIndex((s) => s.label === label) : seen.findIndex((s) => s.name);
  if (end < 0) end = seen.length - 1;
  if (label) {
    for (let i = end + 1; i < seen.length; i++) {
      if (seen[i]!.label === label) end = i;
      else if (seen[i]!.label || seen[i]!.name) break;
    }
  }
  const control = seen.slice(0, end + 1);
  const role = control.find((s) => s.role)?.role;
  const labelled = control.filter((s) => label && s.label === label && s.name).at(-1)?.name;
  const innermost = control.find((s) => s.name)?.name;
  const host = typeof fiber?.elementType === "string" ? fiber.elementType : undefined;
  return role ?? labelled ?? innermost ?? host ?? "View";
}
