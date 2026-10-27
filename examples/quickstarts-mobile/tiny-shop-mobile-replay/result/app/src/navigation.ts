// The screens, and a promise that resolves when the navigation container is ready.
import { createNavigationContainerRef } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Product } from "./api";

export type Screens = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};

export type ScreenProps<T extends keyof Screens> = NativeStackScreenProps<Screens, T>;

export const navigationRef = createNavigationContainerRef<Screens>();

let markReady: () => void = () => {};
/** Resolves in App.tsx's onReady, once Sentry's first screen transaction has started. */
export const navigationReady = new Promise<void>((resolve) => {
  markReady = resolve;
});
export const setNavigationReady = (): void => markReady();
