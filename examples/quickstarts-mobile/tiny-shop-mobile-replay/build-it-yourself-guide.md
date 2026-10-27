# Build Tiny Shop Mobile Replay yourself, from scratch

This guide is for teams whose React Native app uses Sentry, Session Replay included, and who want
those sessions and replays in ouo. The app keeps `@sentry/react-native`; only its DSN changes, to
the ouo Sentry bridge in the ouo collector. The bridge answers the SDK like Sentry would and turns
what it receives into ouo sessions, errors, traces, logs and replays. Here it forwards nothing
(`upstream: none`): you need no Sentry account, and no byte goes to sentry.io.

You build, one step at a time, with no scripts:

1. a plain Express API and a plain Expo app (Products, Product, Cart), with no telemetry at all;
2. the ouo stack (the ouo collector with the Sentry bridge, Tempo, Loki, Mimir, rum-api,
   Grafana), one folder per service;
3. the API traced with the OpenTelemetry Node SDK;
4. Sentry in the app, pointed at the bridge, with mobile Session Replay;
5. then you use it: a masked and an unmasked replay with the taps drawn on them, the replay of an
   errored session, what it all costs, and how a mobile replay differs from a web one.

At the end your files are the same as [`result/`](result): compare with them when you are
stuck. Plan on about 75 minutes; a third of it is waiting for iOS builds.

```
tiny-shop-mobile-replay/
├── stack/      the ouo stack, one folder per service, the Sentry bridge in 10-collector
├── backend/    Express API, OpenTelemetry traces
└── app/        Expo app (TypeScript), @sentry/react-native with Session Replay
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`tiny-shop-mobile-replay/`, wherever you create it, and each command says which of its folders it
runs in. When a step says "replace the file", select everything in it and paste the new content
over it.

## What the bridge does with a Sentry session

The SDK sends **envelopes**, one HTTP request each, to the DSN. The bridge reads every item in
them; this is what each becomes in ouo, and where you will look at it:

| Sentry sends | ouo gets | Where you see it |
|---|---|---|
| `session` (init, update, exited, crashed) | the session, healthy / errored / crashed | ouo11y RUM -> Sessions |
| `event` (an error, handled or not) | an `exception` record with its stack | the session's timeline, Loki |
| `transaction` with its spans (screens, taps, `fetch`) | spans in Tempo, joined with the API's | the session's Traces, Tempo |
| `log` (`Sentry.logger.*`) | a log record with the session id | Loki |
| `replay_video`: a 5 s mp4 segment, its touches and breadcrumbs | a video chunk in rum-api; taps, requests, screen changes as timeline events | the session's Replay and Timeline |

Spec: [`docs/specs/sentry-bridge.md`](../../../docs/specs/sentry-bridge.md); the client side
and its traps: [`docs/sentry-client-setup.md`](../../../docs/sentry-client-setup.md).

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

Docker Desktop must be running. This prints the server details, not "Cannot connect":

```bash
docker info
```

Xcode 27 (the full app, not only the command line tools) and CocoaPods:

```bash
xcodebuild -version
```

```bash
pod --version
```

An iPhone simulator with iOS 27. This lists at least one:

```bash
xcrun simctl list devices available | grep "iPhone 18 Pro"
```

VS Code's `code` command. If it is not found, open VS Code, press Cmd+Shift+P and run
**Shell Command: Install 'code' command in PATH**.

```bash
code --version
```

## Step 1. Create the folders and open VS Code

From the folder where you keep your projects:

```bash
mkdir -p tiny-shop-mobile-replay/backend tiny-shop-mobile-replay/stack
```

```bash
cd tiny-shop-mobile-replay
```

```bash
code .
```

In VS Code, open a terminal with Ctrl+\`. You will use three terminal tabs (the `+` button): one
for the backend, one for the app, one for the stack. Each new tab opens in
`tiny-shop-mobile-replay/`.

## Step 2. A plain API, no telemetry yet

In the first terminal tab, from `tiny-shop-mobile-replay/`:

```bash
cd backend
```

```bash
npm init -y
```

```bash
npm install express
```

| Package | What it does here |
|---|---|
| `express` | the HTTP server and its routes |

A native app is not a web page: it sends no CORS preflight, so the API needs no `cors` package.

Create `backend/server.js`:

```js
const express = require("express");

const app = express();
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4, description: "A bag of whole beans, roasted last week." },
  { id: 2, name: "Tea", price: 3, description: "Twenty bags of black tea." },
  { id: 3, name: "Cake", price: 6, description: "One slice of carrot cake." },
];

app.get("/api/products", async (req, res) => {
  await sleep(80);
  res.json(products);
});

app.post("/api/checkout", async (req, res) => {
  await sleep(150);
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

app.get("/api/fail", (req, res) => {
  res.status(500).json({ error: "inventory service unavailable" });
});

const port = Number(process.env.API_PORT || 5001);
app.listen(port, () => console.log(`tiny-shop API on http://localhost:${port}`));
```

Run it:

```bash
node server.js
```

In another terminal tab, check that it answers:

```bash
curl localhost:5001/api/products
```

You get the three products as JSON. Leave the API running.

## Step 3. A plain Expo app, no telemetry yet

### 3a. Create the app

In the second terminal tab, from `tiny-shop-mobile-replay/` (the template creates `app/`). The
`@sdk-57` tag picks the Expo SDK this quickstart was tested with, Expo 57 and React Native 0.86:

```bash
npx create-expo-app@latest app --template blank-typescript@sdk-57
```

```bash
cd app
```

The template also writes an `AGENTS.md` for coding agents; keep it or delete it.

### 3b. Navigation

```bash
npx expo install @react-navigation/native @react-navigation/native-stack react-native-screens react-native-safe-area-context
```

| Package | What it does here |
|---|---|
| `@react-navigation/native` | the navigation container and its state |
| `@react-navigation/native-stack` | the stack of screens, with iOS's own headers and back gesture |
| `react-native-screens` | the native screen containers the stack uses |
| `react-native-safe-area-context` | keeps the content clear of the notch and the home indicator |

`npx expo install` picks the versions that match Expo 57; `npm install` would take the newest,
which may not.

### 3c. The app's files

Delete `app/app.json`: its replacement, `app/app.config.ts`, is a TypeScript file, so it can read
the environment (the bundle id now, Sentry later).

```bash
rm app.json
```

Create `app/app.config.ts`:

```ts
// Tiny Shop Mobile: the Expo app config (it replaces app.json so it can read the environment).
import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Tiny Shop",
  slug: "tiny-shop-mobile-replay",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: false,
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? "dev.ouo.tinyshop",
    // Plain http to the API on this Mac (local development only).
    infoPlist: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } },
  },
  plugins: [
    // iOS 27 refuses to launch an app without the UIScene life cycle; Expo 57's template lacks it.
    "./plugins/withUIScene.js",
  ],
};

export default config;
```

iOS 27 stops any app at launch that does not use the UIScene life cycle, and the Expo 57
template does not use it yet. This config plugin adds it when Expo generates the iOS project.
Create `app/plugins/withUIScene.js`:

<details>
<summary><code>app/plugins/withUIScene.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/plugins/withUIScene.js -->
```js
// Expo config plugin: adopt the UIScene life cycle on iOS.
//
// iOS 27 traps at launch unless the app has a scene manifest and a scene delegate
// (crash in _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption). Expo SDK 57 ships
// `ExpoAppSceneDelegate` but its prebuild template does not wire it up yet, so this plugin:
//   1. adds UIApplicationSceneManifest to Info.plist,
//   2. writes SceneDelegate.swift (subclass of ExpoAppSceneDelegate) and adds it to the target,
//   3. makes AppDelegate conform to ExpoReactNativeFactoryProvider and stops it from creating the
//      window itself (the scene delegate does that and starts React Native into it).
// Remove this plugin once the Expo template adopts scenes. See project/kb/xcode-setup.md.
const { withInfoPlist, withAppDelegate, withXcodeProject, withDangerousMod, IOSConfig } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const SCENE_DELEGATE = `internal import Expo
import UIKit

/// Scene delegate required by iOS 27. All work happens in the Expo base class.
class SceneDelegate: ExpoAppSceneDelegate {}
`;

function withSceneManifest(config) {
  return withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return c;
  });
}

function withSceneDelegateFile(config) {
  config = withDangerousMod(config, [
    "ios",
    async (c) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(c.modRequest.projectRoot);
      const file = path.join(c.modRequest.platformProjectRoot, projectName, "SceneDelegate.swift");
      fs.writeFileSync(file, SCENE_DELEGATE);
      return c;
    },
  ]);
  return withXcodeProject(config, (c) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(c.modRequest.projectRoot);
    const relPath = `${projectName}/SceneDelegate.swift`;
    if (!c.modResults.hasFile(relPath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath: relPath,
        groupName: projectName,
        project: c.modResults,
      });
    }
    return c;
  });
}

function withSceneAwareAppDelegate(config) {
  return withAppDelegate(config, (c) => {
    let src = c.modResults.contents;
    if (!src.includes("ExpoReactNativeFactoryProvider")) {
      src = src.replace(
        "class AppDelegate: ExpoAppDelegate {",
        'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {\n  // UIScene life cycle (plugins/withUIScene.js): the scene delegate creates the window.\n  var reactNativeFactoryModuleName: String { "main" }'
      );
    }
    const windowBlock = /#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\(\n\s*withModuleName: "main",\n\s*in: window,\n\s*launchOptions: launchOptions\)\n#endif\n/;
    if (windowBlock.test(src)) {
      src = src.replace(windowBlock, "    // Window creation and startReactNative moved to SceneDelegate (UIScene life cycle).\n");
    }
    c.modResults.contents = src;
    return c;
  });
}

module.exports = function withUIScene(config) {
  return withSceneAwareAppDelegate(withSceneDelegateFile(withSceneManifest(config)));
};
```

</details>

The app's settings. Create `app/src/config.ts`:

```ts
// Where the app sends its requests. EXPO_PUBLIC_* variables are written into the JavaScript
// bundle when Metro builds it: after changing one, rebuild the app.
export const config = {
  // The Tiny Shop API (backend/).
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001",
};
```

The API calls. Create `app/src/api.ts`:

```ts
// The Tiny Shop API.
import { config } from "./config";

export type Product = { id: number; name: string; price: number; description: string };
export type Order = { ok: boolean; orderId: number };

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

export const getProducts = () => request<Product[]>("GET", "/api/products");
export const checkout = (items: { id: number; qty: number }[]) => request<Order>("POST", "/api/checkout", { items });
export const callBrokenApi = () => request<unknown>("GET", "/api/fail");

export const formatPrice = (n: number) => `$${n.toFixed(2)}`;
```

The screens and their parameters. Create `app/src/navigation.ts`:

```ts
// The screens and their parameters.
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Product } from "./api";

export type Screens = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};

export type ScreenProps<T extends keyof Screens> = NativeStackScreenProps<Screens, T>;
```

The cart, which every screen reads. Create `app/src/cart.tsx`:

<details>
<summary><code>app/src/cart.tsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/cart.tsx -->
```tsx
// The cart, in memory: a React context every screen can read.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Product } from "./api";

type Line = { product: Product; qty: number };
type Cart = {
  lines: Line[];
  count: number;
  total: number;
  add: (product: Product) => void;
  clear: () => void;
};

const CartContext = createContext<Cart | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<Line[]>([]);
  const cart = useMemo<Cart>(
    () => ({
      lines,
      count: lines.reduce((n, l) => n + l.qty, 0),
      total: lines.reduce((t, l) => t + l.qty * l.product.price, 0),
      add: (product) =>
        setLines((ls) =>
          ls.some((l) => l.product.id === product.id)
            ? ls.map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + 1 } : l))
            : [...ls, { product, qty: 1 }],
        ),
      clear: () => setLines([]),
    }),
    [lines],
  );
  return <CartContext.Provider value={cart}>{children}</CartContext.Provider>;
}

export function useCart(): Cart {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart outside CartProvider");
  return cart;
}
```

</details>

A button and the styles. Create `app/src/ui.tsx`:

```tsx
// A button and the shared styles.
import { Pressable, StyleSheet, Text } from "react-native";

export function Button({ label, onPress, kind = "primary" }: { label: string; onPress: () => void; kind?: "primary" | "debug" }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.button, kind === "debug" && styles.debug, pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fafafa" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, backgroundColor: "white", borderRadius: 8 },
  image: { width: 48, height: 48, borderRadius: 8 },
  name: { fontSize: 17, fontWeight: "600" },
  price: { fontSize: 15, color: "#555" },
  section: { fontSize: 13, fontWeight: "700", color: "#888", textTransform: "uppercase", marginTop: 12 },
  note: { fontSize: 14, color: "#333" },
  button: { backgroundColor: "#4b3fcc", padding: 14, borderRadius: 8, alignItems: "center" },
  debug: { backgroundColor: "#a33" },
  pressed: { opacity: 0.6 },
  buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
});
```

**Products** lists the products and has the Debug section. Create
`app/src/screens/ProductsScreen.tsx`:

```tsx
// Products: the list from GET /api/products, and the Debug section.
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { callBrokenApi, formatPrice, getProducts, type Product } from "../api";
import type { ScreenProps } from "../navigation";
import { Button, styles } from "../ui";

export function ProductsScreen({ navigation }: ScreenProps<"Products">) {
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    getProducts()
      .then(setProducts)
      .catch((e: Error) => setStatus(`Could not load products: ${e.message}`));
  }, []);

  const brokenApi = () =>
    callBrokenApi().catch((e: Error) => setStatus(e.message));

  const handledError = () => {
    try {
      JSON.parse("{ this is not json");
    } catch (e) {
      // A handled error: the app keeps running.
      setStatus(`Handled error: ${(e as Error).message}`);
    }
  };

  const throwError = () => {
    // An error nothing catches: in a Release build the app closes.
    setTimeout(() => {
      throw new Error("Tiny Shop crashed on purpose");
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {products.map((p) => (
        <Pressable key={p.id} style={styles.row} onPress={() => navigation.navigate("Product", { product: p })}>
          <Image source={require("../../assets/icon.png")} style={styles.image} />
          <View>
            <Text style={styles.name}>{p.name}</Text>
            <Text style={styles.price}>{formatPrice(p.price)}</Text>
          </View>
        </Pressable>
      ))}
      <Text style={styles.section}>Debug</Text>
      <Button kind="debug" label="Call broken API" onPress={brokenApi} />
      <Button kind="debug" label="Handled error" onPress={handledError} />
      <Button kind="debug" label="Throw error" onPress={throwError} />
      {status ? <Text style={styles.note}>{status}</Text> : null}
    </ScrollView>
  );
}
```

**Product** shows one product. Create `app/src/screens/ProductScreen.tsx`:

```tsx
// Product: the detail of one product, and "Add to cart".
import { Image, Text, View } from "react-native";
import { formatPrice } from "../api";
import { useCart } from "../cart";
import type { ScreenProps } from "../navigation";
import { Button, styles } from "../ui";

export function ProductScreen({ route, navigation }: ScreenProps<"Product">) {
  const { product } = route.params;
  const cart = useCart();

  return (
    <View style={styles.screen}>
      <Image source={require("../../assets/icon.png")} style={{ width: "100%", height: 200, borderRadius: 12 }} resizeMode="contain" />
      <Text style={styles.name}>{product.name}</Text>
      <Text style={styles.price}>{formatPrice(product.price)}</Text>
      <Text style={styles.note}>{product.description}</Text>
      <Button label="Add to cart" onPress={() => cart.add(product)} />
      <Button label={`Go to cart (${cart.count})`} onPress={() => navigation.navigate("Cart")} />
    </View>
  );
}
```

**Cart** lists what you added, where it ships, and checks out. Create
`app/src/screens/CartScreen.tsx`:

```tsx
// Cart: the lines, where it ships, and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { checkout, formatPrice } from "../api";
import { useCart } from "../cart";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [status, setStatus] = useState("");

  const pay = () => {
    checkout(cart.lines.map((l) => ({ id: l.product.id, qty: l.qty })))
      .then((order) => {
        cart.clear();
        setStatus(`Order #${order.orderId} placed`);
      })
      .catch((e: Error) => setStatus(`Checkout failed: ${e.message}`));
  };

  return (
    <View style={styles.screen}>
      {cart.lines.map((l) => (
        <Text key={l.product.id} style={styles.note}>
          {l.qty} x {l.product.name} {formatPrice(l.qty * l.product.price)}
        </Text>
      ))}
      <Text style={styles.name}>Total {formatPrice(cart.total)}</Text>
      <Text style={styles.section}>Ship to</Text>
      <Text style={styles.note}>Jane Doe, 12 Sample Street, Springfield</Text>
      <Text style={styles.note}>Card ending 4242</Text>
      <Button label="Checkout" onPress={pay} />
      {status ? <Text style={styles.note}>{status}</Text> : null}
    </View>
  );
}
```

Replace `app/App.tsx`:

```tsx
// Tiny Shop Mobile: three screens in a native stack, the cart shared by all of them.
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import type { Screens } from "./src/navigation";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

const Stack = createNativeStackNavigator<Screens>();

export default function App() {
  return (
    <CartProvider>
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
          <Stack.Screen name="Product" component={ProductScreen} options={({ route }) => ({ title: route.params.product.name })} />
          <Stack.Screen name="Cart" component={CartScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </CartProvider>
  );
}
```

`app/index.ts` stays as the template wrote it.

### 3d. Run it in the simulator

From `app/`:

```bash
npx expo run:ios
```

The first run takes 5 to 10 minutes: Expo writes the iOS project into `app/ios/` (the UIScene
plugin runs here), CocoaPods installs the native libraries, Xcode builds a **Debug** app, then
Metro starts and serves the JavaScript. When it asks for a simulator, pick an iPhone 18 Pro.

The simulator shows **Tiny Shop** with Coffee, Tea and Cake: the app reached your API. Tap
**Coffee**, **Add to cart**, **Go to cart (1)**, **Checkout**: "Order #… placed". Back on
**Tiny Shop**, **Call broken API** shows `HTTP 500 from http://localhost:5001/api/fail`.

The app works, and nothing is instrumented yet. Stop Metro with Ctrl+C when you are done; the
app stays installed.

## Step 4. The stack, one service at a time

### 4a. Check the ports

The stack publishes 3000 (Grafana), 4318 (OTLP, for the API) and 4320 (the Sentry bridge, for
the app), and on loopback only 3100 (Loki), 3200 (Tempo), 9009 (Mimir) and 13133 (collector
health). In the third terminal tab, from `tiny-shop-mobile-replay/`, this prints nothing when
they are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4320|9009|13133) '
```

If something is listed, do not stop it: after creating the files below, add a `stack/.env`
with other ports, for example `OUO_GRAFANA_PORT=13000` and `OUO_SENTRY_PORT=14320` (the
variable names are in each `compose.yaml`). The app and the API then need the new ports too:
[README, "Ports"](README.md#ports).

### 4b. Create the files

Six services, one folder each. Each folder holds that service's compose file and its config, and
each file starts with what the service is for, who sends it data and its ports. Open a block, copy
all of it, and paste it into the file named in its title (VS Code creates the folders when you
save a new file as `stack/10-collector/compose.yaml`).

`compose.yaml` only lists the service folders:

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/compose.yaml -->
```yaml
# The ouo stack for tiny-shop-mobile-replay: one folder per service, each with its compose file and
# its config. This file only lists them. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), OTLP http://localhost:4318, Sentry bridge :4320.
# Ports taken? Set OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_SENTRY_PORT in stack/.env before `up`.
name: tiny-shop-mobile-replay   # compose project name: containers and the rum-api-data volume use it
include:
  - 10-collector/compose.yaml   # ingest: the app's Sentry SDK and the API's OpenTelemetry SDK send here
  - 20-tempo/compose.yaml       # traces
  - 30-loki/compose.yaml        # logs and app events (sessions, taps, errors)
  - 40-mimir/compose.yaml       # metrics (none from this shop yet; the collector accepts /v1/metrics)
  - 50-rum-api/compose.yaml     # sessions and the replay videos for the Grafana plugin
  - 60-grafana/compose.yaml     # the UI: datasources and the ouo11y RUM app
```

</details>

**The collector** is the only thing the app and the API talk to. The API sends OTLP to 4318 with
the project credential (`projects.htpasswd`). The app's Sentry SDK sends its envelopes to 4320,
the **Sentry bridge** (`ouosentry`): the DSN's public key and project id pick the ouo project and
the service name, and `upstream: none` means the bridge answers the SDK itself. The `routing`
connector sends the replay segments the bridge emits to rum-api, everything else to Loki.

<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/10-collector/compose.yaml -->
```yaml
# ouo-collector: the only ingest. The app's Sentry SDK sends its envelopes to the Sentry bridge
# (4320), the Node API sends OTLP (4318). The bridge turns sessions, errors, transactions, logs
# and replay video segments into ouo data; the collector forwards traces to Tempo, logs to Loki,
# metrics to Mimir and replay segments to rum-api.
# Ports: 4318 OTLP/HTTP, 4320 Sentry bridge (both public), 13133 health (loopback).
services:
  otel-collector:
    # `latest` follows each release. Tested with 0.4.0: pin `collector:0.4.0` or
    # `collector@sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2` to stay on it.
    image: ghcr.io/ouo11y/collector:latest
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "${OUO_SENTRY_PORT:-4320}:4320"
      - "127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133"
    environment:
      OUO_INGEST_TOKEN: it_dev_0000000000000000   # what it sends to rum-api; must equal rum-api's
    volumes:
      - ./config.yaml:/etc/otelcol/config.yaml:ro
      - ./projects.htpasswd:/etc/otelcol/projects.htpasswd:ro
    depends_on: [tempo, loki, mimir]
```

</details>

<details>
<summary><code>stack/10-collector/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/10-collector/config.yaml -->
```yaml
# ouo-collector pipelines, a trimmed copy of the full stack's config (no rate limits, no web
# replay receiver). Receivers: the Sentry bridge on 4320 (the app), OTLP/HTTP on 4318 (the API,
# behind the project credential in projects.htpasswd). Exporters: Tempo, Loki, Mimir, rum-api.

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  basicauth/server:
    htpasswd:
      file: /etc/otelcol/projects.htpasswd

receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        include_metadata: true       # keeps the authenticated project for resource/project
        auth:
          authenticator: basicauth/server
  # The Sentry bridge: takes Sentry SDK envelopes, answers like Sentry, and translates a copy
  # into ouo sessions, errors, traces, logs, tap and request events, and replay video segments.
  ouosentry:
    endpoint: 0.0.0.0:4320
    projects:
      # The app's DSN is http://<public key>@localhost:4320/<project id>: these two must match it.
      - sentry_project_id: "1"
        public_keys: ["publickey0000000000000000000000"]
        upstream: none                    # answer here, forward nothing: no Sentry account needed
        ouo_project_id: demo              # the ouo project the data lands in
        service_name: tiny-shop-mobile-replay-app

connectors:
  # The bridge emits replay segments on its logs output: send them to rum-api (logs/replay),
  # everything else to Loki (logs).
  routing/sentry:
    default_pipelines: [logs]
    table:
      - context: log
        condition: log.attributes["ouo.replay.chunk"] == true
        pipelines: [logs/replay]

processors:
  # Stamp the authenticated project id on every resource (and drop any value the client sent).
  # The bridge sets the project from its project table, so this works for its data too.
  resource/project:
    attributes:
      - key: ouo.project.id
        action: delete
      - key: ouo.project.id
        from_context: auth.username
        action: upsert
  # Copy the OTLP event name into the `event.name` attribute, which Loki turns into a label.
  transform/events:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.attributes["event.name"], log.event_name) where log.event_name != "" and log.attributes["event.name"] == nil
  batch:
    timeout: 1s

exporters:
  otlp_grpc/tempo:
    endpoint: tempo:4317
    tls: { insecure: true }
  otlp_http/loki:
    endpoint: http://loki:3100/otlp
    tls: { insecure: true }
  otlp_http/mimir:
    endpoint: http://mimir:9009/otlp
    tls: { insecure: true }
  # Replay segments to rum-api, which stores the mp4 files.
  ouoreplay:
    endpoint: http://rum-api:8080
    ingest_token: ${env:OUO_INGEST_TOKEN}
    timeout: 30s

service:
  extensions: [health_check, basicauth/server]
  pipelines:
    traces:
      receivers: [otlp, ouosentry]
      processors: [resource/project, batch]
      exporters: [otlp_grpc/tempo]
    # The bridge's records before routing.
    logs/sentry:
      receivers: [ouosentry]
      exporters: [routing/sentry]
    logs:
      receivers: [otlp, routing/sentry]
      processors: [resource/project, transform/events, batch]
      exporters: [otlp_http/loki]
    logs/replay:
      receivers: [routing/sentry]
      exporters: [ouoreplay]
    metrics:
      receivers: [otlp]
      processors: [resource/project, batch]
      exporters: [otlp_http/mimir]
```

</details>

<details>
<summary><code>stack/10-collector/projects.htpasswd</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/10-collector/projects.htpasswd -->
```
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

**Tempo** stores traces: the app's screens and taps (from the bridge) and the API's spans.

<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/20-tempo/compose.yaml -->
```yaml
# Tempo: stores traces. The collector sends it spans from the app and the API over OTLP/gRPC;
# Grafana and rum-api query it on 3200. Port 3200 is published for curl; nothing else needs it.
services:
  tempo:
    image: grafana/tempo:3.0.3
    command: ["-config.file=/etc/tempo/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_TEMPO_PORT:-3200}:3200"
    volumes:
      - ./config.yaml:/etc/tempo/config.yaml:ro
      - tempo-data:/var/tempo

volumes:
  tempo-data:
```

</details>

<details>
<summary><code>stack/20-tempo/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/20-tempo/config.yaml -->
```yaml
# Tempo 3.x single binary with local storage. Receives OTLP from the collector on 4317, serves
# queries on 3200 (Grafana streams search results over that port, hence stream_over_http).
stream_over_http_enabled: true

server:
  http_listen_port: 3200
  log_level: warn

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317

querier:
  frontend_worker:
    frontend_address: 127.0.0.1:9095

storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks
```

</details>

**Loki** stores the app's events and logs: session starts and ends, taps, requests, errors,
`Sentry.logger` lines.

<details>
<summary><code>stack/30-loki/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/30-loki/compose.yaml -->
```yaml
# Loki: stores logs. The collector sends it the app's events (sessions, taps, errors) and logs over OTLP
# (/otlp); Grafana and rum-api query it on 3100 (rum-api builds sessions from these records).
# Port 3100 is published on loopback for curl.
services:
  loki:
    image: grafana/loki:3.7.7
    command: ["-config.file=/etc/loki/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_LOKI_PORT:-3100}:3100"
    volumes:
      - ./config.yaml:/etc/loki/config.yaml:ro
      - loki-data:/loki

volumes:
  loki-data:
```

</details>

<details>
<summary><code>stack/30-loki/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/30-loki/config.yaml -->
```yaml
# Loki 3.x single binary, filesystem storage, native OTLP ingestion on 3100.
# Only service_name, deployment_environment_name, event_name and ouo_platform become labels;
# everything else (session.id, user.id, trace_id, your log attributes) is structured metadata.
auth_enabled: false

server:
  http_listen_port: 3100
  log_level: warn

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: "2024-01-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  allow_structured_metadata: true   # required for OTLP
  otlp_config:
    resource_attributes:
      ignore_defaults: true         # the defaults would index per-device ids
      attributes_config:
        - action: index_label
          attributes: [service.name, deployment.environment.name, ouo.platform]
    log_attributes:
      - action: index_label
        attributes: [event.name, ouo.platform]

analytics:
  reporting_enabled: false
```

</details>

**Mimir** stores metrics. Nothing in this shop sends any yet; it is here so the stack is the same
in every quickstart.

<details>
<summary><code>stack/40-mimir/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/40-mimir/compose.yaml -->
```yaml
# Mimir: stores metrics. The collector pushes the API's OTLP metrics to /otlp; Grafana queries
# it with PromQL on 9009 (/prometheus). Port 9009 is published on loopback for curl.
services:
  mimir:
    image: grafana/mimir:3.2.1
    command: ["-config.file=/etc/mimir/config.yaml"]
    ports:
      - "127.0.0.1:${OUO_MIMIR_PORT:-9009}:9009"
    volumes:
      - ./config.yaml:/etc/mimir/config.yaml:ro
      - mimir-data:/data

volumes:
  mimir-data:
```

</details>

<details>
<summary><code>stack/40-mimir/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/40-mimir/config.yaml -->
```yaml
# Mimir in monolithic mode (target: all) on one machine, filesystem storage.
# OTLP push at :9009/otlp/v1/metrics, PromQL at :9009/prometheus.
target: all
multitenancy_enabled: false

server:
  http_listen_port: 9009
  grpc_listen_port: 9095
  log_level: warn

common:
  storage:
    backend: filesystem
    filesystem:
      dir: /data/blocks

blocks_storage:
  storage_prefix: blocks
  bucket_store:
    sync_dir: /data/tsdb-sync
  tsdb:
    dir: /data/tsdb

compactor:
  data_dir: /data/compactor
  sharding_ring:
    instance_addr: 127.0.0.1
    kvstore: { store: memberlist }

distributor:
  ring:
    instance_addr: 127.0.0.1
    kvstore: { store: memberlist }

ingester:
  ring:
    instance_addr: 127.0.0.1
    replication_factor: 1
    kvstore: { store: memberlist }

store_gateway:
  sharding_ring:
    instance_addr: 127.0.0.1
    replication_factor: 1
    kvstore: { store: memberlist }

ruler_storage:
  storage_prefix: rules

alertmanager_storage:
  storage_prefix: alertmanager

memberlist:
  bind_addr: [127.0.0.1]
  join_members: []

limits:
  # Keep OTel metric names as sent: shop.orders becomes shop_orders, not shop_orders_total.
  otel_metric_suffixes_enabled: false
```

</details>

**rum-api** builds the session list from Loki and Tempo and stores the replay videos. Only the
collector and Grafana talk to it.

<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/50-rum-api/compose.yaml -->
```yaml
# rum-api: the ouo platform service behind the Grafana plugin. It builds the session list
# (healthy / errored / crashed) from Loki and Tempo and stores replay chunks the collector
# forwards. Internal: only the collector and Grafana talk to it, on 8080 inside the network.
services:
  rum-api:
    # `latest` follows each release. Tested with 0.5.0: pin `rum-api:0.5.0` or
    # `rum-api@sha256:1ee9e606220df2c42f4ade4131fdd3f82085d6e814676a771754a85a6ae78336` to stay on it.
    image: ghcr.io/ouo11y/rum-api:latest
    command: ["-config.file=/etc/rum-api/config.yaml", "-config.expand-env=true"]
    environment:
      GRAFANA_URL: http://localhost:${OUO_GRAFANA_PORT:-3000}   # for deep links
      OUO_INGEST_TOKEN: it_dev_0000000000000000   # the collector's; development value
      OUO_READ_TOKEN: rt_dev_0000000000000000     # Grafana's; development value
      DATA_DIR: /home/nonroot                     # the image runs as nonroot
      # rum-api's own traces and logs (0.5.0 and later), through the collector like the shop's.
      # Without these it retries localhost:4318 inside its container and logs every failure.
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel-collector:4318
      OTEL_EXPORTER_OTLP_HEADERS: Authorization=Basic%20ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_SERVICE_NAME: rum-api
    volumes:
      - ./config.yaml:/etc/rum-api/config.yaml:ro
      - rum-api-data:/home/nonroot
    depends_on: [loki, tempo, otel-collector]

volumes:
  rum-api-data:
```

</details>

<details>
<summary><code>stack/50-rum-api/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/50-rum-api/config.yaml -->
```yaml
# rum-api configuration: where Loki and Tempo are, and the session timeouts.
# The tokens come from the environment set in compose.yaml (-config.expand-env=true).
server:
  http_listen_address: ":8080"

auth:
  ingest_token: "${OUO_INGEST_TOKEN}"
  read_token: "${OUO_READ_TOKEN}"

loki:
  url: http://loki:3100
  datasource_uid: loki

tempo:
  url: http://tempo:3200
  datasource_uid: tempo

session:
  inactivity: 30m
  max_duration: 4h

# Where replay segments are stored. filesystem: files under DATA_DIR, here the rum-api-data volume
# (<dir>/replays/<session id>/, one mp4 per 5 s segment). For more than one rum-api, or real
# retention, use backend: s3 with MinIO or any S3 bucket:
#   storage:
#     backend: s3
#     s3: { endpoint: "minio:9000", bucket: ouo-replays, insecure: true, force_path_style: true,
#           access_key_id: ..., secret_access_key: ... }
storage:
  backend: filesystem
```

</details>

**Grafana** with the ouo11y RUM app: the UI for all of it.

<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/60-grafana/compose.yaml -->
```yaml
# Grafana with the ouo11y RUM app plugin: the UI for everything above. It reads Tempo, Loki and
# Mimir directly and sessions from rum-api through the plugin. Port 3000, admin / testing567.
# provisioning/ sets up the datasources and the plugin.
services:
  grafana:
    # `latest` follows each release. Tested with 0.5.0: pin `grafana:0.5.0` or
    # `grafana@sha256:57607a3616c88867644be1f69abb4681ca73df05d6bf2682543418f0dfeb622f` to stay on it.
    image: ghcr.io/ouo11y/grafana:latest
    ports:
      - "${OUO_GRAFANA_PORT:-3000}:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: testing567
      GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS: ouo11y-rum-app
      GF_SECURITY_DISABLE_FRONTEND_SANDBOX_FOR_PLUGINS: ouo11y-rum-app
      OUO_READ_TOKEN: rt_dev_0000000000000000   # read by provisioning/plugins; equals rum-api's
    volumes:
      - ./provisioning:/etc/grafana/provisioning:ro
    depends_on: [loki, tempo, mimir, rum-api]
```

</details>

<details>
<summary><code>stack/60-grafana/provisioning/datasources/datasources.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/60-grafana/provisioning/datasources/datasources.yaml -->
```yaml
# Grafana datasources: Loki (logs), Tempo (traces), Mimir (metrics), all inside the network.
# The uids are fixed because rum-api's config refers to them.
# Log lines with a trace_id link to the trace in Tempo.
apiVersion: 1

datasources:
  - name: Loki
    uid: loki
    type: loki
    url: http://loki:3100
    jsonData:
      derivedFields:
        - name: TraceID
          datasourceUid: tempo
          matcherType: label
          matcherRegex: trace_id
          url: "$${__value.raw}"
          urlDisplayLabel: View trace

  - name: Tempo
    uid: tempo
    type: tempo
    url: http://tempo:3200
    jsonData:
      lokiSearch:
        datasourceUid: loki

  - name: Mimir
    uid: mimir
    type: prometheus
    url: http://mimir:9009/prometheus
    isDefault: true
    jsonData:
      prometheusType: Mimir
      timeInterval: 15s
```

</details>

<details>
<summary><code>stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml -->
```yaml
# Enables the ouo11y RUM app (More apps -> ouo11y RUM) and points it at rum-api.
# Grafana adds the read token to every call it forwards; ${OUO_READ_TOKEN} comes from the
# container environment and must equal rum-api's.
apiVersion: 1

apps:
  - type: ouo11y-rum-app
    org_id: 1
    jsonData:
      rumApiUrl: http://rum-api:8080
    secureJsonData:
      readToken: ${OUO_READ_TOKEN}
```

</details>

Every credential in these files (`demo` / `pt_dev_demo_...`, the tokens, `admin` / `testing567`,
the DSN's public key) is a public development value: fine on your laptop, never on a server.

### 4c. Start it

The ouo images are private for now, so log in to ghcr.io once with a GitHub token that has
`read:packages`:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <github-user> --password-stdin
```

In the third terminal tab, from `tiny-shop-mobile-replay/`:

```bash
cd stack
```

```bash
docker compose up -d
```

```bash
docker compose ps
```

Six services, all `running`. The collector's log says the bridge is listening:

```bash
docker compose logs otel-collector | grep "Sentry bridge"
```

It prints `Starting Sentry bridge HTTP server` with `"endpoint": "[::]:4320", "projects": 1`.
Open http://localhost:3000 (admin / testing567): More apps -> **ouo11y RUM** is there, with no
sessions yet.

## Step 5. Trace the API

### 5a. The OpenTelemetry packages

In the backend tab, stop the API with Ctrl+C. From `backend/`:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/resources @opentelemetry/semantic-conventions
```

| Package | What it does here |
|---|---|
| `@opentelemetry/api` | the API your code calls: `trace.getTracer`, spans, status |
| `@opentelemetry/sdk-node` | starts tracing for a Node process in one object |
| `@opentelemetry/sdk-trace` | the span processors (`BatchSpanProcessor`) |
| `@opentelemetry/exporter-trace-otlp-http` | sends spans to the collector over OTLP/HTTP |
| `@opentelemetry/instrumentation-http` | a server span for every request, and reads `traceparent` |
| `@opentelemetry/instrumentation-express` | names those spans after the Express route |
| `@opentelemetry/resources` | the resource: who sends the spans |
| `@opentelemetry/semantic-conventions` | the standard attribute names (`service.name`, ...) |

### 5b. Start the SDK before the app

Create `backend/instrumentation.js`:

<details>
<summary><code>backend/instrumentation.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/backend/instrumentation.js -->
```js
// OpenTelemetry SDK init. Loaded before the app with `node --require ./instrumentation.js`
// so the http and express instrumentations can patch those modules before server.js loads them.
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

// The ouo collector, the only ingest. Moved ports? OUO_OTLP_ENDPOINT=http://localhost:14318
const endpoint = process.env.OUO_OTLP_ENDPOINT || "http://localhost:4318";

// Every request needs the project credential: Basic base64("<project id>:<project token>").
// This is the quickstart's `demo` project: base64("demo:pt_dev_demo_0000000000000000").
const exporter = new OTLPTraceExporter({
  url: `${endpoint}/v1/traces`,
  headers: { Authorization: "Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw" },
});

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "tiny-shop-mobile-replay-backend",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "local",
  }),
  // OTel JS 3.0: options object, `{ exporter }` (2.x took the exporter itself).
  spanProcessors: [new BatchSpanProcessor({ exporter })],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

sdk.start();
console.log(`[otel] tracing to ${endpoint}/v1/traces`);

const shutdown = () => sdk.shutdown().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

</details>

Replace `backend/server.js`: the same routes, with manual spans around the "database" and the
checkout, and the error recorded on the broken route.

<details>
<summary><code>backend/server.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/backend/server.js -->
```js
// The Tiny Shop API. HTTP server spans come from the auto-instrumentation; the spans below are manual.
// The app is native, so no CORS: it sends traceparent, baggage and sentry-trace and Express takes
// any header. The OpenTelemetry SDK reads traceparent and joins the app's trace.
const express = require("express");
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-mobile-replay-backend");
const app = express();
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4, description: "A bag of whole beans, roasted last week." },
  { id: 2, name: "Tea", price: 3, description: "Twenty bags of black tea." },
  { id: 3, name: "Cake", price: 6, description: "One slice of carrot cake." },
];

app.get("/api/products", async (req, res) => {
  // A manual span around a "database" call.
  const result = await tracer.startActiveSpan("db.select products", async (span) => {
    span.setAttribute("db.system.name", "fake-db");
    await sleep(50 + Math.random() * 100);
    span.setAttribute("app.products.count", products.length);
    span.end();
    return products;
  });
  res.json(result);
});

app.post("/api/checkout", async (req, res) => {
  const items = req.body.items || [];
  // A parent span with two nested children.
  await tracer.startActiveSpan("checkout", async (span) => {
    span.setAttribute("app.cart.items", items.length);
    await tracer.startActiveSpan("validate cart", async (child) => {
      await sleep(30);
      child.end();
    });
    await tracer.startActiveSpan("charge card", async (child) => {
      await sleep(120);
      child.addEvent("payment accepted");
      child.end();
    });
    span.end();
  });
  res.json({ ok: true, orderId: Math.floor(Math.random() * 100000) });
});

app.get("/api/fail", (req, res) => {
  // Enrich the auto-created HTTP span with the error.
  const span = trace.getActiveSpan();
  const err = new Error("inventory service unavailable");
  span?.recordException(err);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  res.status(500).json({ error: err.message });
});

const port = Number(process.env.API_PORT || 5001);
app.listen(port, () => console.log(`tiny-shop API on http://localhost:${port}`));
```

</details>

In `backend/package.json`, add a `start` script to `"scripts"`:

```json
"start": "node --require ./instrumentation.js server.js"
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces`. In the second tab:

```bash
curl localhost:5001/api/products
```

In Grafana, Explore -> Tempo -> Search, service `tiny-shop-mobile-replay-backend`: a
`GET /api/products` trace with its `db.select products` span.

## Step 6. Sentry in the app, pointed at the bridge

### 6a. The Sentry packages

In the app tab, from `app/`:

```bash
npm install --save-exact @sentry/react-native@8.32.0 @sentry/core@10.76.2
```

| Package | What it does here |
|---|---|
| `@sentry/react-native` | the Sentry SDK: JavaScript errors, sessions, traces, logs, taps, and the native SDK (sentry-cocoa) that records the replay and sends everything |
| `@sentry/core` | `startNewTrace`, to give each tap its own trace; the exact version `@sentry/react-native` 8.32.0 depends on |

<details>
<summary><b>Which Sentry package is which</b></summary>

| Package | Status | Why not / why |
|---|---|---|
| `@sentry/react-native` 8.x | current | what this guide uses; 8.30 and 8.32 are tested with the ouo bridge |
| `@sentry/react-native` 7.11 | older, but what `npx expo install @sentry/react-native` picks for Expo 57 | under Expo 57 it traces no `fetch` (so no trace reaches the API), and stamps transactions hours in the past. Sessions, errors and replay still work. Install 8.x with `npm install` as above |
| `sentry-expo` | deprecated since Expo 50 | replaced by `@sentry/react-native` and its Expo config plugin |
| `@sentry/browser`, `@sentry/react` | current, for web pages | no native crash handling, no mobile replay |
| `@sentry/core` | current, internal to the SDKs | normally not installed by apps; here for `startNewTrace`, which `@sentry/react-native` does not re-export. Pin the same version it depends on (`npm ls @sentry/core`) |

</details>

### 6b. Point it at the bridge

Replace `app/app.config.ts`. The new plugin line adds Sentry's native SDK to the iOS project;
`disableAutoUpload: true` keeps the build from calling sentry-cli or sentry.io.

<details>
<summary><code>app/app.config.ts</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/app.config.ts -->
```ts
// Tiny Shop Mobile: the Expo app config (it replaces app.json so it can read the environment).
// The app's own settings (API URL, Sentry DSN, replay sampling and masking) are EXPO_PUBLIC_*
// variables read in src/config.ts.
import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Tiny Shop",
  slug: "tiny-shop-mobile-replay",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: false,
    bundleIdentifier: process.env.IOS_BUNDLE_ID ?? "dev.ouo.tinyshop",
    // Plain http to the API and the Sentry bridge on this Mac (local development only).
    infoPlist: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } },
  },
  plugins: [
    // iOS 27 refuses to launch an app without the UIScene life cycle; Expo 57's template lacks it.
    "./plugins/withUIScene.js",
    // disableAutoUpload: the build never calls sentry-cli or sentry.io (no Sentry account here).
    ["@sentry/react-native", { disableAutoUpload: true }],
  ],
};

export default config;
```

</details>

Replace `app/src/config.ts`. Besides the API, it now names the DSN and three replay settings, all
read from `EXPO_PUBLIC_*` variables so you can rebuild with other values without editing code.

<details>
<summary><code>app/src/config.ts</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/config.ts -->
```ts
// Everything the app needs to know about where it sends data. EXPO_PUBLIC_* variables are written
// into the JavaScript bundle when Metro builds it: after changing one, rebuild the app.
export const config = {
  // The Tiny Shop API (backend/).
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001",
  // The ouo Sentry bridge, in Sentry DSN form: http://<public key>@<host>:<port>/<project id>.
  // The key and project id must match stack/10-collector/config.yaml. Never a sentry.io DSN here.
  sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "http://publickey0000000000000000000000@localhost:4320/1",
  // Share of sessions recorded from the start (1 = all, 0.1 = one in ten).
  replaySessionRate: Number(process.env.EXPO_PUBLIC_REPLAY_SESSION_RATE ?? "1"),
  // Share of the other sessions whose last minute is sent when an error happens.
  replayOnErrorRate: Number(process.env.EXPO_PUBLIC_REPLAY_ON_ERROR_RATE ?? "1"),
  // "on" (Sentry's default): every text, image and icon is a box in the replay. "off": the screen as it is.
  replayMasking: process.env.EXPO_PUBLIC_REPLAY_MASKING !== "off",
};
```

</details>

The DSN `http://publickey0000000000000000000000@localhost:4320/1` has the shape of any Sentry
DSN; only the host is the bridge. Its public key and project id (`1`) are the ones in
`stack/10-collector/config.yaml`.

Create `app/src/sentry.ts`, the whole Sentry setup:

<details>
<summary><code>app/src/sentry.ts</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/sentry.ts -->
```ts
// @sentry/react-native, pointed at the ouo Sentry bridge instead of sentry.io, with mobile
// Session Replay. Imported first by index.ts, before any screen.
import * as Sentry from "@sentry/react-native";
import { config } from "./config";

// One `navigation` transaction per screen change (App.tsx registers the navigation container).
export const navigationIntegration = Sentry.reactNavigationIntegration();

Sentry.init({
  dsn: config.sentryDsn,
  environment: "local",
  // Start the native SDK (sentry-cocoa) from JavaScript in every build. It sends everything:
  // JS errors, transactions, sessions and the replay all travel through the native transport.
  autoInitializeNativeSdk: true,

  // Traces: every screen and every tap that calls the API, joined with the API's spans.
  tracesSampleRate: 1,
  tracePropagationTargets: [config.apiUrl], // only our API gets trace headers
  propagateTraceparent: true, // W3C traceparent, which the OpenTelemetry API reads

  // Sentry.logger.* calls become log records (Loki lines in ouo).
  enableLogs: true,

  // Session Replay. A recorded session sends a 5 s video segment at a time, with its taps
  // and breadcrumbs. On-error: a session that was not picked keeps its last minute in memory
  // and sends it when an error is captured.
  replaysSessionSampleRate: config.replaySessionRate,
  replaysOnErrorSampleRate: config.replayOnErrorRate,
  integrations: [
    Sentry.mobileReplayIntegration({
      maskAllText: config.replayMasking,
      maskAllImages: config.replayMasking,
      maskAllVectors: config.replayMasking,
    }),
    navigationIntegration,
  ],
});

export { Sentry };
```

</details>

The lines that matter for this quickstart:

| Option | Value | What it does |
|---|---|---|
| `dsn` | the bridge | every envelope goes to ouo, none to sentry.io |
| `autoInitializeNativeSdk` | `true` | starts sentry-cocoa from JavaScript in every build. Without it, a Release build whose Expo plugin wrote a `sentry.options.json` sends nothing at all ([client setup, section 1](../../../docs/sentry-client-setup.md#1-point-the-dsn-at-the-bridge)) |
| `tracePropagationTargets`, `propagateTraceparent` | the API URL, `true` | the API gets W3C `traceparent` (OpenTelemetry reads it, not `sentry-trace`), so its spans join the app's trace; no other host gets trace headers |
| `enableLogs` | `true` | `Sentry.logger.info(...)` lines reach Loki with the session id |
| `replaysSessionSampleRate` | `1` (from `EXPO_PUBLIC_REPLAY_SESSION_RATE`) | every session is recorded from its start |
| `replaysOnErrorSampleRate` | `1` (from `EXPO_PUBLIC_REPLAY_ON_ERROR_RATE`) | a session that was not recorded sends what it kept in memory when an error is captured |
| `mobileReplayIntegration` | `maskAllText`, `maskAllImages`, `maskAllVectors` from `EXPO_PUBLIC_REPLAY_MASKING` | masking on (Sentry's default) or off for the whole app |

Replace `app/index.ts`: Sentry first, and the app wrapped, which records a breadcrumb for every
tap.

<details>
<summary><code>app/index.ts</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/index.ts -->
```ts
// Sentry first, so it sees the app start and every error after it.
import { Sentry } from "./src/sentry";
import { registerRootComponent } from "expo";
import App from "./App";

// Sentry.wrap: tap breadcrumbs (TouchEventBoundary) and the app start measurement.
registerRootComponent(Sentry.wrap(App));
```

</details>

### 6c. One trace from a tap to the API

Without care, Sentry sends requests made outside a transaction with a `traceparent` whose parent
span never exists, flagged "not sampled": the API drops its spans
([client setup, section 4](../../../docs/sentry-client-setup.md#4-requests-outside-a-transaction)).
So the first screen's request waits for the navigation container, and each tap gets its own
trace.

Replace `app/src/navigation.ts`:

<details>
<summary><code>app/src/navigation.ts</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/navigation.ts -->
```ts
// The screens, and a promise that resolves when the navigation container is ready.
import { createNavigationContainerRef } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Product } from "./api";

export type Screens = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};

export type ScreenProps<T extends keyof Screens> = NativeStackScreenProps<Screens, T>;

export const navigationRef = createNavigationContainerRef<Screens>();

let markReady: () => void = () => {};
/** Resolves in App.tsx's onReady, once Sentry's first screen transaction has started. */
export const navigationReady = new Promise<void>((resolve) => {
  markReady = resolve;
});
export const setNavigationReady = (): void => markReady();
```

</details>

Replace `app/src/api.ts`:

<details>
<summary><code>app/src/api.ts</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/api.ts -->
```ts
// The Tiny Shop API. Sentry's fetch instrumentation makes each call an http.client span and adds
// sentry-trace, baggage and traceparent, so the API's spans join the app's trace.
import { startNewTrace } from "@sentry/core";
import * as Sentry from "@sentry/react-native";
import { config } from "./config";
import { navigationReady, navigationRef } from "./navigation";

export type Product = { id: number; name: string; price: number; description: string };
export type Order = { ok: boolean; orderId: number };

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

// A request needs a span around it. Without one, Sentry still sends a traceparent, but with a
// parent span id that no span has and the "not sampled" flag: the API drops its spans.
// - The first screen loads before the navigation container is ready: wait (a few ms) so the
//   request belongs to the screen's transaction.
// - A tap gets its own trace and transaction, named after what the user did.
async function inScreen<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!navigationRef.isReady()) await navigationReady;
  if (Sentry.getActiveSpan()) return run();
  return tap(name, run);
}

// startNewTrace: without it every tap reuses the trace id of the last screen change.
export function tap<T>(name: string, run: () => Promise<T>): Promise<T> {
  return startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, run));
}

export const getProducts = () => inScreen("Load products", () => request<Product[]>("GET", "/api/products"));
export const checkout = (items: { id: number; qty: number }[]) =>
  tap("Checkout", () => request<Order>("POST", "/api/checkout", { items }));
export const callBrokenApi = () => tap("Call broken API", () => request<unknown>("GET", "/api/fail"));

export const formatPrice = (n: number) => `$${n.toFixed(2)}`;
```

</details>

Replace `app/App.tsx`: the container registers with Sentry's navigation integration (one
transaction per screen) and marks itself ready.

<details>
<summary><code>app/App.tsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/App.tsx -->
```tsx
// Tiny Shop Mobile: three screens in a native stack, the cart shared by all of them.
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import { navigationRef, setNavigationReady, type Screens } from "./src/navigation";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";
import { navigationIntegration } from "./src/sentry";

const Stack = createNativeStackNavigator<Screens>();

export default function App() {
  return (
    <CartProvider>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          navigationIntegration.registerNavigationContainer(navigationRef);
          setNavigationReady();
        }}
      >
        <Stack.Navigator>
          <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
          <Stack.Screen name="Product" component={ProductScreen} options={({ route }) => ({ title: route.params.product.name })} />
          <Stack.Screen name="Cart" component={CartScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </CartProvider>
  );
}
```

</details>

### 6d. Taps, logs, errors and masks

Replace `app/src/ui.tsx`: each button now has a `sentry-label`, the name its tap gets on the
timeline (when masking allows it, step 9).

<details>
<summary><code>app/src/ui.tsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/ui.tsx -->
```tsx
// A button and the shared styles.
import { Pressable, StyleSheet, Text } from "react-native";

// `label` also becomes `sentry-label`, the name Sentry gives the tap breadcrumb. Sentry reads it
// only when text masking is off: with masking on, a label could be personal data.
export function Button({ label, onPress, kind = "primary" }: { label: string; onPress: () => void; kind?: "primary" | "debug" }) {
  return (
    <Pressable
      sentry-label={label}
      onPress={onPress}
      style={({ pressed }) => [styles.button, kind === "debug" && styles.debug, pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fafafa" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, backgroundColor: "white", borderRadius: 8 },
  image: { width: 48, height: 48, borderRadius: 8 },
  name: { fontSize: 17, fontWeight: "600" },
  price: { fontSize: 15, color: "#555" },
  section: { fontSize: 13, fontWeight: "700", color: "#888", textTransform: "uppercase", marginTop: 12 },
  note: { fontSize: 14, color: "#333" },
  button: { backgroundColor: "#4b3fcc", padding: 14, borderRadius: 8, alignItems: "center" },
  debug: { backgroundColor: "#a33" },
  pressed: { opacity: 0.6 },
  buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
});
```

</details>

Replace `app/src/screens/ProductsScreen.tsx`: **Handled error** now reports the error with
`Sentry.captureException`, and **Call broken API** writes a log line.

<details>
<summary><code>app/src/screens/ProductsScreen.tsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/screens/ProductsScreen.tsx -->
```tsx
// Products: the list from GET /api/products, and the Debug section.
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { callBrokenApi, formatPrice, getProducts, type Product } from "../api";
import type { ScreenProps } from "../navigation";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function ProductsScreen({ navigation }: ScreenProps<"Products">) {
  const [products, setProducts] = useState<Product[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => {
    getProducts()
      .then(setProducts)
      .catch((e: Error) => setStatus(`Could not load products: ${e.message}`));
  }, []);

  const brokenApi = () =>
    callBrokenApi().catch((e: Error) => {
      Sentry.logger.warn(`broken API answered: ${e.message}`);
      setStatus(e.message);
    });

  const handledError = () => {
    try {
      JSON.parse("{ this is not json");
    } catch (e) {
      // A handled error: the app keeps running, the session becomes `errored`.
      Sentry.captureException(e);
      setStatus("Handled error sent");
    }
  };

  const throwError = () => {
    // An error nothing catches: in a Release build the app closes, the session is `crashed`.
    setTimeout(() => {
      throw new Error("Tiny Shop crashed on purpose");
    });
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {products.map((p) => (
        <Pressable key={p.id} sentry-label={`Product ${p.name}`} style={styles.row} onPress={() => navigation.navigate("Product", { product: p })}>
          <Image source={require("../../assets/icon.png")} style={styles.image} />
          <View>
            <Text style={styles.name}>{p.name}</Text>
            <Text style={styles.price}>{formatPrice(p.price)}</Text>
          </View>
        </Pressable>
      ))}
      <Text style={styles.section}>Debug</Text>
      <Button kind="debug" label="Call broken API" onPress={brokenApi} />
      <Button kind="debug" label="Handled error" onPress={handledError} />
      <Button kind="debug" label="Throw error" onPress={throwError} />
      {status ? <Text style={styles.note}>{status}</Text> : null}
    </ScrollView>
  );
}
```

</details>

Replace `app/src/screens/ProductScreen.tsx`: a log line per **Add to cart**, and the price inside
`<Sentry.Unmask>`, so it shows in the replay even with masking on.

<details>
<summary><code>app/src/screens/ProductScreen.tsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/screens/ProductScreen.tsx -->
```tsx
// Product: the detail of one product, and "Add to cart".
import { Image, Text, View } from "react-native";
import { formatPrice } from "../api";
import { useCart } from "../cart";
import type { ScreenProps } from "../navigation";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function ProductScreen({ route, navigation }: ScreenProps<"Product">) {
  const { product } = route.params;
  const cart = useCart();

  const add = () => {
    cart.add(product);
    Sentry.logger.info(`cart.add ${product.name}`, { "product.id": product.id });
  };

  return (
    <View style={styles.screen}>
      <Image source={require("../../assets/icon.png")} style={{ width: "100%", height: 200, borderRadius: 12 }} resizeMode="contain" />
      <Text style={styles.name}>{product.name}</Text>
      {/* Unmask: the price shows in the replay even when masking is on. */}
      <Sentry.Unmask>
        <Text style={styles.price}>{formatPrice(product.price)}</Text>
      </Sentry.Unmask>
      <Text style={styles.note}>{product.description}</Text>
      <Button label="Add to cart" onPress={add} />
      <Button label={`Go to cart (${cart.count})`} onPress={() => navigation.navigate("Cart")} />
    </View>
  );
}
```

</details>

Replace `app/src/screens/CartScreen.tsx`: a log line per order, the total unmasked, and the
address and card inside `<Sentry.Mask>`, hidden in every replay even with masking off.

<details>
<summary><code>app/src/screens/CartScreen.tsx</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-replay/result/app/src/screens/CartScreen.tsx -->
```tsx
// Cart: the lines, where it ships, and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { checkout, formatPrice } from "../api";
import { useCart } from "../cart";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [status, setStatus] = useState("");

  const pay = () => {
    const total = cart.total;
    checkout(cart.lines.map((l) => ({ id: l.product.id, qty: l.qty })))
      .then((order) => {
        Sentry.logger.info(`checkout order ${order.orderId} ${formatPrice(total)}`, { "order.id": order.orderId });
        cart.clear();
        setStatus(`Order #${order.orderId} placed`);
      })
      .catch((e: Error) => setStatus(`Checkout failed: ${e.message}`));
  };

  return (
    <View style={styles.screen}>
      {cart.lines.map((l) => (
        <Text key={l.product.id} style={styles.note}>
          {l.qty} x {l.product.name} {formatPrice(l.qty * l.product.price)}
        </Text>
      ))}
      <Sentry.Unmask>
        <Text style={styles.name}>Total {formatPrice(cart.total)}</Text>
      </Sentry.Unmask>
      <Text style={styles.section}>Ship to</Text>
      {/* Mask: hidden in every replay, even when masking is off. */}
      <Sentry.Mask>
        <Text style={styles.note}>Jane Doe, 12 Sample Street, Springfield</Text>
        <Text style={styles.note}>Card ending 4242</Text>
      </Sentry.Mask>
      <Button label="Checkout" onPress={pay} />
      {status ? <Text style={styles.note}>{status}</Text> : null}
    </View>
  );
}
```

</details>

`app/src/cart.tsx` does not change.

## Step 7. Build a Release app

### 7a. Why Release

Mobile replay records in a Debug build too: checked with `@sentry/react-native` 8.32 on the
iOS 27 simulator, a Debug session served by Metro had its replay. From here on this guide still
builds Release, because that is what your users run:

- **Throw error** closes the app, as it would in production. In a Debug build React Native's red
  error screen (LogBox) catches the error, the app stays open, and that red screen is what the
  replay shows.
- No Metro and no dev menu: the JavaScript is inside the app and optimised, so what you see in
  the replay, and how often a frame is janky, is closer to a real phone.

### 7b. Build it

Step 3 generated `app/ios/` before Sentry was in `app.config.ts`. Generate it again so the Sentry
config plugin adds its native SDK and build phases. From `app/`:

```bash
npx expo prebuild --clean --platform ios
```

Then build and install a Release app:

```bash
npx expo run:ios --configuration Release --no-bundler
```

The first Release build takes about 5 minutes; the next ones about 30 seconds, since only the
JavaScript bundle changes. `--no-bundler` skips Metro: a Release app carries its JavaScript inside
it. The log shows `SENTRY_DISABLE_AUTO_UPLOAD=true, skipping sourcemaps upload`: nothing goes to
sentry.io.

`EXPO_PUBLIC_*` values are written into the bundle at build time: every change of masking or
sampling below is a new `npx expo run:ios --configuration Release --no-bundler` with the variable
set in front of it.

## Step 8. Shop, then watch the replay

In the simulator, tap:

1. **Coffee**, **Add to cart** twice, **Go to cart (2)**, **Checkout**: "Order #… placed".
2. Back twice to **Tiny Shop**, then **Call broken API** and **Handled error**.
3. Press Cmd+Shift+H: the app goes to the background and sends its last replay segment.

In Grafana, More apps -> ouo11y RUM -> **Sessions**. The newest `tiny-shop-mobile-replay-app`
session is `errored` (1 error, 1 failed request) and its row says it has a replay. Open it.

**The replay.** The **Replay** panel plays the session as a video, one frame per second, with a
dot where each tap landed and the scrubber marked with taps, errors, failed requests and screen
changes. The badge under it says `masked`. Every text, image and icon is a grey box, except the
prices and the cart total, which are inside `<Sentry.Unmask>`.

**The activity list** next to it, filtered by **Taps**, has one line per tap, with the
component path and the position, for example
`Tap View · View > Pressable > View > Text · at 201, 459`. Click a line and the replay jumps to
that tap. Masking also hides the button's label (step 9).

**From a tap to the API.** The **Traces** list has one trace per screen and per tap. Open
`Checkout` in Explore: the app's `Checkout` and `POST` spans, then the API's
`POST /api/checkout`, `checkout`, `validate cart` and `charge card`, one trace id, every parent
present. The app's spans carry the session's `session.id`, added by the bridge.

**Logs.** The **Logs** panel, and Explore -> Loki -> `{service_name="tiny-shop-mobile-replay-app"}`,
show `cart.add Coffee`, `checkout order 29618 $8.00`, `broken API answered: HTTP 500 from ...`
and the error `SyntaxError: JSON Parse error: ...` with its stack.

## Step 9. Masking off, and per view

Build again with masking off. From `app/`:

```bash
EXPO_PUBLIC_REPLAY_MASKING=off npx expo run:ios --configuration Release --no-bundler
```

Shop the same way and open the new session. What changed:

| On screen | Masking on (default) | Masking off |
|---|---|---|
| product names, descriptions, buttons | grey boxes | visible |
| product image | grey box | visible |
| prices, cart total (`<Sentry.Unmask>`) | visible | visible |
| address and card (`<Sentry.Mask>`) | grey box | grey box |
| tap target in the activity list | a component name: `View`, `ScrollView` | the `sentry-label`: `Add to cart`, `Checkout` |
| badge under the replay | `masked` | `not masked` |

Masking happens on the device, before the frame is encoded: a masked text never leaves the phone,
not even to ouo. The tap labels follow the same rule. With text masking on, Sentry does not read
`sentry-label` or the button's text, because a label can be personal data too: look at
`Go to cart (2)`, which carries the cart count.

Keep masking on in a real app. Use `<Sentry.Unmask>` for what is safe and useful to see (prices,
static headings) and `<Sentry.Mask>` for what must stay hidden even in a build that unmasks.

## Step 10. Replay only the sessions with an error

Recording every session costs storage and upload bandwidth on your users' phones. The usual
production setting records a small share of sessions from the start and keeps the others in a
buffer that is sent only when an error happens. Build with no session sampling (masking back on):

```bash
EXPO_PUBLIC_REPLAY_SESSION_RATE=0 npx expo run:ios --configuration Release --no-bundler
```

1. Tap **Coffee**, **Add to cart**, back. No error.
2. Press Cmd+Shift+H and wait 40 seconds: Sentry ends a session that spent 30 s in the
   background.
3. Open Tiny Shop again (a new session), tap **Tea**, back, then **Handled error**.
4. Cmd+Shift+H again.

In ouo11y RUM, the first session is `healthy` with no replay. The second is `errored` and has
one: its first segment starts about 30 seconds before the error (what the SDK kept in memory),
and recording goes on until the app leaves the foreground. In the chunk files its type is
`buffer`, against `session` for a sampled one.

| `replaysSessionSampleRate` | `replaysOnErrorSampleRate` | Which sessions have a replay |
|---|---|---|
| 1 | 1 | all (this quickstart until now) |
| 0.1 | 1 | one in ten from the start, and every session with an error from 30 s before it |
| 0 | 1 | only sessions with an error |
| 0 | 0 | none |

Two limits, both seen on this build: a request that answers 500 is not a Sentry error event, so
**Call broken API** alone does not send the buffer (ouo still counts the session as errored);
and **Throw error**, a JavaScript crash, kills the app before the buffer is sent, so a crashed
session that was not recorded from its start has no replay.

## Step 11. What it cost

Each segment is an H.264 mp4 at one frame per second, in points (402 x 874 on an iPhone 18 Pro).
rum-api stores one `<seq>.mp4` and one small `<seq>.json.gz` (times, touches) per segment, under
`replays/<session id>/` on its volume. The rum-api image has no shell, so look with a throwaway
container on the volume:

```bash
docker run --rm -v tiny-shop-mobile-replay_rum-api-data:/d alpine du -sh /d/replays
```

Measured on this quickstart: the step 8 session, 115 seconds in the foreground, is 20 segments and
120 KB of video (4 to 10 KB per 5 to 6 s segment), 127 KB with the touch files: about **1 KB per
second of foreground**, about 4 MB per hour. Screens that change more (scrolling, animations)
make bigger segments; a still screen costs almost nothing. The phone uploads the same bytes, one
request per segment. For more than one rum-api, or retention rules, use S3 storage: the commented
example is in `stack/50-rum-api/config.yaml`.

The CPU cost is on the phone: sentry-cocoa takes a screenshot of the window once a second, masks
it and encodes it. Sentry's own figures for iOS and the options to lower it
(`enableViewRendererV2`, `enableFastViewRendering`) are in the `mobileReplayIntegration` options.

## Step 12. Mobile replay vs web replay

ouo has a web replay too ([tiny-shop-otel](../../quickstarts/tiny-shop-otel/README.md) records
one with rrweb). They look alike
in the plugin, but they are not the same thing:

| | Web replay (`@ouo11y/browser`, rrweb) | Mobile replay (Sentry, through the bridge) |
|---|---|---|
| What is recorded | the DOM and its changes, as events | a video of the screen, 1 frame per second |
| What the bridge receives | n/a (the SDK sends rrweb chunks to 4319) | `replay_video` items: mp4 segments, touch positions and breadcrumbs |
| Playback | rebuilt page, smooth, any zoom | the video, 1 fps: fast gestures and animations are skipped |
| Inspect an element, copy its text | yes | no: there is no element, only pixels |
| What a tap or click hit | the element, from the DOM | a component path from the tap breadcrumb (React Native names, or your `sentry-label` when masking is off), and a position |
| Masking | at record time, by element (`maskAllInputs`, classes, selectors) | at record time, by view (`maskAllText`, `maskAllImages`, `<Sentry.Mask>`, `<Sentry.Unmask>`) |
| Rage clicks / taps | `ouo.rage_click` on the timeline | not detected by ouo. Sentry's SDK emits `ui.multiClick` breadcrumbs (3 taps within 1 s); the bridge shows them as a plain breadcrumb |
| Dead clicks / taps | `ouo.dead_click` | none: the bridge cannot see whether the screen changed after a tap |
| Size | KB of JSON per minute, more for busy DOMs | about 1 KB per second of video, more for busy screens |

What that means for you:

- Use the mobile replay to **see** what happened: which screen, which tap, what the user saw
  when the error came. Do not expect to search for an element or measure a layout in it.
- Name your touchables with `sentry-label` and run Unmask on safe views, or the activity list
  will say `View` and `Pressable`.
- Treat `ui.multiClick` breadcrumbs as a hint of rage taps, and know that in a masked build every
  button looks alike to the detector: three quick taps on three different buttons count (in this
  quickstart's test run, **Add to cart** twice then **Go to cart** within one second made one).
- Dead taps, scroll depth, and "tap on something that is not a button" need the screen's
  structure, which a video does not carry. They are on ouo's list for its own mobile SDK.

## Step 13. Clean up

From `stack/`:

```bash
docker compose down
```

Add `-v` to delete the data and the replays. Stop the API with Ctrl+C. To remove the app, touch
and hold its icon in the simulator, or:

```bash
xcrun simctl uninstall booted dev.ouo.tinyshop
```

## When something does not work

| Symptom | Cause | Fix |
|---|---|---|
| No session at all in ouo11y RUM | wrong DSN, a DSN key the bridge does not know, or the native SDK never started | the DSN's public key and project id must match `ouosentry.projects` in `stack/10-collector/config.yaml`; `sentry.ts` must keep `autoInitializeNativeSdk: true`; rebuild |
| A session, but no replay | not sampled: `replaysSessionSampleRate` below 1 and no error in the session | check `EXPO_PUBLIC_REPLAY_SESSION_RATE` at build time; a JavaScript crash never sends the on-error buffer (step 10) |
| A change of `EXPO_PUBLIC_*` has no effect | `CI` is set in your shell: Expo's embed step then keeps Metro's cache between builds, and the old values with it | rebuild in a shell without `CI` (`unset CI`) |
| The plugin says "segment N could not be played: not a playable mp4" | the segment request was refused: your Grafana session expired, often because another Grafana on `localhost` (another port) logged you out, cookies ignore ports | log in again, or open this Grafana as `http://127.0.0.1:3000` |
| API spans in a separate trace, or none | `traceparent` not sent (wrong `tracePropagationTargets`), or a request with no active span | `tracePropagationTargets` must match the API URL; keep `inScreen` / `tap` in `api.ts` |
| The app closes at launch on iOS 27 | the UIScene plugin is missing from `app.config.ts` | add `./plugins/withUIScene.js`, then `npx expo prebuild --clean --platform ios` |
| An `App Hang` error in an otherwise clean session | sentry-cocoa reports the main thread blocked 2 s or more; a busy simulator does that | expected on a loaded Mac; it makes the session `errored`. Turn it off with `enableAppHangTracking: false` if it is noise |
| A newer `latest` image keeps restarting | its config format changed | `docker compose logs <service>`; pin the tested version named above the `image:` line |
