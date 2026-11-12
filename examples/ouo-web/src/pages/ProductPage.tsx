import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, formatPrice, getProduct, type Product } from "../api";
import { useCart } from "../cart";
import { ProductArt } from "../components/ProductCard";

export function ProductPage() {
  const { id = "" } = useParams();
  const { add } = useCart();
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [status, setStatus] = useState<"idle" | "adding" | "added" | "failed">("idle");

  useEffect(() => {
    let cancelled = false;
    setProduct(null);
    setError(null);
    getProduct(id)
      .then((p) => {
        if (!cancelled) setProduct(p);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) setError("This product does not exist.");
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const onAdd = async () => {
    if (!product) return;
    setStatus("adding");
    try {
      await add(product.id, qty);
      setStatus("added");
    } catch {
      setStatus("failed");
    }
  };

  if (error) {
    return (
      <section className="page">
        <p className="alert alert-error">{error}</p>
        <Link to="/">Back to products</Link>
      </section>
    );
  }
  if (!product) return <p className="muted page">Loading…</p>;

  return (
    <section className="page product-detail" data-ouo-unmask="">
      <ProductArt product={product} large />
      <div>
        <p className="crumbs">
          <Link to="/">Products</Link> / {product.id}
        </p>
        <h1>{product.name}</h1>
        <p className="price price-large">{formatPrice(product.price)}</p>
        <p className="muted">
          Lightweight, durable, and tested on the trail. Ships in 2 business days.
        </p>
        <div className="row">
          <label htmlFor="qty">Qty</label>
          <input
            id="qty"
            type="number"
            min={1}
            max={20}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          />
          <button type="button" className="btn btn-primary" onClick={onAdd} disabled={status === "adding"}>
            {status === "adding" ? "Adding…" : "Add to cart"}
          </button>
        </div>
        {status === "added" && (
          <p className="alert alert-ok">
            Added. <Link to="/cart">View cart</Link>
          </p>
        )}
        {status === "failed" && <p className="alert alert-error">Could not add to cart.</p>}
      </div>
    </section>
  );
}
