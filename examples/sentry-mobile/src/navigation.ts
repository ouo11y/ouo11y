import { createNavigationContainerRef } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type RootStackParamList = {
  Home: undefined;
  Product: { id: string };
  Cart: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

let markReady: () => void = () => {};
/**
 * Resolves once the container is ready and Sentry's first navigation span has started (App.tsx
 * onReady). Requests the first screen starts on mount wait for it (src/api.ts), so they belong to
 * that span instead of starting a root span of their own, which the SDK would then make the app
 * start transaction.
 */
export const navigationReady = new Promise<void>((resolve) => {
  markReady = resolve;
});
export const setNavigationReady = (): void => markReady();

/** Navigate from outside React (deep links, actions). Returns false before the container is ready. */
export function goTo(screen: string, params: Record<string, string> = {}): boolean {
  if (!navigationRef.isReady()) return false;
  switch (screen.toLowerCase()) {
    case "home":
      navigationRef.navigate("Home");
      return true;
    case "product":
      navigationRef.navigate("Product", { id: params.id ?? "p-1001" });
      return true;
    case "cart":
      navigationRef.navigate("Cart");
      return true;
    case "back":
      if (navigationRef.canGoBack()) navigationRef.goBack();
      return true;
    default:
      return false;
  }
}
