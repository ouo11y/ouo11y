// "Your session": what the SDK has stored, refreshed every second. Reads localStorage only (see
// session.js), so watching the panel never counts as activity.
import { useEffect, useState } from "react";
import { shortTimeout } from "./rum";
import { storedSession } from "./session";

export default function SessionPanel() {
  const [stored, setStored] = useState(storedSession());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => {
      setStored(storedSession());
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const { session, user, device } = stored;
  const idleFor = session ? Math.round((now - session.lastActivity) / 1000) : 0;
  const state = session?.endedAt
    ? `ended (${session.endReason}), your next click starts a new one`
    : `active, idle ${idleFor} s`;

  return (
    <section style={box}>
      <h2 style={h2}>Your session</h2>
      <table>
        <tbody>
          <Row k="session.id" v={session?.id} />
          <Row k="state" v={state} />
          <Row k="session.previous_id" v={session?.previousId || "none (first session on this device)"} />
          <Row k="user.id" v={user ? `${user.id}${user.anonymous ? " (anonymous)" : ""}` : ""} />
          <Row k="device.id" v={device?.id} />
          <Row k="inactivity timeout" v={shortTimeout ? "1 min (short)" : "30 min (default)"} />
        </tbody>
      </table>
    </section>
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

export const box = { border: "1px solid #ccc", borderRadius: 6, padding: "8px 16px", marginBottom: 16 };
export const h2 = { fontSize: 18, margin: "8px 0" };
