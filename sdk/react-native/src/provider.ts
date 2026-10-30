import { createElement, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { getRUM } from "./instance";
import { gestureOf, touchedComponent, type FiberLike, type Gesture, type TouchedComponent } from "./taps";
import type { RUM } from "./types";

export interface RUMProviderProps {
  /** Defaults to the instance created by `initRUM`. */
  rum?: RUM;
  children?: ReactNode;
}

/** The touch fields the provider reads: the touched host view's fiber and the position. */
interface TouchEventLike {
  _targetInst?: FiberLike;
  nativeEvent?: { pageX?: number; pageY?: number };
}

/** What `RUMProvider` hands the instance when a touch ends (`RUMInternal._trackTouch`). */
export type TrackTouch = (touched: TouchedComponent, gesture: Gesture, startedAt: number) => void;

interface OpenTouch {
  touched: TouchedComponent | undefined;
  x: number;
  y: number;
  at: number;
}

// The touch in progress, per instance: it outlives a re-render between start and end (a long
// press that changes state), and a nested provider's touch is not counted twice.
const openTouches = new WeakMap<RUM, OpenTouch>();
const STALE_TOUCH_MS = 10_000;

/**
 * Wrap the app root in this to count touches as session activity and record each touch as a
 * `ui.tap` timeline event when the finger lifts (`timeline.taps`): the touched component, its view
 * type and the gesture (`tap`, `long_press`, `swipe`). It is a plain flex: 1 `View`; touch events
 * bubble through it without being consumed.
 */
export function RUMProvider(props: RUMProviderProps): ReactElement {
  const rum = props.rum ?? getRUM();
  const onTouchStart = (event: object): void => {
    if (!rum) return;
    rum.recordActivity();
    // Further fingers of a multi-touch are activity only; a touch whose end never came (its
    // view unmounted) does not block the next ones.
    const open = openTouches.get(rum);
    if (open && Date.now() - open.at < STALE_TOUCH_MS) return;
    // React Native's synthetic touch event carries the touched host view's fiber as `_targetInst`.
    const e = event as TouchEventLike | undefined;
    const touched = touchedComponent(e?._targetInst, (f) => (f.memoizedProps as { onTouchStart?: unknown } | undefined)?.onTouchStart === onTouchStart);
    openTouches.set(rum, { touched, x: e?.nativeEvent?.pageX ?? 0, y: e?.nativeEvent?.pageY ?? 0, at: Date.now() });
  };
  // Also the cancel: a scroll view that takes a touch over cancels it, at the end of a swipe.
  const onTouchEnd = (event: object): void => {
    const t = rum && openTouches.get(rum);
    if (!rum || !t) return;
    openTouches.delete(rum);
    if (!t.touched) return;
    const end = (event as TouchEventLike | undefined)?.nativeEvent;
    const gesture = gestureOf(Date.now() - t.at, (end?.pageX ?? t.x) - t.x, (end?.pageY ?? t.y) - t.y);
    (rum as { _trackTouch?: TrackTouch })._trackTouch?.(t.touched, gesture, t.at);
  };
  return createElement(
    View,
    {
      style: { flex: 1 },
      onTouchStart,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
      // Runs on mount: the app start ends at the frame after the root rendered (vitals).
      ref: (node: unknown) => {
        if (node) (rum as { _rootMounted?: () => void } | undefined)?._rootMounted?.();
      },
    },
    props.children,
  );
}
