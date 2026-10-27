import { useEffect, useState } from "react";
import { API, rum } from "./rum";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [card, setCard] = useState({ name: "", email: "", password: "", number: "" });
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`).then((r) => r.json()).then(setProducts);
  }, []);

  const field = (key) => (e) => setCard({ ...card, [key]: e.target.value });

  // Dead click on purpose: the handler does nothing, so no DOM change and no request follow.
  function applyCoupon() {}

  // Slow on purpose: the API takes 3 s and the button shows nothing meanwhile, so people click
  // again and again. Three clicks within a second make a rage click.
  async function trackOrder() {
    const res = await fetch(`${API}/api/orders/track`);
    setMessage((await res.json()).status);
  }

  async function checkout(e) {
    e.preventDefault();
    // Only the last four digits leave the browser; the card number itself is masked in the replay.
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id), cardLast4: card.number.slice(-4) }),
    });
    if (!res.ok) {
      // The SDK already records `http.request.failed` (the session becomes errored); captureError
      // adds an exception with a stack, on the same trace, so the replay links to it.
      rum.captureError(new Error(`checkout failed: ${(await res.json()).error}`));
      setMessage("Payment failed, try another card");
      return;
    }
    const data = await res.json();
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>

      {/* ouo-block: the element is not recorded at all; the replay shows an empty box its size. */}
      <aside className="ouo-block" style={{ background: "#fde68a", padding: 8 }}>
        Partner offer for customer #48213: 20% off with code PARTNER20
      </aside>

      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} (${p.price}) <button onClick={() => setCart([...cart, p])}>Add</button>
          </li>
        ))}
      </ul>
      <p>
        Cart: {cart.length} item(s) <button onClick={applyCoupon}>Apply coupon</button>{" "}
        <button onClick={trackOrder}>Track my order</button>
      </p>

      {/* Inputs: masked because of maskAllInputs. type="password" is masked by rrweb in any case. */}
      <form onSubmit={checkout} style={{ display: "grid", gap: 6 }}>
        <input placeholder="name on card" value={card.name} onChange={field("name")} />
        <input placeholder="email" value={card.email} onChange={field("email")} />
        <input type="password" placeholder="account password" value={card.password} onChange={field("password")} />
        <input placeholder="card number" autoComplete="cc-number" value={card.number} onChange={field("number")} />
        <button disabled={!cart.length}>Checkout</button>
      </form>

      {/* ouo-mask: text that is not an input is recorded as asterisks of the same length. */}
      <p>
        Shipping to <span className="ouo-mask">{card.name || "Jane Doe, 12 Baker Street"}</span>
      </p>
      <p>{message}</p>
    </main>
  );
}
