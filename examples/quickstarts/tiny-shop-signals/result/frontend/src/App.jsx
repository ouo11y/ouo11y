import { useEffect, useState } from "react";
import { log } from "./log";
import { API } from "./rum";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`)
      .then((r) => r.json())
      .then((list) => {
        setProducts(list);
        log.info("catalog loaded", { "app.products.count": list.length });
      });
  }, []);

  function view(p) {
    setMessage(`${p.name}: freshly made, $${p.price}`);
    log.info("product viewed", { "product.id": p.id, "product.name": p.name });
  }

  function addToCart(p) {
    setCart([...cart, p]);
    log.info("added to cart", { "product.id": p.id, "app.cart.items": cart.length + 1 });
  }

  async function checkout() {
    // Validation failure: a warning, nothing is sent to the API.
    if (!email.includes("@")) {
      log.warn("checkout failed validation", { "app.validation.field": "email" });
      setMessage("Enter an email address first");
      return;
    }
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id) }),
    });
    if (!res.ok) {
      // The API fails one checkout in three. The SDK already records `http.request.failed`
      // (the session becomes errored); this log says what it meant for the shopper.
      log.error("checkout failed", { "http.response.status_code": res.status, "app.cart.items": cart.length });
      setMessage("Payment failed, try again");
      return;
    }
    const data = await res.json();
    log.info("order placed", { "app.order.id": data.orderId, "app.cart.items": cart.length });
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <ul>
        {products.map((p) => (
          <li key={p.id}>
            {p.name} (${p.price}) <button onClick={() => view(p)}>View</button>{" "}
            <button onClick={() => addToCart(p)}>Add</button>
          </li>
        ))}
      </ul>
      <p>Cart: {cart.length} item(s)</p>
      <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />{" "}
      <button onClick={checkout} disabled={!cart.length}>Checkout</button>
      <p>{message}</p>
    </main>
  );
}
