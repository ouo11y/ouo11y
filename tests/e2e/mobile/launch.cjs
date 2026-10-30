/**
 * One launch of the golden React Native iOS app: the built `@ouo11y/react-native` bundle
 * (sdk/react-native/dist) under the native stand-in (standin.cjs). conformance.mjs runs the
 * launches in order; each prints one `GOLDEN {...}` line with the session ids it saw.
 *
 *   node --require ./standin.cjs launch.cjs     (env: OUO_E2E_LAUNCH, see below)
 *
 * OUO_E2E_LAUNCH:
 *   main         Home -> Products -> Cart with a tap, a long press and a swipe through
 *                RUMProvider, a request inside a custom span, a log
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
const { initRUM, RUMProvider } = require("../../../sdk/react-native/dist/index.js");
const { AppState } = require("react-native");

const env = process.env;
const OTLP = (env.OUO_OTLP_URL ?? "http://localhost:4318").replace(/\/$/, "");
const REPLAY = (env.OUO_REPLAY_URL ?? "http://localhost:4319").replace(/\/$/, "");
const BACKEND = (env.OUO_BACKEND_URL ?? "http://localhost:8081").replace(/\/$/, "");
const LAUNCH = env.OUO_E2E_LAUNCH ?? "main";
const BACKGROUND_TIMEOUT_MS = 2000;
const os = globalThis.__ouoStandin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A touch inside RUMProvider the way React Native delivers it: the touched host view's fiber
 * (`_targetInst`), what <Pressable testID role> or a list renders above it, held `ms` and moved
 * `dy` points.
 */
async function touch(root, { label, role, component, screen }, ms = 60, dy = 0) {
  const screenFiber = { elementType: { displayName: screen }, memoizedProps: {}, return: null };
  const props = role ? { testID: label, role } : { testID: label };
  const control = { elementType: { displayName: component }, memoizedProps: props, return: screenFiber };
  const host = { elementType: "RCTView", memoizedProps: props, return: { elementType: { displayName: "View" }, memoizedProps: props, return: control } };
  root.props.onTouchStart({ _targetInst: { elementType: "RCTText", memoizedProps: {}, return: host }, nativeEvent: { pageX: 200, pageY: 400 } });
  await sleep(ms);
  root.props[dy ? "onTouchCancel" : "onTouchEnd"]({ nativeEvent: { pageX: 200, pageY: 400 + dy } });
}

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
      const root = RUMProvider({ rum });
      rum.trackNavigation("/Home");
      await sleep(300);
      await touch(root, { label: "open-products", role: "button", component: "Pressable", screen: "HomeScreen" });
      rum.trackNavigation("/Products");
      await sleep(300);
      await touch(root, { label: "add-to-cart", role: "button", component: "Pressable", screen: "ProductsScreen" }, 700);
      out.request = await rum.withSpan("golden.checkout", () => fetch(`${BACKEND}/api/products`).then((r) => r.status));
      rum.trackNavigation("/Cart");
      await sleep(300);
      // A scroll view takes the touch over: React Native cancels it.
      await touch(root, { label: "cart-items", component: "FlatList", screen: "CartScreen" }, 250, -160);
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
      // The resume frame lands in the first session (native resumes before the JS rotation); the
      // second session's first frame is the next timer tick, as on a device.
      await sleep(1500);
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
