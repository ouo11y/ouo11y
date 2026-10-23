/**
 * Tap targets (checklist G4), the way @sentry/react-native's TouchEventBoundary finds them: from
 * the touched host view's fiber (`event._targetInst`) up to the provider, each component's label
 * (`ouo-label`, `sentry-label`, `accessibilityLabel`, `aria-label`, `testID`, in that order) or
 * its display name. Text content is never read (replays and timelines mask text by default).
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
}

export const MAX_TAP_PATH = 20;
const LABEL_PROPS = ["ouo-label", "sentry-label", "accessibilityLabel", "aria-label", "testID"];

function labelOf(props: Record<string, unknown>): string | undefined {
  for (const key of LABEL_PROPS) {
    const v = props[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function nameOf(elementType: unknown): string | undefined {
  if (!elementType || (typeof elementType !== "object" && typeof elementType !== "function")) return undefined;
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
  let cursor = fiber ?? undefined;
  let steps = 0;
  while (cursor && parts.length < MAX_TAP_PATH && steps < 200) {
    steps++;
    if (stop?.(cursor)) break;
    const props = cursor.memoizedProps && typeof cursor.memoizedProps === "object" ? (cursor.memoizedProps as Record<string, unknown>) : undefined;
    const l = props ? labelOf(props) : undefined;
    const part = l ?? nameOf(cursor.elementType);
    if (l && !label) label = l;
    if (part && parts[parts.length - 1] !== part) parts.push(part);
    cursor = cursor.return ?? undefined;
  }
  if (parts.length === 0) return undefined;
  return { target: label ?? parts[0]!, path: parts.join(" > ") };
}
