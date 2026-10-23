import { Link } from "react-router-dom";
import { formatPrice } from "../api";
import { useCart } from "../cart";

export function CartPage() {
  const { cart, loading, error, add } = useCart();

  if (error) return <p className="alert alert-error page">Could not load cart: {error}</p>;
  if (!cart) return <p className="muted page">Loading cart…</p>;

  return (
    <section className="page">
      <h1>Cart</h1>
      {cart.items.length === 0 ? (
        <p className="muted">
          Your cart is empty. <Link to="/">Browse products</Link>
        </p>
      ) : (
        <>
          <table className="table" data-testid="cart-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Qty</th>
                <th>Unit</th>
                <th>Subtotal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cart.items.map((item) => (
                <tr key={item.productId}>
                  <td>
                    <Link to={`/products/${item.productId}`}>{item.name}</Link>
                  </td>
                  <td>
                    <button type="button" className="btn btn-small" onClick={() => void add(item.productId, -1)} aria-label={`Remove one ${item.name}`}>
                      −
                    </button>{" "}
                    {item.qty}{" "}
                    <button type="button" className="btn btn-small" onClick={() => void add(item.productId, 1)} aria-label={`Add one ${item.name}`}>
                      +
                    </button>
                  </td>
                  <td>{formatPrice(item.unitPrice)}</td>
                  <td>{formatPrice(item.subtotal)}</td>
                  <td>
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => void add(item.productId, -item.qty)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total</td>
                <td colSpan={2}>
                  <strong>{formatPrice(cart.total)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
          <div className="row">
            <Link to="/checkout" className="btn btn-primary">
              Checkout
            </Link>
            {loading && <span className="muted">updating…</span>}
          </div>
        </>
      )}
    </section>
  );
}
