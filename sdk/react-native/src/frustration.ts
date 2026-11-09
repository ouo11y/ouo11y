import type { Attrs, DeadTapOptions, RageTapOptions } from "./types";
import type { EventEmitter } from "./telemetry/events";
import type { Gesture } from "./taps";

/** The web's names (sdk/browser `interactions/clicks.ts`): one event per frustration, whatever the platform. */
export const RAGE_CLICK_EVENT = "ouo.rage_click";
export const DEAD_CLICK_EVENT = "ouo.dead_click";

/**
 * What a dead tap can be: a tap on a control, by its view type (spec C6 `ouo.ui.view_type`): an
 * accessibility role of something that acts when tapped, or React Native's touchables. A tap on
 * text, an image or a list row without a role is not a candidate (nothing promised it would act).
 */
const CONTROL_TYPES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "togglebutton",
  "imagebutton",
  "switch",
  "checkbox",
  "radio",
  "Button",
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableNativeFeedback",
  "TouchableWithoutFeedback",
]);

/** One finished touch of `RUMProvider`, as `ui.tap` records it. */
export interface Tap {
  /** `ouo.ui.target` (the view type when `timeline.tapLabels` is off): identity, never text. */
  target: string;
  viewType: string | undefined;
  gesture: Gesture;
  screen: string;
  /** Touch start (epoch ms) and position (points). */
  at: number;
  x: number;
  y: number;
  /** `ouo-frustration={false}` on the control or an ancestor. */
  optedOut: boolean;
}

export interface TapFrustrationOptions {
  events: EventEmitter;
  rage: Required<RageTapOptions> | false;
  dead: Required<DeadTapOptions> | false;
  /** UI commits so far (`commits.ts`), and whether that count means anything yet. */
  commits: { count(): number; live(): boolean };
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface TapFrustration {
  /** Every finished touch, in order. */
  onTap(tap: Tap): void;
  /** Something answered: a navigation, a request, the app leaving the foreground. */
  responded(): void;
  /** Ends a pending burst (uninstall). */
  dispose(): void;
}

interface Burst {
  first: Tap;
  last: number;
  count: number;
  timer: unknown;
}

interface Pending {
  tap: Tap;
  commits: number;
  answered: boolean;
}

/**
 * Rage and dead taps (spec C6), next to `ui.tap`:
 *
 * - `ouo.rage_click`: `threshold` taps (gesture `tap`) on the same target, or within `radiusPt`
 *   of the first, within `windowMs` of the first; one event per burst, stamped at its first tap.
 * - `ouo.dead_click`: a tap on a control after which nothing answered within `timeoutMs` of the
 *   finger lifting: no navigation, no request, no move to the background, and no UI commit. A
 *   press highlight that re-renders the control (a `Pressable` style that depends on `pressed`)
 *   is a commit, so such a control never has dead taps; a haptic or a native-driven animation
 *   alone is not, which is what `ouo-frustration={false}` on the control is for.
 *
 * Attributes are the web's (`app.widget.id`, `app.screen.coordinate.x` / `.y`, `ouo.click.count`,
 * `ouo.click.duration_ms`) with the screen as `app.screen.name` and the view type: identity only.
 */
export function createTapFrustration(opts: TapFrustrationOptions): TapFrustration {
  const { events, rage, dead, commits } = opts;
  const setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let burst: Burst | null = null;
  const pending = new Set<Pending>();

  const attrsOf = (tap: Tap): Attrs => {
    const a: Attrs = {
      "app.widget.id": tap.target,
      "app.screen.coordinate.x": Math.round(tap.x),
      "app.screen.coordinate.y": Math.round(tap.y),
    };
    if (tap.viewType) a["ouo.ui.view_type"] = tap.viewType;
    if (tap.screen) a["app.screen.name"] = tap.screen;
    return a;
  };
  const where = (tap: Tap): string => `${tap.target}${tap.viewType && tap.viewType !== tap.target ? ` (${tap.viewType})` : ""}${tap.screen ? ` on ${tap.screen}` : ""}`;

  const endBurst = (): void => {
    const b = burst;
    burst = null;
    if (!b || !rage) return;
    if (b.timer !== null) clearTimer(b.timer);
    if (b.count < rage.threshold) return;
    const duration = b.last - b.first.at;
    events.emit(RAGE_CLICK_EVENT, { ...attrsOf(b.first), "ouo.click.count": b.count, "ouo.click.duration_ms": duration }, "warn", b.first.at, {
      body: `Rage tap on ${where(b.first)}: ${b.count} taps in ${(duration / 1000).toFixed(1)} s`,
    });
  };

  const onRage = (tap: Tap): void => {
    if (!rage) return;
    const b = burst;
    const near = b && (b.first.target === tap.target || Math.hypot(b.first.x - tap.x, b.first.y - tap.y) <= rage.radiusPt);
    if (b && near && tap.at - b.first.at <= rage.windowMs) {
      b.count += 1;
      b.last = tap.at;
      return;
    }
    endBurst();
    const next: Burst = { first: tap, last: tap.at, count: 1, timer: null };
    next.timer = setTimer(() => {
      if (burst === next) endBurst();
    }, rage.windowMs);
    burst = next;
  };

  const onDead = (tap: Tap): void => {
    if (!dead || !commits.live() || !tap.viewType || !CONTROL_TYPES.has(tap.viewType)) return;
    const p: Pending = { tap, commits: commits.count(), answered: false };
    pending.add(p);
    setTimer(() => {
      pending.delete(p);
      if (p.answered || commits.count() !== p.commits) return;
      events.emit(DEAD_CLICK_EVENT, attrsOf(tap), "warn", tap.at, { body: `Dead tap on ${where(tap)}` });
    }, dead.timeoutMs);
  };

  return {
    onTap(tap: Tap): void {
      if (tap.optedOut) return;
      if (tap.gesture !== "tap") {
        endBurst();
        return;
      }
      onRage(tap);
      onDead(tap);
    },
    responded(): void {
      for (const p of pending) p.answered = true;
    },
    dispose(): void {
      endBurst();
    },
  };
}
