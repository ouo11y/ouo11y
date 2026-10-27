// The screens and their parameters, and a promise that resolves when navigation is ready.
import { createNavigationContainerRef } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Product } from "./api";

export type RootStackParamList = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Resolved by App.tsx once Sentry's first navigation transaction has started. The product list
// loads on mount, a few milliseconds earlier: api.ts waits for this so that request is part of
// the first screen's transaction.
let markReady: () => void = () => {};
export const navigationReady = new Promise<void>((resolve) => {
  markReady = resolve;
});
export const setNavigationReady = (): void => markReady();
