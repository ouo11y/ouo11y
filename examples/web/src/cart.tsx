import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { addToCart as apiAddToCart, getCart, type Cart } from "./api";
import { rum } from "./rum";

interface CartState {
  cart: Cart | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (productId: string, qty: number) => Promise<void>;
  clearLocal: () => void;
}

const CartContext = createContext<CartState | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCart(await getCart());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const add = useCallback(async (productId: string, qty: number) => {
    const next = await apiAddToCart(productId, qty);
    setCart(next);
    if (qty > 0) rum.addEvent("add_to_cart", { product_id: productId, qty });
  }, []);

  const clearLocal = useCallback(() => setCart(null), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ cart, loading, error, refresh, add, clearLocal }),
    [cart, loading, error, refresh, add, clearLocal],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
