// The cart: plain React state shared by the three screens. No telemetry here.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Product } from "./api";

type Cart = { items: Product[]; add: (p: Product) => void; clear: () => void };
const CartContext = createContext<Cart | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Product[]>([]);
  const add = (p: Product) => setItems((prev) => [...prev, p]);
  const clear = () => setItems([]);
  return <CartContext.Provider value={{ items, add, clear }}>{children}</CartContext.Provider>;
}

export function useCart(): Cart {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart outside CartProvider");
  return cart;
}
