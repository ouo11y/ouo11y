// The shop, with the three session panels above it.
import { useEffect, useState } from "react";
import AccountPanel from "./AccountPanel";
import BreakItPanel from "./BreakItPanel";
import { API } from "./rum";
import SessionPanel, { box, h2 } from "./SessionPanel";

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch(`${API}/api/products`)
      .then((r) => r.json())
      .then(setProducts);
  }, []);

  async function checkout() {
    const res = await fetch(`${API}/api/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: cart.map((p) => p.id) }),
    });
    const data = await res.json();
    setMessage(`Order #${data.orderId} placed`);
    setCart([]);
  }

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 640, margin: "32px auto", lineHeight: 1.5 }}>
      <h1>Tiny Shop</h1>
      <SessionPanel />
      <AccountPanel onMessage={setMessage} />
      <BreakItPanel onMessage={setMessage} />
      <section style={box}>
        <h2 style={h2}>Shop</h2>
        <ul>
          {products.map((p) => (
            <li key={p.id}>
              {p.name} (${p.price}) <button onClick={() => setCart([...cart, p])}>Add</button>
            </li>
          ))}
        </ul>
        <p>
          Cart: {cart.length} item(s){" "}
          <button onClick={checkout} disabled={!cart.length}>
            Checkout
          </button>
        </p>
      </section>
      <p>{message}</p>
    </main>
  );
}
