// "Account": a fake login with two users, logout, End session and the short-timeout switch.
// Each button is one SDK call; the comments say what it does to the session.
import { useState } from "react";
import { rum, SHORT_TIMEOUT_KEY, shortTimeout } from "./rum";
import { box, h2 } from "./SessionPanel";

// Two fake accounts. A real app calls rum.setUser after its own login succeeds.
const USERS = ["alice@example.com", "bob@example.com"];

export default function AccountPanel({ onMessage }) {
  const [loggedIn, setLoggedIn] = useState(null); // the shop's own idea of who is logged in

  function login(email) {
    // Anonymous -> alice: the same session, now with user.id = alice (a login during the visit).
    // alice -> bob: the session ends with `user_change` and a new one starts, previous_id = alice's.
    rum.setUser({ id: email });
    setLoggedIn(email);
    onMessage(`Logged in as ${email}`);
  }

  function logout() {
    // Back to a fresh anonymous id, in a new session (`user_change`).
    rum.clearUser();
    setLoggedIn(null);
    onMessage("Logged out");
  }

  function endSession() {
    // `manual`: the session ends now; the next click, request or navigation starts the next one.
    rum.endSession();
    onMessage("Session ended. Click anything to start the next one.");
  }

  function toggleShortTimeout() {
    localStorage.setItem(SHORT_TIMEOUT_KEY, shortTimeout ? "0" : "1");
    location.reload(); // the timeout is an init option
  }

  return (
    <section style={box}>
      <h2 style={h2}>Account</h2>
      <p style={{ color: "#666", margin: "4px 0" }}>{loggedIn ? `Logged in as ${loggedIn}` : "Not logged in"}</p>
      {USERS.map((u) => (
        <button key={u} onClick={() => login(u)} disabled={loggedIn === u}>
          {loggedIn ? `Switch to ${u}` : `Log in as ${u}`}
        </button>
      ))}{" "}
      <button onClick={logout} disabled={!loggedIn}>
        Log out
      </button>{" "}
      <button onClick={endSession}>End session</button>
      <p>
        <label>
          <input type="checkbox" checked={shortTimeout} onChange={toggleShortTimeout} /> Short inactivity timeout
          (1 min, reloads the page)
        </label>
      </p>
    </section>
  );
}
