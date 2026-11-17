import { useEffect, useState } from "react";
import { recordEvent, setUser } from "./rum.js";

// Two pages, / and /cart, switched with history.pushState: no router needed.
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = (to) => {
    history.pushState(null, "", to);
    setPath(to);
  };
  return [path, go];
}

export default function App() {
  const [path, go] = usePath();
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);

  useEffect(() => {
    fetch("/products.json").then((r) => r.json()).then(setProducts);
  }, []);

  const add = (p) => {
    setCart([...cart, p]);
    recordEvent("add_to_cart", { "product.name": p.name, "product.price": p.price });
  };
  const checkout = () => {
    // A bug on purpose: a product has no `total`, so this throws a TypeError.
    alert(`Paid ${cart[0].total.toFixed(2)} €`);
  };

  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 480, margin: "40px auto" }}>
      <h1>Tiny Shop</h1>
      <nav>
        <button onClick={() => go("/")}>Products</button>{" "}
        <button onClick={() => go("/cart")}>Cart ({cart.length})</button>{" "}
        <button onClick={() => setUser("alice")}>Sign in as alice</button>
      </nav>

      {path === "/cart" ? (
        <section>
          <h2>Cart</h2>
          <ul>{cart.map((p, i) => <li key={i}>{p.name}</li>)}</ul>
          <label>
            Email <input type="email" placeholder="you@example.com" />
          </label>{" "}
          <button onClick={checkout} disabled={cart.length === 0}>Checkout</button>
        </section>
      ) : (
        <section data-ouo-unmask>
          <h2>Products</h2>
          <ul>
            {products.map((p) => (
              <li key={p.id}>
                {p.name}, {p.price} € <button onClick={() => add(p)}>Add to cart</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
