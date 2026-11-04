import { ChaosPanel } from "../components/ChaosPanel";

export function ChaosPage() {
  return (
    <section className="page ouo-unmask">
      <h1>Chaos</h1>
      <p className="muted">
        Each button exercises one path the RUM SDK must capture. Watch the log below, the browser console and
        the network tab; then look the session up in Grafana (see README).
      </p>
      <ChaosPanel />
    </section>
  );
}
