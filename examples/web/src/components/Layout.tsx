import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useCart } from "../cart";
import { config, rum, setUser, storedUserId } from "../rum";
import { ChaosPanel } from "./ChaosPanel";

function UserControl() {
  const [value, setValue] = useState(storedUserId() ?? "");
  const { refresh } = useCart();
  const current = storedUserId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setUser(value);
    void refresh(); // carts are per user on the backend
  };

  return (
    <form className="user-control" onSubmit={submit} aria-label="User">
      <label htmlFor="user-id">User</label>
      <input
        id="user-id"
        name="user-id"
        placeholder="user-42"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
      />
      <button type="submit" className="btn btn-small">
        {current ? "Update" : "Set user"}
      </button>
    </form>
  );
}

function SessionFooter() {
  const [session, setSession] = useState({ id: rum.session.id(), user: rum.session.userId() });
  useEffect(() => {
    const t = setInterval(() => setSession({ id: rum.session.id(), user: rum.session.userId() }), 2000);
    return () => clearInterval(t);
  }, []);
  return (
    <footer className="footer">
      <span>
        session <code data-testid="session-id">{session.id}</code>
      </span>
      <span>
        user <code data-testid="user-id">{session.user ?? "anonymous"}</code>
      </span>
      <span>
        web-store v{config.appVersion}
        {config.stub ? " (rum stub)" : ""}
      </span>
    </footer>
  );
}

export function Layout() {
  const { cart } = useCart();
  const [chaosOpen, setChaosOpen] = useState(false);
  const location = useLocation();
  const onChaosPage = location.pathname === "/chaos";

  return (
    <div className="app">
      <header className="header">
        <Link to="/" className="brand">
          web-store
        </Link>
        <nav className="nav">
          <NavLink to="/">Products</NavLink>
          <NavLink to="/cart">
            Cart{cart && cart.itemCount > 0 ? ` (${cart.itemCount})` : ""}
          </NavLink>
          <NavLink to="/chaos">Chaos</NavLink>
        </nav>
        <UserControl />
      </header>
      <main className="main">
        <Outlet />
      </main>
      <SessionFooter />
      {!onChaosPage && (
        <>
          <button
            type="button"
            className="chaos-fab"
            aria-expanded={chaosOpen}
            onClick={() => setChaosOpen((o) => !o)}
            title="Chaos panel"
          >
            {chaosOpen ? "close" : "chaos"}
          </button>
          {chaosOpen && (
            <aside className="chaos-drawer" aria-label="Chaos panel">
              <ChaosPanel compact />
            </aside>
          )}
        </>
      )}
    </div>
  );
}
