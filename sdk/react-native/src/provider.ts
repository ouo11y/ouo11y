import { createElement, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { getRUM } from "./instance";
import type { RUM } from "./types";

export interface RUMProviderProps {
  /** Defaults to the instance created by `initRUM`. */
  rum?: RUM;
  children?: ReactNode;
}

/**
 * Wrap the app root in this to count touches as session activity. It is a plain
 * flex: 1 `View`; touch events bubble through it without being consumed.
 */
export function RUMProvider(props: RUMProviderProps): ReactElement {
  const rum = props.rum ?? getRUM();
  return createElement(
    View,
    {
      style: { flex: 1 },
      onTouchStart: () => rum?.recordActivity(),
    },
    props.children,
  );
}
