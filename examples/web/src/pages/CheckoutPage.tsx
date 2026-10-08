import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, checkout, formatPrice, type PaymentMethod } from "../api";
import { useCart } from "../cart";
import { rum } from "../rum";

export function CheckoutPage() {
  const { cart, refresh } = useCart();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [card, setCard] = useState("");
  const [promo, setPromo] = useState("");
  const [showPromo, setShowPromo] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const empty = !cart || cart.items.length === 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (empty) return;
    setSubmitting(true);
    setError(null);
    rum.addEvent("checkout_submitted", {
      payment_method: paymentMethod,
      item_count: cart.itemCount,
      total: cart.total,
    });
    try {
      const lines = cart.items;
      const order = await checkout({ paymentMethod });
      await refresh();
      navigate(`/order/${order.orderId}`, { state: { ...order, lines } });
    } catch (err) {
      if (err instanceof ApiError) setError(`Payment failed: ${err.message}`);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="page checkout">
      <h1>Checkout</h1>
      {empty ? (
        <p className="muted">
          Your cart is empty. <Link to="/">Browse products</Link>
        </p>
      ) : (
        <div className="checkout-grid">
          <form className="form" onSubmit={submit} data-testid="checkout-form">
            <label>
              Name
              <input name="name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </label>
            <label>
              Email
              <input
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label>
              Card number
              <input
                name="card"
                className="ouo-mask"
                inputMode="numeric"
                placeholder="4242 4242 4242 4242"
                value={card}
                onChange={(e) => setCard(e.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <label>
              Payment method
              <select
                name="paymentMethod"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              >
                <option value="card">card</option>
                <option value="broken-card">broken-card (always fails with 500)</option>
              </select>
            </label>
            <button type="button" className="link-button" onClick={() => setShowPromo((s) => !s)}>
              {showPromo ? "Hide promo code" : "Have a promo code?"}
            </button>
            <label className="ouo-block" hidden={!showPromo}>
              Promo code
              <input name="promo" value={promo} onChange={(e) => setPromo(e.target.value)} autoComplete="off" />
            </label>
            {error && <p className="alert alert-error">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Placing order…" : `Pay ${formatPrice(cart.total)}`}
            </button>
          </form>
          <aside className="card summary">
            <h2>Order summary</h2>
            <ul>
              {cart.items.map((i) => (
                <li key={i.productId}>
                  {i.qty} × {i.name} <span>{formatPrice(i.subtotal)}</span>
                </li>
              ))}
            </ul>
            <p className="total">
              Total <strong>{formatPrice(cart.total)}</strong>
            </p>
          </aside>
        </div>
      )}
    </section>
  );
}
