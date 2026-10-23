import { uuidv4 } from "../session/ids";

export const REPLAY_CHANNEL = "ouo.replay";

interface ClaimMessage {
  type: "claim";
  tab: string;
  session: string;
}

/**
 * Which tab records replay for a session shared by several tabs: the last one to claim. A
 * claim is broadcast on a BroadcastChannel; every other tab hears it and stops. Without
 * BroadcastChannel (Safari before 15.4) each tab only stops when hidden.
 */
export class TabLease {
  readonly tabId = uuidv4();
  private owner = false;
  private readonly channel: BroadcastChannel | null;
  private readonly listeners = new Set<(sessionId: string) => void>();

  constructor(channel?: BroadcastChannel | null) {
    this.channel = channel !== undefined ? channel : typeof BroadcastChannel === "function" ? new BroadcastChannel(REPLAY_CHANNEL) : null;
    this.channel?.addEventListener("message", (e: MessageEvent<ClaimMessage>) => {
      const m = e.data;
      if (!m || m.type !== "claim" || m.tab === this.tabId) return;
      this.owner = false;
      for (const l of this.listeners) l(m.session);
    });
  }

  claim(sessionId: string): void {
    this.owner = true;
    const message: ClaimMessage = { type: "claim", tab: this.tabId, session: sessionId };
    this.channel?.postMessage(message);
  }

  isOwner(): boolean {
    return this.owner;
  }

  /** Called with the session id when another tab claims the lease. */
  onLost(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.channel?.close();
  }
}
