// For generate-sessions only. Launched with `-journey product-1,add,cart,pay -pace 900`, the app
// walks that shopper's journey through the same navigation and cart code your fingers use, one
// step every `pace` ms, then sends what the SDK holds. Steps: product-<id>, add, cart, pay, back
// (anything else: stay). iOS puts launch arguments in the user defaults, which React Native's
// `Settings` reads. The app opens on Products, so every journey starts there.
import { createNavigationContainerRef } from "@react-navigation/native";
import { useEffect, useRef } from "react";
import { Settings } from "react-native";
import { checkout, getProducts, type Product } from "./api";
import { useCart } from "./cart";
import type { Routes } from "./routes";
import { rum } from "./rum";

export const navigationRef = createNavigationContainerRef<Routes>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function JourneyRunner() {
  const cart = useCart();
  const cartRef = useRef(cart);
  cartRef.current = cart;

  useEffect(() => {
    const steps: unknown = Settings.get("journey");
    if (typeof steps !== "string") return;
    const pace = Number(Settings.get("pace") ?? 1000);
    (async () => {
      while (!navigationRef.isReady()) await sleep(50);
      const products = await getProducts();
      let product: Product | undefined;
      for (const step of steps.split(",")) {
        await sleep(pace);
        if (step === "back") navigationRef.goBack();
        else if (step === "cart") navigationRef.navigate("Cart");
        else if (step === "add" && product) cartRef.current.add(product);
        else if (step === "pay") await checkout(cartRef.current.lines);
        else if (step.startsWith("product-")) {
          product = products.find((p) => p.id === Number(step.slice("product-".length)));
          if (product) navigationRef.navigate("Product", { product });
        }
      }
      await sleep(pace);
      await rum.flush();
    })();
  }, []);
  return null;
}
