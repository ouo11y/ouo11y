import { useEffect, useState } from "react";
import { API, rum, SHORT_TIMEOUT_KEY, shortTimeout } from "./rum";
import { storedSession } from "./session";

// Two fake accounts. A real app calls rum.setUser after its own login succeeds.
const USERS = ["alice@example.com", "bob@example.com"];

export default function App() {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);
  const [loggedIn, setLoggedIn] = useState(null); // the shop's own idea of who is logged in
  const [message, setMessage] = useState("");
  const [stored, setStored] = useState(storedSession());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    fetch(`${API}/api/products`)
      .then((r) => r.json())
      .then(setProducts);
  }, []);

  // Refresh the "Your session" panel every second (reads localStorage only, see session.js).
  useEffect(() => {
    const t = setInterval(() => {
      setStored(storedSession());
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---- the session lifecycle ----

  function login(email) {
    // Anonymous -> alice: the same session, now with user.id = alice (a login during the visit).
    // alice -> bob: the session ends with `user_change` and a new one starts, previous_id = alice's.
    rum.setUser({ id: email });
    setLoggedIn(email);
    setMessage(`Logged in as ${email}`);
  }

  function logout() {
    // Back to a fresh anonymous id, in a new session (`user_change`).
    rum.clearUser();
    setLoggedIn(null);
    setMessage("Logged out");
  }

  function endSession() {
    // `manual`: the session ends now; the next click, request or navigation starts the next one.
    rum.endSession();
    setMessage("Session ended. Click anything to start the next one.");
  }

  function toggleShortTimeout() {
    localStorage.setItem(SHORT_TIMEOUT_KEY, shortTimeout ? "0" : "1");
    location.reload(); // the timeout is an init option
  }

  // ---- break it ----

  function handledError() {
    // Caught and reported: the session becomes `errored`, the user carries on.
    try {
      JSON.parse("{ not json");
    } catch (err) {
      rum.captureError(err, { "app.action": "parse saved cart" });
      setMessage("Handled error reported: session is now errored");
    }
  }

  function uncaughtError() {
    // Thrown out of an event handler and never caught: the SDK's `error` listener reports it as
    // fatal and the session becomes `crashed`. On the web the page keeps working and the session
    // does not end.
    setTimeout(() => {
      throw new Error("Uncaught: cart total is NaN");
    });
    setMessage("Uncaught error thrown: session is now crashed");
  }

  async function failedRequest() {
    // A 500 from the API: the SDK records `http.request.failed`, the session becomes `errored`.
    const res = await fetch(`${API}/api/broken`);
    setMessage(`GET /api/broken answered ${res.status}: session is now errored`);
  }

  // ---- the shop ----

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

  const { session, user, device } = stored;
  const ended = session?.endedAt;
  const idleFor = session ? Math.round((now - session.lastActivity) / 1000) : 0;

  return (
    <main style={{ fontFamily: "sans-serif", maxWidth: 640, margin: "32px auto", lineHeight: 1.5 }}>
      <h1>Tiny Shop</h1>

      <section style={box}>
        <h2 style={h2}>Your session</h2>
        <table>
          <tbody>
            <Row k="session.id" v={session?.id} />
            <Row k="state" v={ended ? `ended (${session.endReason}), your next click starts a new one` : `active, idle ${idleFor} s`} />
            <Row k="session.previous_id" v={session?.previousId || "none (first session on this device)"} />
            <Row k="user.id" v={user ? `${user.id}${user.anonymous ? " (anonymous)" : ""}` : ""} />
            <Row k="device.id" v={device?.id} />
            <Row k="inactivity timeout" v={shortTimeout ? "1 min (short)" : "30 min (default)"} />
          </tbody>
        </table>
      </section>

      <section style={box}>
        <h2 style={h2}>Account</h2>
        <p style={muted}>{loggedIn ? `Logged in as ${loggedIn}` : "Not logged in"}</p>
        {USERS.map((u) => (
          <button key={u} onClick={() => login(u)} disabled={loggedIn === u}>
            {loggedIn ? `Switch to ${u}` : `Log in as ${u}`}
          </button>
        ))}{" "}
        <button onClick={logout} disabled={!loggedIn}>Log out</button>{" "}
        <button onClick={endSession}>End session</button>
        <p>
          <label>
            <input type="checkbox" checked={shortTimeout} onChange={toggleShortTimeout} /> Short inactivity
            timeout (1 min, reloads the page)
          </label>
        </p>
      </section>

      <section style={box}>
        <h2 style={h2}>Break it</h2>
        <button onClick={handledError}>Handled error</button>{" "}
        <button onClick={uncaughtError}>Uncaught error</button>{" "}
        <button onClick={failedRequest}>Failed request</button>
      </section>

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

      <p data-testid="message">{message}</p>
    </main>
  );
}

function Row({ k, v }) {
  return (
    <tr>
      <td style={{ paddingRight: 16 }}>
        <code>{k}</code>
      </td>
      <td>
        <code>{v}</code>
      </td>
    </tr>
  );
}

const box = { border: "1px solid #ccc", borderRadius: 6, padding: "8px 16px", marginBottom: 16 };
const h2 = { fontSize: 18, margin: "8px 0" };
const muted = { color: "#666", margin: "4px 0" };
