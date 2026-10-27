// The cart, in memory: a React context every screen can read.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Product } from "./api";

type Line = { product: Product; qty: number };
type Cart = {
  lines: Line[];
  count: number;
  total: number;
  add: (product: Product) => void;
  clear: () => void;
};

const CartContext = createContext<Cart | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<Line[]>([]);
  const cart = useMemo<Cart>(
    () => ({
      lines,
      count: lines.reduce((n, l) => n + l.qty, 0),
      total: lines.reduce((t, l) => t + l.qty * l.product.price, 0),
      add: (product) =>
        setLines((ls) =>
          ls.some((l) => l.product.id === product.id)
            ? ls.map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + 1 } : l))
            : [...ls, { product, qty: 1 }],
        ),
      clear: () => setLines([]),
    }),
    [lines],
  );
  return <CartContext.Provider value={cart}>{children}</CartContext.Provider>;
}

export function useCart(): Cart {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart outside CartProvider");
  return cart;
}
