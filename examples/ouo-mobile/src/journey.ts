// Prompt-free command channel for scripts/journey.sh (the same mechanism as examples/sentry-mobile).
//
// On iOS 27 `xcrun simctl openurl` shows an "Open in ...?" alert for every custom-scheme URL, which
// an unattended script cannot dismiss. The journey writes one command per line into
// Documents/journey-command in the app's data container and the app polls that file while in the
// foreground. Commands:
//   screen/<Products|Cart|Checkout|Chaos>, screen/Product?id=p-1001, screen/back
//   action/add?id=p-1001         POST /api/cart
//   action/checkout?method=card  POST /api/checkout (broken-card: the backend answers 500)
//   action/fetch-500             GET /api/products?fail=500
//   action/flush                 rum.flush()
//   action/feedback?message=...&contact=...  rum.feedback with a screenshot
//   action/hang?ms=3000          block the main thread (modules/ouo-chaos): one hang exception
//   action/stutter?ms=1200&times=3  block it three times with a frame between: a hang not fully blocking
//   action/oom                   a memory warning, then SIGKILL: a termination on the next launch
//   action/error                 rum.captureError("golden handled error") on the current screen
//   action/golden                a request inside rum.withSpan("golden.checkout"), then a log line
//   action/areas                 notes the window rectangles of the views the replay must mask
//   action/crash                 a native crash (Android: an exception on the main thread)
//   action/crash-ndk?abort=1     Android: an NDK crash in C code on the JS thread (SIGSEGV, or abort() with a message)
//   action/event?name=...        rum.addEvent(name)
// The app's own requests (screens loading data) go through the same fetch as a tap would.
//
// On Android the commands arrive as broadcasts (modules/ouo-chaos, `am broadcast -a
// dev.ouo.mobilestore.JOURNEY --es cmd <command>`): a release build's files are not writable by adb,
// and a deep link would pause the activity, which React Native reports as a background.
import { createNavigationContainerRef } from "@react-navigation/native";
import { File, Paths } from "expo-file-system";
import { Platform, type View } from "react-native";
import { chaos } from "../modules/ouo-chaos";
import { addToCart, checkout, getProducts, type PaymentMethod } from "./api";
import type { RootStackParamList } from "./navigation";
import { config, note, rum } from "./rum";

/** Views whose rectangles `action/areas` notes for the replay pixel check (C8.2), by name. */
const areas = new Map<string, View>();

/** `ref={maskedArea("cart-total")}`: registers a view `action/areas` measures while it is mounted. */
export function maskedArea(name: string): (v: View | null) => void {
  return (v) => {
    if (v) areas.set(name, v);
    else areas.delete(name);
  };
}

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

const POLL_MS = 400;

function parse(cmd: string): { kind: string; target: string; params: URLSearchParams } {
  const [path, query = ""] = cmd.split("?", 2);
  const [kind = "", target = ""] = path.split("/", 2);
  return { kind, target, params: new URLSearchParams(query) };
}

async function run(cmd: string): Promise<void> {
  const { kind, target, params } = parse(cmd);
  if (kind === "screen") {
    if (!navigationRef.isReady()) return;
    if (target === "back") {
      if (navigationRef.canGoBack()) navigationRef.goBack();
    } else if (target === "Product") {
      navigationRef.navigate("Product", { id: params.get("id") ?? "p-1001" });
    } else if (target === "Products" || target === "Cart" || target === "Checkout" || target === "Chaos") {
      navigationRef.navigate(target);
    }
    return;
  }
  if (kind !== "action") return;
  try {
    switch (target) {
      case "add":
        await addToCart(params.get("id") ?? "p-1001", Number(params.get("qty") ?? 1));
        break;
      case "checkout":
        await checkout((params.get("method") ?? "card") as PaymentMethod);
        break;
      case "fetch-500":
        await getProducts({ fail: "500" });
        break;
      case "flush":
        await rum.flush();
        break;
      case "feedback":
        note("feedback", { id: rum.feedback({ message: params.get("message") ?? "", contact: params.get("contact") ?? "", screenshot: true }) });
        break;
      case "hang":
        await chaos?.blockMainThread(Number(params.get("ms") ?? 3000));
        break;
      case "stutter":
        chaos?.stutterMainThread(Number(params.get("ms") ?? 1200), Number(params.get("times") ?? 3));
        break;
      case "oom":
        chaos?.simulateOutOfMemory();
        break;
      case "error":
        try {
          throw new Error("golden handled error");
        } catch (err) {
          rum.captureError(err);
        }
        break;
      case "golden":
        await rum.withSpan("golden.checkout", () => getProducts());
        rum.log.info("golden log line");
        break;
      case "areas":
        for (const [name, view] of areas) {
          view.measureInWindow((x, y, w, h) => note("area", { name, x, y, w, h }));
        }
        break;
      case "event":
        rum.addEvent(params.get("name") ?? "journey.event");
        break;
      case "crash":
        note("crash");
        chaos?.crashNatively?.();
        break;
      case "crash-ndk":
        note("crash", { crash: "ndk" });
        chaos?.crashInNativeCode?.(params.get("abort") === "1");
        break;
    }
  } catch {
    // failed requests are the point of some commands; the SDK records them
  }
}

// The Android suite's C2.3 launch (`am start -e ouo_action crash-early`): a native crash 200 ms
// after the JS bundle runs, before anything was exported.
if (config.conformance && chaos?.launchAction?.() === "crash-early") {
  note("crash", { action: "crash-early" });
  setTimeout(() => chaos?.crashNatively?.(), 200);
}

export function startJourneyMailbox(): () => void {
  if (Platform.OS === "android") {
    // The receiver is exported (adb sends from the shell user): only the conformance and debug
    // builds listen, so no other app can drive a demo build.
    if (!config.conformance && !__DEV__) return () => {};
    const sub = chaos?.addListener?.("onJourneyCommand", (e: { cmd: string }) => {
      note("command", { cmd: e.cmd });
      void run(e.cmd);
    });
    return () => sub?.remove();
  }
  const file = new File(Paths.document, "journey-command");
  const timer = setInterval(() => {
    try {
      if (!file.exists) return;
      const cmds = file.textSync().trim();
      file.delete();
      for (const line of cmds.split("\n")) if (line.trim()) void run(line.trim());
    } catch {
      // half-written file: try again on the next tick
    }
  }, POLL_MS);
  return () => clearInterval(timer);
}
