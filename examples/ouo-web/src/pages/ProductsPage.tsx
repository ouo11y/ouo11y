import { useEffect, useState } from "react";
import { getProducts, type Product } from "../api";
import { ProductCard } from "../components/ProductCard";

export function ProductsPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProducts()
      .then((p) => {
        if (!cancelled) setProducts(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="page" data-ouo-unmask="">
      <h1>Products</h1>
      {error && <p className="alert alert-error">Could not load products: {error}</p>}
      {!products && !error && <p className="muted">Loading products…</p>}
      {products && (
        <div className="grid" data-testid="product-grid">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      )}
    </section>
  );
}
