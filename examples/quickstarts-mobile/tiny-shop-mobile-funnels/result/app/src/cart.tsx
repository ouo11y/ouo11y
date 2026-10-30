// The cart, kept in memory and shared by the screens. Adding a product is funnel step
// `add_to_cart`: a custom event, the same whether a finger or the journey runner adds it.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { CartLine, Product } from "./api";
import { rum } from "./rum";

type Cart = { lines: CartLine[]; add: (p: Product) => void; clear: () => void };

const CartContext = createContext<Cart | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const add = (p: Product) => {
    rum.addEvent("add_to_cart", { "app.product.id": p.id, "app.product.price": p.price });
    setLines((ls) =>
      ls.some((l) => l.id === p.id) ? ls.map((l) => (l.id === p.id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { ...p, qty: 1 }]
    );
  };
  return <CartContext.Provider value={{ lines, add, clear: () => setLines([]) }}>{children}</CartContext.Provider>;
}

export function useCart(): Cart {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart outside CartProvider");
  return cart;
}
