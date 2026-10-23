import { createElement, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { getRUM } from "./instance";
import { touchedComponent, type FiberLike } from "./taps";
import type { RUM } from "./types";

export interface RUMProviderProps {
  /** Defaults to the instance created by `initRUM`. */
  rum?: RUM;
  children?: ReactNode;
}

/**
 * Wrap the app root in this to count touches as session activity and record each tap as a
 * `ui.tap` timeline event with the touched component (`timeline.taps`). It is a plain
 * flex: 1 `View`; touch events bubble through it without being consumed.
 */
export function RUMProvider(props: RUMProviderProps): ReactElement {
  const rum = props.rum ?? getRUM();
  // React Native's synthetic touch event carries the touched host view's fiber as `_targetInst`.
  const onTouchStart = (event: object): void => {
    if (!rum) return;
    const touched = touchedComponent((event as { _targetInst?: FiberLike } | undefined)?._targetInst, (f) => (f.memoizedProps as { onTouchStart?: unknown } | undefined)?.onTouchStart === onTouchStart);
    if (touched) rum.trackTap(touched.target, touched.path);
    else rum.recordActivity();
  };
  return createElement(
    View,
    {
      style: { flex: 1 },
      onTouchStart,
    },
    props.children,
  );
}
