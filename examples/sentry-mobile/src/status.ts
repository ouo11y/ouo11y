// Tiny observable for the "last action" line shown on every screen (also visible in replays).
type Listener = (s: string) => void;
let current = "ready";
const listeners = new Set<Listener>();

export function setStatus(s: string): void {
  current = `${new Date().toISOString().slice(11, 19)} ${s}`;
  console.log(`[sentry-demo] ${s}`);
  listeners.forEach((l) => l(current));
}

export function getStatus(): string {
  return current;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
