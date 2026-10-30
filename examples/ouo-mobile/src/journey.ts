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
// The app's own requests (screens loading data) go through the same fetch as a tap would.
import { createNavigationContainerRef } from "@react-navigation/native";
import { File, Paths } from "expo-file-system";
import { addToCart, checkout, getProducts, type PaymentMethod } from "./api";
import type { RootStackParamList } from "./navigation";
import { rum } from "./rum";

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
        rum.feedback({ message: params.get("message") ?? "", contact: params.get("contact") ?? "", screenshot: true });
        break;
    }
  } catch {
    // failed requests are the point of some commands; the SDK records them
  }
}

export function startJourneyMailbox(): () => void {
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
