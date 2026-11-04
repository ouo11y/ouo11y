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

/**
 * Shown while consent is pending (`?consent=pending`): until a choice the SDK stores nothing in
 * localStorage or IndexedDB and sends nothing (@ouo11y/browser README, "Consent"). A real app
 * keeps the choice in its consent manager and passes it to `initRUM` on the next load.
 */
function ConsentBanner() {
  const [status, setStatus] = useState(rum.getConsent().status);
  if (status !== "pending") return null;
  const choose = (telemetry: boolean, replay: boolean) => {
    void rum.setConsent({ telemetry, replay }).then(() => setStatus(rum.getConsent().status));
  };
  return (
    <aside className="consent ouo-unmask" aria-label="Consent" data-testid="consent-banner">
      <span>This store records how the site performs (sessions, errors, a masked replay) once you agree.</span>
      <button type="button" className="btn btn-small" data-testid="consent-all" onClick={() => choose(true, true)}>
        Accept all
      </button>
      <button type="button" className="btn btn-small" data-testid="consent-telemetry" onClick={() => choose(true, false)}>
        No replay
      </button>
      <button type="button" className="btn btn-small" data-testid="consent-decline" onClick={() => choose(false, false)}>
        Decline
      </button>
    </aside>
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
        <Link to="/" className="brand ouo-unmask">
          web-store
        </Link>
        <nav className="nav ouo-unmask">
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
      <ConsentBanner />
      {!onChaosPage && (
        <>
          <button
            type="button"
            className="chaos-fab ouo-unmask"
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
