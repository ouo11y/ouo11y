import { Link, useLocation, useParams } from "react-router-dom";
import { formatPrice, type CartItem, type Order } from "../api";

type OrderReceipt = Order & { lines: CartItem[] };

function isReceipt(v: unknown): v is OrderReceipt {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as OrderReceipt).orderId === "string" &&
    Array.isArray((v as OrderReceipt).lines)
  );
}

export function OrderPage() {
  const { id = "" } = useParams();
  const state: unknown = useLocation().state;
  const receipt = isReceipt(state) && state.orderId === id ? state : null;

  return (
    <section className="page">
      <h1>Thank you</h1>
      <p className="alert alert-ok" data-testid="order-id">
        Order <code>{id}</code> confirmed.
      </p>
      {receipt && (
        <div className="card summary">
          <ul>
            {receipt.lines.map((i) => (
              <li key={i.productId}>
                {i.qty} × {i.name} <span>{formatPrice(i.subtotal)}</span>
              </li>
            ))}
          </ul>
          <p className="total">
            Paid ({receipt.items} {receipt.items === 1 ? "item" : "items"}) <strong>{formatPrice(receipt.total)}</strong>
          </p>
        </div>
      )}
      <Link to="/" className="btn">
        Continue shopping
      </Link>
    </section>
  );
}
