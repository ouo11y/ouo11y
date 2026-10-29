/**
 * One launch of the golden React Native iOS app: the built `@ouo11y/react-native` bundle
 * (sdk/react-native/dist) under the native stand-in (standin.cjs). conformance.mjs runs the
 * launches in order; each prints one `GOLDEN {...}` line with the session ids it saw.
 *
 *   node --require ./standin.cjs launch.cjs     (env: OUO_E2E_LAUNCH, see below)
 *
 * OUO_E2E_LAUNCH:
 *   main         Home -> Products -> Cart with three taps, a request inside a custom span, a log
 *                line, a handled error, feedback, a 3 s main-thread block, then a background stay
 *                longer than the timeout and a second session
 *   crash        Home, then a native crash once the first batches are out
 *   early-crash  a native crash 200 ms after launch, before anything was exported
 *   terminate    Home, then the system kills the app in the foreground (no crash report)
 *   offline      Home and a background stay with the collector refused (OUO_E2E_OFFLINE=1)
 *   relaunch     the next launch: takes the previous run's state, then flushes
 * Env: OUO_OTLP_URL, OUO_REPLAY_URL, OUO_PROJECT_ID, OUO_PROJECT_TOKEN, OUO_BACKEND_URL,
 *      OUO_E2E_SERVICE (service.name of the run), OUO_STORAGE_FILE (the device's AsyncStorage).
 */
const { initRUM } = require("../../../sdk/react-native/dist/index.js");
const { AppState } = require("react-native");

const env = process.env;
const OTLP = (env.OUO_OTLP_URL ?? "http://localhost:4318").replace(/\/$/, "");
const REPLAY = (env.OUO_REPLAY_URL ?? "http://localhost:4319").replace(/\/$/, "");
const BACKEND = (env.OUO_BACKEND_URL ?? "http://localhost:8081").replace(/\/$/, "");
const LAUNCH = env.OUO_E2E_LAUNCH ?? "main";
const BACKGROUND_TIMEOUT_MS = 2000;
const os = globalThis.__ouoStandin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rum = initRUM({
    endpoint: OTLP,
    replayEndpoint: REPLAY,
    projectId: env.OUO_PROJECT_ID ?? "demo",
    projectToken: env.OUO_PROJECT_TOKEN ?? "pt_dev_demo_0000000000000000",
    service: { name: env.OUO_E2E_SERVICE ?? "qa-rn-ios", version: "1.0.0", environment: "qa" },
    tracing: { propagateTo: [new RegExp(`^${BACKEND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)] },
    session: { backgroundTimeoutMs: BACKGROUND_TIMEOUT_MS },
    replay: { enabled: true },
    device: { modelIdentifier: "iPhone17,2", modelName: "iPhone 16 Pro Max", manufacturer: "Apple" },
  });
  await rum.ready;
  const out = { launch: LAUNCH, session: rum.session.id(), previous: rum.session.previousId() ?? null };
  const report = () => console.log(`GOLDEN ${JSON.stringify(out)}`);

  switch (LAUNCH) {
    case "main": {
      rum.trackNavigation("/Home");
      await sleep(300);
      rum.trackTap("open-products", "HomeScreen > open-products");
      rum.trackNavigation("/Products");
      await sleep(300);
      rum.trackTap("add-to-cart", "ProductsScreen > add-to-cart");
      out.request = await rum.withSpan("golden.checkout", () => fetch(`${BACKEND}/api/products`).then((r) => r.status));
      rum.trackNavigation("/Cart");
      await sleep(300);
      rum.trackTap("checkout", "CartScreen > checkout");
      rum.log.info("golden log line", { "golden.step": "cart" });
      rum.captureError(new Error("golden handled error"), { screen: "Cart" });
      // C10 (W6): the feedback API does not exist yet.
      if (typeof rum.feedback === "function") rum.feedback({ message: "golden feedback", contact: "qa@example.invalid" });
      os.blockMainThread(3000);
      await sleep(1500);
      AppState.__emit("background");
      await sleep(BACKGROUND_TIMEOUT_MS + 600);
      AppState.__emit("active");
      rum.trackNavigation("/Home");
      out.second = rum.session.id();
      out.second_previous = rum.session.previousId() ?? null;
      break;
    }
    case "crash":
      rum.trackNavigation("/Home");
      await sleep(3000); // the first log and span batches are exported
      report();
      os.crash();
      break;
    case "early-crash":
      await sleep(200);
      report();
      os.crash();
      break;
    case "terminate":
      rum.trackNavigation("/Home");
      await sleep(3000);
      report();
      os.terminate();
      break;
    case "offline":
      rum.trackNavigation("/Home");
      await sleep(500);
      AppState.__emit("background"); // flush on background, refused
      await sleep(1500);
      break;
    case "relaunch":
      break;
    default:
      throw new Error(`unknown launch ${LAUNCH}`);
  }
  await rum.flush();
  await sleep(300);
  report();
  // The session timers keep a Node process alive (an app never exits this way).
  process.exit(0);
}

main().catch((err) => {
  console.error("launch failed", err);
  process.exit(1);
});
