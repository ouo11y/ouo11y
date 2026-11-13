import { createElement, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { guard } from "./guard";
import { getRUM } from "./instance";
import { touchedComponent, type TouchEventLike, type TouchedComponent } from "./taps";
import type { RUM } from "./types";

export interface RUMProviderProps {
  /** Defaults to the instance created by `initRUM`. */
  rum?: RUM;
  children?: ReactNode;
}

/** `RUMInternal`'s touch hooks: the instance keeps the touch from start to end. */
interface TouchHooks {
  _touchStart?(event: TouchEventLike, touched: TouchedComponent | undefined): void;
  _touchEnd?(event: TouchEventLike): void;
}

/**
 * Wrap the app root in this to count touches as session activity and record each touch as a
 * `ui.tap` timeline event when the finger lifts (`timeline.taps`): the touched component, its view
 * type, the gesture (`tap`, `long_press`, `swipe`) and the screen it started on. It is a plain
 * flex: 1 `View`; touch events bubble through it without being consumed.
 */
export function RUMProvider(props: RUMProviderProps): ReactElement {
  const rum = props.rum ?? getRUM();
  const hooks = rum as TouchHooks | undefined;
  // The handlers run inside the guard (ERR-1): a failure here never reaches React's event dispatch.
  const onTouchStart = guard.wrap("provider.touchStart", (event: TouchEventLike): void => {
    if (!rum) return;
    rum.recordActivity();
    // React Native's synthetic touch event carries the touched host view's fiber as `_targetInst`.
    const touched = touchedComponent(event?._targetInst, (f) => (f.memoizedProps as { onTouchStart?: unknown } | undefined)?.onTouchStart === onTouchStart);
    hooks?._touchStart?.(event, touched);
  });
  // Also the cancel: a scroll view that takes a touch over cancels it, at the end of a swipe.
  const onTouchEnd = guard.wrap("provider.touchEnd", (event: TouchEventLike): void => hooks?._touchEnd?.(event));
  return createElement(
    View,
    {
      style: { flex: 1 },
      onTouchStart,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
      // Runs on mount: the app start ends at the frame after the root rendered (vitals).
      ref: guard.wrap("provider.ref", (node: unknown) => {
        if (node) (rum as { _rootMounted?: () => void } | undefined)?._rootMounted?.();
      }),
    },
    props.children,
  );
}
