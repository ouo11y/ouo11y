// The cart lives in memory, in a React context shared by the three screens.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Product } from "./api";

interface CartValue {
  items: Product[];
  add: (p: Product) => void;
  clear: () => void;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Product[]>([]);
  const value = useMemo(
    () => ({ items, add: (p: Product) => setItems((xs) => [...xs, p]), clear: () => setItems([]) }),
    [items],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart outside CartProvider");
  return cart;
}
