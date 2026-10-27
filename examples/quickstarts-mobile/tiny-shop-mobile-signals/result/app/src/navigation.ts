import { createNavigationContainerRef } from "@react-navigation/native";
import type { Product } from "./api";

export type RootStackParamList = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

let markReady: () => void = () => {};
/** Resolves once the navigation container is ready (App.tsx onReady). */
export const navigationReady = new Promise<void>((resolve) => (markReady = resolve));
export const setNavigationReady = () => markReady();
