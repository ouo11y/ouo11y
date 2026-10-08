import { Link } from "react-router-dom";
import { formatPrice, type Product } from "../api";

const hues = [12, 45, 120, 180, 220, 280, 320];

export function ProductArt({ product, large = false }: { product: Product; large?: boolean }) {
  const code = product.id.split("-").pop() ?? "0";
  const hue = hues[Number(code) % hues.length] ?? 200;
  return (
    <div
      className={large ? "product-art product-art-large" : "product-art"}
      style={{ background: `linear-gradient(135deg, hsl(${hue} 70% 60%), hsl(${hue + 40} 70% 45%))` }}
      aria-hidden="true"
    >
      {product.name.slice(0, 1)}
    </div>
  );
}

export function ProductCard({ product }: { product: Product }) {
  return (
    <Link to={`/products/${product.id}`} className="card product-card">
      <ProductArt product={product} />
      <div className="product-card-body">
        <h3>{product.name}</h3>
        <p className="price">{formatPrice(product.price)}</p>
      </div>
    </Link>
  );
}
