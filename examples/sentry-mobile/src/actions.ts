// Every demo action, callable from a button or from a deep link
// (`sentrydemo://action/<name>`, see src/deeplinks.ts). Names are the deep-link path.
import * as Sentry from "@sentry/react-native";
import { getProducts } from "./api";
import { setStatus } from "./status";

export type ActionName =
  | "fetch-ok"
  | "fetch-500"
  | "fetch-slow"
  | "handled-error"
  | "unhandled-rejection"
  | "js-fatal"
  | "native-crash"
  | "message"
  | "flush";

// Fetch tracing only records an http.client span while a span is active. Outside a navigation
// transaction there is none, so each fetch action runs in its own `ui.action` transaction (what
// user-interaction tracing would create for a tap).
async function fetchAction(label: string, flags?: Parameters<typeof getProducts>[0]): Promise<void> {
  await Sentry.startSpan({ name: `action ${label}`, op: "ui.action", forceTransaction: true }, async () => {
    try {
      const products = await getProducts(flags);
      setStatus(`${label}: ${products.length} products`);
    } catch (e) {
      // Not reported to Sentry on purpose: the failed request is visible as an http.client span
      // with status code 500, which is what the bridge turns into http.request.failed.
      setStatus(`${label}: ${(e as Error).message}`);
    }
  });
}

export const actions: Record<ActionName, { title: string; run: () => void | Promise<void> }> = {
  "fetch-ok": { title: "Fetch products", run: () => fetchAction("fetch-ok") },
  "fetch-500": { title: "Fetch 500", run: () => fetchAction("fetch-500", { fail: "500" }) },
  "fetch-slow": { title: "Slow fetch (2.5 s)", run: () => fetchAction("fetch-slow", { delay: 2500 }) },
  "handled-error": {
    title: "Handled error",
    run: () => {
      try {
        throw new Error("sentry-demo handled error: coupon service unavailable");
      } catch (e) {
        const id = Sentry.captureException(e, { tags: { "demo.action": "handled-error" } });
        setStatus(`handled-error: event ${id.slice(0, 8)}`);
      }
    },
  },
  "unhandled-rejection": {
    title: "Unhandled rejection",
    run: () => {
      // Non-fatal: RN's promise rejection tracking hands it to Sentry, the app keeps running.
      void Promise.reject(new Error("sentry-demo unhandled promise rejection"));
      setStatus("unhandled-rejection: rejected a promise");
    },
  },
  "js-fatal": {
    title: "JS fatal (setTimeout throw)",
    run: () => {
      // Fatal in a Release build: RN's global handler gets isFatal = true, Sentry records a
      // `fatal` event and RN then terminates the app (RCTFatal). Not part of the default journey.
      setStatus("js-fatal: throwing from setTimeout");
      setTimeout(() => {
        throw new Error("sentry-demo fatal JS error from setTimeout");
      }, 50);
    },
  },
  "native-crash": {
    title: "Native crash",
    run: () => {
      setStatus("native-crash: crashing");
      // Give the status line one frame so it is in the replay, then crash in sentry-cocoa.
      setTimeout(() => Sentry.nativeCrash(), 300);
    },
  },
  message: {
    title: "Breadcrumb + message",
    run: () => {
      Sentry.addBreadcrumb({ category: "demo", message: "user opened the promo sheet", level: "info", data: { promo: "AUTUMN" } });
      const id = Sentry.captureMessage("sentry-demo custom message: promo sheet opened", "info");
      setStatus(`message: event ${id.slice(0, 8)}`);
    },
  },
  flush: {
    title: "Flush",
    run: async () => {
      const ok = await Sentry.flush();
      setStatus(`flush: ${ok ? "done" : "timed out"}`);
    },
  },
};

export function runAction(name: string): boolean {
  const action = (actions as Record<string, (typeof actions)[ActionName]>)[name];
  if (!action) {
    setStatus(`unknown action ${name}`);
    return false;
  }
  Sentry.addBreadcrumb({ category: "demo.action", message: name, level: "info" });
  void Promise.resolve(action.run()).catch((e) => setStatus(`${name} failed: ${String(e)}`));
  return true;
}
