# Keep Sentry, add ouo: Tiny Shop Mobile through the Sentry bridge

This guide is for teams whose React Native app already reports to Sentry with
`@sentry/react-native`, and who want ouo next to it without touching the SDK. The app keeps its
Sentry setup; only the **host** of its DSN changes, to the ouo Sentry bridge. The bridge forwards
every envelope to your Sentry byte for byte, hands Sentry's answer back to the app, and
translates a copy into ouo: sessions, errors, spans, logs and the replay video. Your API, traced
with OpenTelemetry, joins the app's traces in ouo.

```
                                 the same bytes                 Sentry's answer, unchanged
app (@sentry/react-native) ──► ouo Sentry bridge :4320 ──────────────► your Sentry (sentry.io or self-hosted)
          │                          │
          │ traceparent              └─ a copy, once Sentry accepted it ─► ouo: Loki, Tempo, rum-api ─► Grafana
          ▼                                                                       ▲
API (OpenTelemetry Node) ──────── OTLP :4318 ─────────────────────────────────────┘
```

You build, one step at a time, with no scripts:

1. a plain Express API and a plain Expo app with three screens, with no telemetry at all;
2. Sentry in the app, pointed straight at your Sentry: where a Sentry team is today;
3. the ouo stack (the ouo collector with its Sentry bridge, Tempo, Loki, Mimir, rum-api,
   Grafana), one folder per service, with your Sentry as the bridge's upstream;
4. the DSN host switched to the bridge, and the API traced with OpenTelemetry;
5. the same session in Sentry and in ouo11y RUM, side by side, and what each one shows that the
   other does not.

At the end your files are the same as [`result/`](result): compare with them when you are
stuck. Plan on about 60 minutes, 15 of them for the first iOS builds.

```
tiny-shop-mobile-sentry/
├── stack/      the ouo stack, one folder per service; the Sentry bridge in 10-collector
├── backend/    Express API, OpenTelemetry traces
└── app/        Expo app (React Native), @sentry/react-native
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`tiny-shop-mobile-sentry/`, wherever you create it, and each command says which of its folders it
runs in. When a step says "replace the file", select everything in it and paste the new content
over it.

**You need a Sentry project** to forward to: a project on sentry.io, or on a self-hosted Sentry
(any 24.x or newer; this guide was checked against self-hosted Sentry 26.10). Use a test project
if you can: everything the app sends in this guide lands there. No Sentry at all? Do
[Tiny Shop Mobile](../index.md) (M1) instead, where the bridge runs without an upstream.

## How the DSN changes

Your Sentry DSN has three parts. The bridge keeps two of them and replaces the host:

```
your Sentry DSN   https://<public key>@<sentry host>/<project id>
through ouo       http://<public key>@localhost:4320/<project id>      (here; in production https://<public key>@sentry-bridge.example.com/<project id>)
```

| Your Sentry | Example DSN | The bridge's upstream (`OUO_SENTRY_UPSTREAM`) |
|---|---|---|
| sentry.io | `https://3f2a…c9@o4507123.ingest.de.sentry.io/4508765` | `https://o4507123.ingest.de.sentry.io` (the DSN's host, with its region) |
| self-hosted | `https://3f2a…c9@sentry.example.com/2` | `https://sentry.example.com` |
| self-hosted on this machine | `http://3f2a…c9@localhost:9000/2` | `http://host.docker.internal:9000` (the bridge runs in Docker) |

The public key and project id go into the bridge's project table too (`OUO_SENTRY_PUBLIC_KEY`,
`OUO_SENTRY_PROJECT_ID`): the bridge accepts only the keys it knows (`403` otherwise, and nothing
is forwarded), and stores what it translates under the ouo project `demo`.

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

Docker Desktop must be running. This prints the server details, not "Cannot connect":

```bash
docker info
```

Xcode 27 with an iOS 27 simulator runtime (Xcode -> Settings -> Components), and CocoaPods:

```bash
xcodebuild -version
```

```bash
pod --version
```

CocoaPods fails with `Unicode Normalization not appropriate for ASCII-8BIT` when your shell has
no UTF-8 locale. This prints `en_US.UTF-8` (or another `.UTF-8`); if it prints nothing, add
`export LANG=en_US.UTF-8` to your `~/.zshrc` and open a new terminal:

```bash
echo $LANG
```

VS Code's `code` command. If it is not found, open VS Code, press Cmd+Shift+P and run
**Shell Command: Install 'code' command in PATH**.

```bash
code --version
```

## Step 1. Create the folders and open VS Code

From the folder where you keep your projects:

```bash
mkdir -p tiny-shop-mobile-sentry/backend tiny-shop-mobile-sentry/stack
```

```bash
cd tiny-shop-mobile-sentry
```

```bash
code .
```

In VS Code, open a terminal with Ctrl+\`. You will use three terminal tabs (the `+` button): one
for the backend, one for the app, one for the stack. Each new tab opens in
`tiny-shop-mobile-sentry/`.

## Step 2. A simple API, no telemetry yet

In the first terminal tab, from `tiny-shop-mobile-sentry/`:

```bash
cd backend
```

```bash
npm init -y
```

```bash
npm install express
```

Create `backend/server.js`:

```js
const express = require("express");

const app = express();
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4 },
  { id: 2, name: "Tea", price: 3 },
  { id: 3, name: "Cake", price: 6 },
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

No CORS middleware: a native app sends no preflight request. Run it:

```bash
node server.js
```

In another terminal tab, check that it answers:

```bash
curl localhost:5001/api/products
```

You get the three products as JSON. Leave the API running. Port 5001 taken? Start it with
`API_PORT=5002 node server.js`, and use that port wherever the guide says 5001.

## Step 3. The app, no telemetry yet

### 3a. Create it

In the second terminal tab, from `tiny-shop-mobile-sentry/` (the template creates `app/`). Expo
SDK 58 is out, but this guide is written for SDK 57 (React Native 0.86), hence the `@sdk-57`:

```bash
npx create-expo-app@latest app --template blank-typescript@sdk-57
```

```bash
cd app
```

React Navigation and its two native dependencies, in the versions Expo 57 pins:

```bash
npx expo install @react-navigation/native @react-navigation/native-stack react-native-screens react-native-safe-area-context
```

| Package | What it does here |
|---|---|
| `@react-navigation/native` | navigation container and hooks |
| `@react-navigation/native-stack` | the screen stack, on UIKit's native navigation controller |
| `react-native-screens` | the native screens the stack uses |
| `react-native-safe-area-context` | keeps content out of the notch and the home indicator |

The template also writes `AGENTS.md`, `.claude/` (notes for AI coding assistants) and `LICENSE`.
`result/app/` leaves them out; keep or delete them, nothing here uses them.

### 3b. iOS 27 needs the UIScene life cycle

iOS 27 stops an app at launch unless it uses scenes, and the Expo 57 template does not set them
up yet. This config plugin adds the scene manifest and a `SceneDelegate` when Expo generates the
iOS project. Create `app/plugins/withUIScene.js`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/plugins/withUIScene.js -->
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

Replace `app/app.json` with the following. It names the app, gives it a bundle id and turns on
the plugin. Step 4 adds Sentry's plugin to the same list.

```json
{
  "expo": {
    "name": "Tiny Shop",
    "slug": "tiny-shop-mobile",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "ios": {
      "supportsTablet": false,
      "bundleIdentifier": "dev.ouo.tinyshop.m4"
    },
    "android": {
      "adaptiveIcon": {
        "backgroundColor": "#E6F4FE",
        "foregroundImage": "./assets/android-icon-foreground.png",
        "backgroundImage": "./assets/android-icon-background.png",
        "monochromeImage": "./assets/android-icon-monochrome.png"
      },
      "predictiveBackGestureEnabled": false
    },
    "web": {
      "favicon": "./assets/favicon.png"
    },
    "plugins": ["./plugins/withUIScene.js"]
  }
}
```

### 3c. The screens

Three screens: **Products** (the list, and a Debug section), **Product** (one product, "Add to
cart") and **Cart** ("Checkout"). Two small files first, which do not change later.

Create `app/src/cart.tsx`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/src/cart.tsx -->
```tsx
// The cart: plain React state shared by the three screens. No telemetry here.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Product } from "./api";

type Cart = { items: Product[]; add: (p: Product) => void; clear: () => void };
const CartContext = createContext<Cart | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Product[]>([]);
  const add = (p: Product) => setItems((prev) => [...prev, p]);
  const clear = () => setItems([]);
  return <CartContext.Provider value={{ items, add, clear }}>{children}</CartContext.Provider>;
}

export function useCart(): Cart {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart outside CartProvider");
  return cart;
}
```

Create `app/src/ui.tsx`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/src/ui.tsx -->
```tsx
// Two small building blocks so the screens stay short.
import { Pressable, StyleSheet, Text } from "react-native";

export function Button({ title, onPress, kind = "primary" }: { title: string; onPress: () => void; kind?: "primary" | "debug" }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.button, kind === "debug" && styles.debug]}>
      <Text style={styles.label}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fff" },
  row: { padding: 14, borderRadius: 8, backgroundColor: "#f2f2f2", flexDirection: "row", justifyContent: "space-between" },
  title: { fontSize: 22, fontWeight: "600" },
  text: { fontSize: 16 },
  muted: { fontSize: 14, color: "#666" },
  button: { padding: 14, borderRadius: 8, backgroundColor: "#2f6fed", alignItems: "center" },
  debug: { backgroundColor: "#8a8a8a" },
  label: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
```

Create `app/src/api.ts`, the API client. `EXPO_PUBLIC_*` variables come from `app/.env` (step
4) and are written into the JavaScript bundle when Metro builds it:

```ts
// The API client: plain fetch, no telemetry yet.
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

export type Product = { id: number; name: string; price: number };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

export const getProducts = () => request<Product[]>("/api/products");

export const checkout = (items: Product[]) =>
  request<{ ok: boolean; orderId: number }>("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: items.map((p) => p.id) }),
  });

export const callBrokenApi = () => request<unknown>("/api/fail");
```

Create `app/src/screens/ProductsScreen.tsx`:

```tsx
// Products: the list from GET /api/products, and two Debug buttons.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { callBrokenApi, getProducts, type Product } from "../api";
import { Button, styles } from "../ui";
import type { Screens } from "../../App";

export function ProductsScreen({ navigation }: NativeStackScreenProps<Screens, "Products">) {
  const [products, setProducts] = useState<Product[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getProducts().then(setProducts, (e: Error) => setMessage(e.message));
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {products.map((p) => (
        <Pressable key={p.id} accessibilityRole="button" style={styles.row} onPress={() => navigation.navigate("Product", { product: p })}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.text}>${p.price}</Text>
        </Pressable>
      ))}
      <Button title="Cart" onPress={() => navigation.navigate("Cart")} />

      <View style={{ height: 24 }} />
      <Text style={styles.muted}>Debug</Text>
      <Button kind="debug" title="Call broken API" onPress={() => callBrokenApi().catch((e: Error) => setMessage(e.message))} />
      <Button
        kind="debug"
        title="Throw error"
        onPress={() => {
          setTimeout(() => {
            throw new Error("Cart total is NaN");
          });
        }}
      />
      {message ? <Text style={styles.muted}>{message}</Text> : null}
    </ScrollView>
  );
}
```

Create `app/src/screens/ProductScreen.tsx`:

```tsx
// Product: one product and "Add to cart".
import { Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCart } from "../cart";
import { Button, styles } from "../ui";
import type { Screens } from "../../App";

export function ProductScreen({ route, navigation }: NativeStackScreenProps<Screens, "Product">) {
  const { product } = route.params;
  const cart = useCart();
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button
        title="Add to cart"
        onPress={() => {
          cart.add(product);
          navigation.goBack();
        }}
      />
    </View>
  );
}
```

Create `app/src/screens/CartScreen.tsx`:

```tsx
// Cart: what was added, and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { checkout } from "../api";
import { useCart } from "../cart";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [message, setMessage] = useState("");
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  const onCheckout = () =>
    checkout(cart.items).then(
      (order) => {
        cart.clear();
        setMessage(`Order ${order.orderId} placed`);
      },
      (e: Error) => setMessage(e.message),
    );

  return (
    <View style={styles.screen}>
      {cart.items.map((p, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.text}>${p.price}</Text>
        </View>
      ))}
      <Text style={styles.text}>Total ${total}</Text>
      <Button title="Checkout" onPress={onCheckout} />
      {message ? <Text style={styles.muted}>{message}</Text> : null}
    </View>
  );
}
```

Replace `app/App.tsx` with:

```tsx
// The app: three screens in a native stack.
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import type { Product } from "./src/api";
import { CartProvider } from "./src/cart";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

export type Screens = { Products: undefined; Product: { product: Product }; Cart: undefined };

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

### 3d. Run it on the simulator

The first build generates `app/ios/`, installs the pods and compiles the app, about 8 minutes;
then it starts Metro and opens the app on the simulator. From `app/`:

```bash
npx expo run:ios
```

You see **Tiny Shop** with Coffee, Tea and Cake (the app reached your API). Tap **Coffee**, then
**Add to cart**, then **Cart** and **Checkout**: "Order … placed". Leave Metro running in this
tab; press `r` in it to reload the app after you change a file.

## Step 4. Sentry in the app, pointed at your Sentry

This is where a team on Sentry starts: the app reports straight to Sentry. Nothing in this step is
specific to ouo, and step 6 changes only the DSN.

### 4a. Install the SDK

Stop Metro (Ctrl+C). From `app/`:

```bash
npm install --save-exact @sentry/react-native@8.32.0 @sentry/core@10.76.2
```

| Package | What it does here |
|---|---|
| `@sentry/react-native` | the Sentry SDK: JavaScript errors, `fetch` spans, screen transactions, structured logs, and on iOS the native SDK (sentry-cocoa) for crashes, release-health sessions and session replay |
| `@sentry/core` | the SDK's core, which `@sentry/react-native` uses; installed directly only for `startNewTrace` (each button press its own trace), which `@sentry/react-native` does not re-export. Keep it at the exact version `@sentry/react-native` depends on |

<details>
<summary>Which Sentry package and version (click to open)</summary>

| Package | Status | Here |
|---|---|---|
| `@sentry/react-native` 8.x | current | used, 8.32.0. The ouo bridge is tested on 8.30.0 and 8.32.0 ([compatibility](../../../docs/compatibility.md#sentry-sdks-through-the-bridge)) |
| `@sentry/react-native` 7.11.0 | what `npx expo install @sentry/react-native` picks for Expo 57 | not used: under Expo 57 it traces no `fetch`, sends no app start and stamps transactions hours in the past, in Sentry and in ouo alike. Install 8.x with `npm install` |
| `@sentry/core` | current, a dependency of the SDK | installed at the SDK's exact version (`npm ls @sentry/core` shows one copy) |
| `sentry-expo` | deprecated since Expo 50 | not used: `@sentry/react-native` has the Expo config plugin built in |
| `@sentry/react-native/expo` | the config plugin, inside the SDK | used in `app.json` as `"@sentry/react-native"` |

</details>

### 4b. Set it up

Create `app/src/sentry.ts`. It is an ordinary Sentry setup, with replay and logs on, plus two
lines for step 7 (`tracePropagationTargets` and `propagateTraceparent`): add those to your own
app if it does not have them yet.

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/src/sentry.ts -->
```ts
// @sentry/react-native, set up as a team that already uses Sentry would have it. The DSN comes
// from app/.env: your Sentry DSN, or the same key and project with the ouo bridge as host.
import * as Sentry from "@sentry/react-native";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (!dsn) throw new Error("EXPO_PUBLIC_SENTRY_DSN is not set: add it to app/.env and restart Metro");
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

export const navigationIntegration = Sentry.reactNavigationIntegration({ enableTimeToInitialDisplay: true });

Sentry.init({
  dsn,
  environment: "local",
  // Start sentry-cocoa from JS. Without it a Release build can skip the native start and send
  // nothing at all, to Sentry or to ouo (docs/sentry-client-setup.md, section 1).
  autoInitializeNativeSdk: true,

  // Every screen and request is traced; 1.0 keeps the API's spans too (step 7).
  tracesSampleRate: 1.0,
  // Step 7: the API is OpenTelemetry, which reads W3C `traceparent`, not `sentry-trace`. Send
  // both, and only to the API.
  tracePropagationTargets: [API_URL],
  propagateTraceparent: true,

  // Sentry.logger.* calls become Sentry Logs (and log lines in ouo).
  enableLogs: true,

  // Mobile Session Replay on every session; Sentry's default masking (all text and images).
  replaysSessionSampleRate: 1.0,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.mobileReplayIntegration(), navigationIntegration],
});

export { Sentry };
```

Replace `app/src/api.ts` with the version that gives every request a span. Without a span around
it, a request still carries a `traceparent` header, with a parent span id that no span has, and
the API's spans in ouo hang off a parent that never arrives
([client setup, section 4](../../../docs/sentry-client-setup.md#4-requests-outside-a-transaction)):

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/src/api.ts -->
```ts
// The API client. Sentry's fetch instrumentation turns each call into an `http.client` span and
// adds `sentry-trace`, `baggage` and `traceparent` to requests to the API.
import { startNewTrace } from "@sentry/core";
import { API_URL, Sentry } from "./sentry";

export type Product = { id: number; name: string; price: number };

// Resolved when the navigation container is ready (App.tsx); Sentry's first screen span starts then.
let ready: () => void;
export const navigationReady = new Promise<void>((resolve) => (ready = resolve));
export const markNavigationReady = () => ready();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

// A request needs a span around it. Without one, Sentry still sends `traceparent`, with a parent
// span id that no span has, and the API's spans hang off a parent that never arrives.
// The first screen's load waits for Sentry's screen span; a later one with no span gets its own.
async function api<T>(name: string, path: string, init?: RequestInit): Promise<T> {
  await navigationReady;
  if (Sentry.getActiveSpan()) return request<T>(path, init);
  return Sentry.startSpan({ name, op: "http.request", forceTransaction: true }, () => request<T>(path, init));
}

// A button press: its own trace and its own transaction, so each action is one trace in Sentry
// and in Tempo (otherwise every root span reuses the screen's trace id).
export const action = <T,>(name: string, fn: () => Promise<T>): Promise<T> =>
  startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, fn));

export const getProducts = () => api<Product[]>("load products", "/api/products");

export const checkout = (items: Product[]) =>
  api<{ ok: boolean; orderId: number }>("checkout", "/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: items.map((p) => p.id) }),
  });

export const callBrokenApi = () => api<unknown>("call broken API", "/api/fail");
```

Replace `app/App.tsx`: Sentry starts before the first screen, wraps the app and follows the
navigation.

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/App.tsx -->
```tsx
// The app: three screens in a native stack. Sentry starts first (src/sentry.ts) and wraps the app.
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { navigationIntegration, Sentry } from "./src/sentry";
import { markNavigationReady, type Product } from "./src/api";
import { CartProvider } from "./src/cart";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

export type Screens = { Products: undefined; Product: { product: Product }; Cart: undefined };

const Stack = createNativeStackNavigator<Screens>();
const navigationRef = createNavigationContainerRef<Screens>();

function App() {
  return (
    <CartProvider>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          // Each screen becomes a `navigation` transaction in Sentry, and a screen view in ouo.
          navigationIntegration.registerNavigationContainer(navigationRef);
          markNavigationReady();
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

export default Sentry.wrap(App);
```

Replace the three screens. **Products** gets two more Debug buttons, "Handled error" and "Native
crash", and its "Call broken API" becomes a traced action:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/src/screens/ProductsScreen.tsx -->
```tsx
// Products: the list from GET /api/products, and the Debug buttons that make each kind of error.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { action, callBrokenApi, getProducts, type Product } from "../api";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";
import type { Screens } from "../../App";

export function ProductsScreen({ navigation }: NativeStackScreenProps<Screens, "Products">) {
  const [products, setProducts] = useState<Product[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getProducts().then(setProducts, (e: Error) => setMessage(e.message));
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {products.map((p) => (
        <Pressable key={p.id} accessibilityRole="button" style={styles.row} onPress={() => navigation.navigate("Product", { product: p })}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.text}>${p.price}</Text>
        </Pressable>
      ))}
      <Button title="Cart" onPress={() => navigation.navigate("Cart")} />

      <View style={{ height: 24 }} />
      <Text style={styles.muted}>Debug</Text>
      <Button
        kind="debug"
        title="Call broken API"
        onPress={() =>
          action("call broken API", () => callBrokenApi()).catch((e: Error) => setMessage(e.message))
        }
      />
      <Button
        kind="debug"
        title="Handled error"
        onPress={() => {
          Sentry.captureException(new Error("Coupon service timed out"));
          setMessage("Handled error sent");
        }}
      />
      <Button
        kind="debug"
        title="Throw error"
        onPress={() => {
          // Outside React, so no error boundary catches it: a fatal JS error. A Release build exits.
          setTimeout(() => {
            throw new Error("Cart total is NaN");
          });
        }}
      />
      <Button kind="debug" title="Native crash" onPress={() => Sentry.nativeCrash()} />
      {message ? <Text style={styles.muted}>{message}</Text> : null}
    </ScrollView>
  );
}
```

**Product** writes a Sentry log line when you add to the cart:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/src/screens/ProductScreen.tsx -->
```tsx
// Product: one product and "Add to cart".
import { Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCart } from "../cart";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";
import type { Screens } from "../../App";

export function ProductScreen({ route, navigation }: NativeStackScreenProps<Screens, "Product">) {
  const { product } = route.params;
  const cart = useCart();
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button
        title="Add to cart"
        onPress={() => {
          cart.add(product);
          // A Sentry log: in Sentry Logs, and a log line on the session's timeline in ouo.
          Sentry.logger.info(`added ${product.name} to cart`, { "product.id": product.id, "cart.items": cart.items.length + 1 });
          navigation.goBack();
        }}
      />
    </View>
  );
}
```

**Cart** runs the checkout as one traced action and logs the order:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/src/screens/CartScreen.tsx -->
```tsx
// Cart: what was added, and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { action, checkout } from "../api";
import { useCart } from "../cart";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [message, setMessage] = useState("");
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  const onCheckout = () =>
    action("checkout", async () => {
      const order = await checkout(cart.items);
      Sentry.logger.info(`order ${order.orderId} placed: ${cart.items.length} items, $${total}`, { "order.id": order.orderId, "order.total": total });
      cart.clear();
      setMessage(`Order ${order.orderId} placed`);
    }).catch((e: Error) => setMessage(e.message));

  return (
    <View style={styles.screen}>
      {cart.items.map((p, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.text}>${p.price}</Text>
        </View>
      ))}
      <Text style={styles.text}>Total ${total}</Text>
      <Button title="Checkout" onPress={onCheckout} />
      {message ? <Text style={styles.muted}>{message}</Text> : null}
    </View>
  );
}
```

Sentry's Metro config adds a debug id to the bundle, the id Sentry matches uploaded source maps
by. Create `app/metro.config.js`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/metro.config.js -->
```js
// Sentry's Metro config: adds a debug id to the bundle, which Sentry matches to uploaded source maps.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");

module.exports = getSentryExpoConfig(__dirname);
```

Add Sentry's config plugin to `app/app.json`. `disableAutoUpload` keeps the build from calling
sentry.io to upload source maps and debug symbols (set up uploads with your Sentry auth token
later, as you would without ouo). Replace the file with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/app/app.json -->
```json
{
  "expo": {
    "name": "Tiny Shop",
    "slug": "tiny-shop-mobile",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "ios": {
      "supportsTablet": false,
      "bundleIdentifier": "dev.ouo.tinyshop.m4"
    },
    "android": {
      "adaptiveIcon": {
        "backgroundColor": "#E6F4FE",
        "foregroundImage": "./assets/android-icon-foreground.png",
        "backgroundImage": "./assets/android-icon-background.png",
        "monochromeImage": "./assets/android-icon-monochrome.png"
      },
      "predictiveBackGestureEnabled": false
    },
    "web": {
      "favicon": "./assets/favicon.png"
    },
    "plugins": [
      "./plugins/withUIScene.js",
      ["@sentry/react-native", { "disableAutoUpload": true }]
    ]
  }
}
```

### 4c. Your DSN

In Sentry, open your project's **Settings -> Client Keys (DSN)** and copy the DSN. Create
`app/.env` with it (yours, not this example):

```
EXPO_PUBLIC_SENTRY_DSN=https://3f2a...c9@o4507123.ingest.de.sentry.io/4508765
EXPO_PUBLIC_API_URL=http://localhost:5001
```

A DSN is not a secret: it ships inside every app. `.env` is still the place for it, because the
value changes between this step and step 6.

### 4d. Rebuild and look in Sentry

The SDK has native code, so build the app again (the pods change). From `app/`:

```bash
npx expo run:ios
```

In the app: open **Coffee**, **Add to cart**, open **Cart**, **Checkout**, go back, then
**Handled error**. In Sentry, within a minute: the issue "Coupon service timed out" under
**Issues**, a session under **Releases** (release `dev.ouo.tinyshop.m4@1.0.0+1`), the
`checkout` transaction under **Explore -> Traces**, and the two log lines under
**Explore -> Logs**. That is your app today. ouo is not involved yet.

## Step 5. The stack, one service at a time

### 5a. Create the files

Six services, one folder each. Each folder holds that service's compose file and its config, and
each file starts with what the service is for, who sends it data and its ports. Open a block, copy
all of it, and paste it into the file named in its title (VS Code creates the folders when you
save a new file as `stack/10-collector/compose.yaml`).

`compose.yaml` only lists the service folders:

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/compose.yaml -->
```yaml
# The ouo stack for tiny-shop-mobile-sentry: one folder per service, each with its compose file and
# its config. This file only lists them. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), Sentry bridge :4320, OTLP http://localhost:4318.
# Ports taken, or your Sentry upstream: set them in .env next to this file (see .env.example).
include:
  - 10-collector/compose.yaml   # ingest: the Sentry bridge (app) and OTLP (API); forwards to your Sentry
  - 20-tempo/compose.yaml       # traces
  - 30-loki/compose.yaml        # logs and the app's session events
  - 40-mimir/compose.yaml       # metrics: the bridge's own counters (forwarded envelopes, upstream latency)
  - 50-rum-api/compose.yaml     # sessions and replay for the Grafana plugin
  - 60-grafana/compose.yaml     # the UI: datasources and the ouo11y RUM app
```

</details>

**The collector** is where the app's Sentry SDK and the API send their data. Its `ouosentry`
receiver is the Sentry bridge: a project table maps your Sentry project and key to the upstream
Sentry and to the ouo project. Your Sentry's address and key come from `stack/.env` (step 5b).

<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/10-collector/compose.yaml -->
```yaml
# ouo-collector: the only ingest. The app's Sentry SDK sends its envelopes to the Sentry bridge
# (4320), which forwards each one unchanged to your Sentry and translates a copy into ouo; the
# Node API sends OTLP (4318). Out: traces to Tempo, logs to Loki, its own metrics to Mimir,
# replay video to rum-api. Ports: 4320 Sentry bridge, 4318 OTLP/HTTP (public), 13133 health
# (loopback).
services:
  otel-collector:
    # `latest` follows each release. Tested with 0.4.0: pin `collector:0.4.0` or
    # `collector@sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2` to stay on it.
    image: ghcr.io/ouo11y/collector:latest
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "${OUO_SENTRY_PORT:-4320}:4320"
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "127.0.0.1:${OUO_COLLECTOR_HEALTH_PORT:-13133}:13133"
    environment:
      OUO_INGEST_TOKEN: it_dev_0000000000000000   # what it sends to rum-api; must equal rum-api's
      # Your Sentry, from stack/.env (.env.example). `none`: the bridge answers the SDK itself
      # and forwards nothing (ouo only).
      OUO_SENTRY_UPSTREAM: ${OUO_SENTRY_UPSTREAM:-none}
      OUO_SENTRY_PROJECT_ID: ${OUO_SENTRY_PROJECT_ID:-1}
      OUO_SENTRY_PUBLIC_KEY: ${OUO_SENTRY_PUBLIC_KEY:-publickey0000000000000000000000}
    # Lets an upstream of http://host.docker.internal:9000 reach a Sentry running on this machine.
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./config.yaml:/etc/otelcol/config.yaml:ro
      - ./projects.htpasswd:/etc/otelcol/projects.htpasswd:ro
    depends_on: [tempo, loki, mimir]
```

</details>

<details>
<summary><code>stack/10-collector/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/10-collector/config.yaml -->
```yaml
# ouo-collector pipelines, a trimmed copy of the full stack's config (no rate limits).
# Receivers: the Sentry bridge on 4320 (DSN key auth: the project table below) and OTLP/HTTP on
# 4318 for the API (project credential in projects.htpasswd). Exporters: Tempo, Loki, Mimir and
# rum-api (replay video from the bridge).

extensions:
  health_check:
    endpoint: 0.0.0.0:13133
  basicauth/server:
    htpasswd:
      file: /etc/otelcol/projects.htpasswd

receivers:
  # The Sentry bridge. The app's DSN is http://<public key>@<this host>:4320/<project id>: the
  # same key and project as your Sentry DSN, only the host changes. Each envelope is forwarded
  # byte for byte to `upstream` and Sentry's answer (status, headers, body) goes back to the SDK
  # unchanged. Envelopes Sentry accepted (2xx) are translated into ouo sessions, errors, spans,
  # logs and replay video. Unknown key or project: 403, nothing forwarded.
  ouosentry:
    endpoint: 0.0.0.0:4320
    upstream_timeout: 30s
    projects:
      - sentry_project_id: "${env:OUO_SENTRY_PROJECT_ID}"
        public_keys: ["${env:OUO_SENTRY_PUBLIC_KEY}"]
        upstream: ${env:OUO_SENTRY_UPSTREAM}
        ouo_project_id: demo              # the ouo project the copy is stored under
        service_name: tiny-shop-mobile    # service.name of the app in ouo
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        include_metadata: true       # keeps the authenticated project for resource/project
        auth:
          authenticator: basicauth/server

connectors:
  # The bridge emits replay chunks on its logs output: send them to the replay pipeline
  # (rum-api) and everything else to Loki.
  routing/sentry:
    default_pipelines: [logs]
    table:
      - context: log
        condition: log.attributes["ouo.replay.chunk"] == true
        pipelines: [logs/replay]

processors:
  # Stamp the project id on every resource (and drop any value the client sent): the
  # authenticated one on OTLP, the project table's `ouo_project_id` on the bridge.
  resource/project:
    attributes:
      - key: ouo.project.id
        action: delete
      - key: ouo.project.id
        from_context: auth.username
        action: upsert
  # Copy the OTLP event name into the `event.name` attribute, which Loki turns into a label,
  # and the resource's `ouo.platform` onto each record.
  transform/events:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - set(log.attributes["event.name"], log.event_name) where log.event_name != "" and log.attributes["event.name"] == nil
          - set(log.attributes["ouo.platform"], resource.attributes["ouo.platform"]) where log.attributes["ouo.platform"] == nil and resource.attributes["ouo.platform"] != nil
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
  ouoreplay:
    endpoint: http://rum-api:8080
    ingest_token: ${env:OUO_INGEST_TOKEN}
    timeout: 30s                     # a replay video chunk is up to 8 MiB

service:
  extensions: [health_check, basicauth/server]
  # The collector's own metrics, among them the bridge's ouo_sentry_envelopes_total{outcome}
  # (forwarded, rejected, upstream_error) and ouo_sentry_upstream_duration_seconds, to Mimir.
  telemetry:
    metrics:
      level: normal
      readers:
        - periodic:
            interval: 15000
            exporter:
              otlp:
                protocol: http/protobuf
                endpoint: http://mimir:9009/otlp/v1/metrics
  pipelines:
    traces:
      receivers: [otlp, ouosentry]
      processors: [resource/project, batch]
      exporters: [otlp_grpc/tempo]
    # The bridge's output before routing; the project is in the client context.
    logs/sentry:
      receivers: [ouosentry]
      exporters: [routing/sentry]
    logs:
      receivers: [otlp, routing/sentry]
      processors: [resource/project, transform/events, batch]
      exporters: [otlp_http/loki]
    metrics:
      receivers: [otlp]
      processors: [resource/project, batch]
      exporters: [otlp_http/mimir]
    logs/replay:
      receivers: [routing/sentry]
      exporters: [ouoreplay]
```

</details>

<details>
<summary><code>stack/10-collector/projects.htpasswd</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/10-collector/projects.htpasswd -->
```
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

**Tempo** stores the traces: the app's spans from the bridge and the API's.

<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/20-tempo/compose.yaml -->
```yaml
# Tempo: stores traces. The collector sends it the app's spans (from the bridge) and the API's
# spans over OTLP/gRPC; Grafana and rum-api query it on 3200. Port 3200 is published on
# loopback for curl; nothing else needs it.
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/20-tempo/config.yaml -->
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

**Loki** stores the app's session events, errors and Sentry logs, as log records.

<details>
<summary><code>stack/30-loki/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/30-loki/compose.yaml -->
```yaml
# Loki: stores logs. The collector sends it the app's session events, errors and Sentry logs over OTLP
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/30-loki/config.yaml -->
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

**Mimir** stores metrics: here, the collector's own, among them how many envelopes the bridge
forwarded to Sentry.

<details>
<summary><code>stack/40-mimir/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/40-mimir/compose.yaml -->
```yaml
# Mimir: stores metrics. The collector pushes its own metrics (the Sentry bridge's counters) to
# /otlp; Grafana queries it with PromQL on 9009 (/prometheus). Port 9009 is published on
# loopback for curl.
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/40-mimir/config.yaml -->
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

**rum-api** builds the session list from Loki and Tempo and stores the replay video the bridge
cuts out of Sentry's replay segments.

<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/50-rum-api/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/50-rum-api/config.yaml -->
```yaml
# rum-api configuration: where Loki and Tempo are, and the session timeouts.
# The tokens come from the environment set in compose.yaml (-config.expand-env=true).
# Replays are stored on the rum-api-data volume.
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

storage:
  backend: filesystem
```

</details>

**Grafana** with the ouo11y RUM app is the UI.

<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/60-grafana/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/60-grafana/provisioning/datasources/datasources.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml -->
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

**Image versions.** The three ouo images use `latest`, which follows each release. Their compose
files say which version this guide was tested with and its digest: pin
`ghcr.io/ouo11y/collector:0.4.0`, or the `@sha256:...` digest, to keep a stack on one version.
The configs in this guide are written for the tested versions; a much newer image may refuse a
config key it no longer knows, and the error in `docker compose logs <service>` names it.

### 5b. Your Sentry as the upstream

Create `stack/.env` from the template below, with your DSN's parts (["How the DSN
changes"](#how-the-dsn-changes)). Compose reads `.env` next to `compose.yaml` on its own.

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/stack/.env.example -->
```bash
# Copy to .env (next to compose.yaml) and fill in. Compose reads .env on its own.

# Your Sentry project, from its DSN https://<public key>@<host>/<project id>
# (Sentry: Settings -> Projects -> <project> -> Client Keys (DSN)).
#   sentry.io:   OUO_SENTRY_UPSTREAM=https://o<org id>.ingest.<region>.sentry.io   (the DSN's host)
#   self-hosted on this machine: OUO_SENTRY_UPSTREAM=http://host.docker.internal:9000
#   self-hosted elsewhere:       OUO_SENTRY_UPSTREAM=https://sentry.example.com
#   no Sentry at all:            OUO_SENTRY_UPSTREAM=none
OUO_SENTRY_UPSTREAM=none
OUO_SENTRY_PROJECT_ID=1
OUO_SENTRY_PUBLIC_KEY=publickey0000000000000000000000

# Ports, only if the defaults are taken on your machine.
# OUO_GRAFANA_PORT=3000
# OUO_SENTRY_PORT=4320
# OUO_OTLP_HTTP_PORT=4318
# OUO_TEMPO_PORT=3200
# OUO_LOKI_PORT=3100
# OUO_MIMIR_PORT=9009
# OUO_COLLECTOR_HEALTH_PORT=13133
```

For the DSN `https://3f2a...c9@o4507123.ingest.de.sentry.io/4508765`, `stack/.env` reads:

```
OUO_SENTRY_UPSTREAM=https://o4507123.ingest.de.sentry.io
OUO_SENTRY_PROJECT_ID=4508765
OUO_SENTRY_PUBLIC_KEY=3f2a...c9
```

### 5c. Log in to ghcr.io

The ouo images are private for now. You need read access to the `ouo11y` packages and a
**classic** GitHub token with only the `read:packages` scope. Put the token in your shell
(`export GHCR_TOKEN=...`), never in a file, then:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <your-github-user> --password-stdin
```

### 5d. Check the ports

The stack publishes 3000 (Grafana), 4320 (the Sentry bridge) and 4318 (OTLP) to your network,
and 3100, 3200, 9009 and 13133 on loopback only. This prints nothing when they are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4320|9009|13133) '
```

If something is listed, do not stop it: move this stack instead. Uncomment the taken ports in
`stack/.env` and give them free numbers, for example `OUO_SENTRY_PORT=14320`. Remember the new
bridge and OTLP ports: steps 6 and 7 tell you where they go.

### 5e. Start it

In the third terminal tab, from `tiny-shop-mobile-sentry/`:

```bash
cd stack
```

```bash
docker compose up -d
```

```bash
docker compose ps
```

Six services are `Up`, and `rum-api` becomes `healthy`. The collector's log names the bridge and
its project:

```bash
docker compose logs otel-collector | grep "Sentry bridge"
```

`Starting Sentry bridge HTTP server ... "endpoint": "[::]:4320", "projects": 1`. Open
http://localhost:3000 and log in with **admin / testing567**. **More apps -> ouo11y RUM** is there
and still empty.

## Step 6. Send the app's Sentry traffic through the bridge

Change the DSN's host in `app/.env`, nothing else. Keep your key and project id:

```
EXPO_PUBLIC_SENTRY_DSN=http://3f2a...c9@localhost:4320/4508765
EXPO_PUBLIC_API_URL=http://localhost:5001
```

`http`, because the bridge on your machine has no TLS (iOS allows plain `http` to `localhost`).
Bridge on another port (step 5d)? Use it here.

Metro writes `EXPO_PUBLIC_*` into the bundle when it builds it, so restart it with an empty cache.
In the app tab, stop Metro (Ctrl+C), then from `app/`:

```bash
npx expo start --clear
```

Press `i` to open the app on the simulator. No rebuild: the native code did not change. Do the
same as in step 4d: **Coffee**, **Add to cart**, **Cart**, **Checkout**, back, **Handled error**.

Then look in both places:

- **Sentry**, as before: a second "Coupon service timed out" event on the same issue, a new
  session, the transaction, the logs. Sentry cannot tell that the bridge was in between.
- **ouo**: Grafana -> **More apps -> ouo11y RUM -> Sessions**. The newest `tiny-shop-mobile`
  session is `errored`, with the handled error, the screens, the two log lines and its traces.

The bridge counts what it forwarded. From `stack/`, a minute after the taps:

```bash
curl -s localhost:9009/prometheus/api/v1/query --data-urlencode 'query=sum by (outcome) (ouo_sentry_envelopes_total)'
```

`"outcome":"forwarded"` counts the envelopes Sentry answered, whatever it answered (a `429`
counts too). `rejected` means a DSN key or project id the bridge does not know (check
`stack/.env` against `app/.env`); `upstream_error` means the bridge could not reach your Sentry
(check `OUO_SENTRY_UPSTREAM`).

## Step 7. Trace into the API

Sentry already sends `traceparent` to the API (`propagateTraceparent: true` in step 4b), but the
API does not read it yet. The API is OpenTelemetry, not Sentry: its spans go to ouo only.

Stop the API with Ctrl+C in its terminal tab (still in `backend/`), then:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/resources @opentelemetry/semantic-conventions
```

| Package | What it does here |
|---|---|
| `@opentelemetry/api` | the tracing API the manual spans in `server.js` use |
| `@opentelemetry/sdk-node` | the Node SDK: starts tracing with a resource, processors and instrumentations |
| `@opentelemetry/sdk-trace` | `BatchSpanProcessor` (OpenTelemetry JS 3.0; `sdk-trace-base` is its old name) |
| `@opentelemetry/exporter-trace-otlp-http` | sends spans to the collector over OTLP/HTTP |
| `@opentelemetry/instrumentation-http` | a server span per request, and reads `traceparent` |
| `@opentelemetry/instrumentation-express` | names the server span after the Express route |
| `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` | the service name and version |

Create `backend/instrumentation.js`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/backend/instrumentation.js -->
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
    [ATTR_SERVICE_NAME]: "tiny-shop-mobile-backend",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "local",
  }),
  // The app's Sentry SDK sends W3C `traceparent` (propagateTraceparent: true): the default
  // ParentBased sampler and the W3C propagator make every API span a child of the app's span.
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

Replace `backend/server.js` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-sentry/result/backend/server.js -->
```js
// The API. HTTP server spans come from the auto-instrumentation; the spans below are manual.
// No CORS: a native app sends no preflight, and Express accepts the `traceparent`, `tracestate`,
// `baggage` and `sentry-trace` headers the app's Sentry SDK adds.
const express = require("express");
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-mobile-backend");
const app = express();
app.use(express.json());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const products = [
  { id: 1, name: "Coffee", price: 4 },
  { id: 2, name: "Tea", price: 3 },
  { id: 3, name: "Cake", price: 6 },
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

The SDK has to load **before** Express so the instrumentation can patch it. Save that as the
start script, then start the API:

```bash
npm pkg set scripts.start="node --require ./instrumentation.js server.js"
```

```bash
npm start
```

It prints `[otel] tracing to http://localhost:4318/v1/traces`. Collector on another OTLP port
(step 5d)? Stop it and start it with `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start`.

In the app (press `r` in Metro to reload), add something to the cart and **Checkout**. In
Grafana -> **Explore -> Tempo -> TraceQL**:

```
{ resource.service.name = "tiny-shop-mobile-backend" && name = "charge card" }
```

Open the newest trace: the app's `checkout` transaction from the bridge is the root, then its
`POST` `http.client` span, then the API's `POST /api/checkout`, `checkout`, `validate cart` and
`charge card`, one trace id. The same trace in Sentry stops at the `http.client` span: Sentry
never sees the API.

## Step 8. The same session in Sentry and in ouo

A crash needs a Release build: in a Debug build React Native catches a JavaScript fatal error in
its red screen and the app keeps running. The Release build is also what your users run. It has
the JavaScript bundle inside the app and reads `app/.env` at build time, so it needs no Metro.
Stop Metro (Ctrl+C), then from `app/`:

```bash
npx expo run:ios --configuration Release
```

Then, in the app, one session:

1. **Coffee**, **Add to cart**; **Tea**, **Add to cart**; **Cart**, **Checkout**; back.
2. **Call broken API**, then **Handled error**.
3. **Throw error**. The app closes: a fatal JavaScript error. Open **Tiny Shop** again from the
   home screen (a new session starts).
4. **Native crash**. The app closes again. Open it once more: sentry-cocoa sends the crash
   report on this launch.

Wait a minute, then open both side by side.

| What | In Sentry | In ouo (Grafana) |
|---|---|---|
| The sessions | **Releases** -> `dev.ouo.tinyshop.m4@1.0.0+1`: 3 sessions, 2 crashed, crash-free rate | **More apps -> ouo11y RUM -> Sessions**: the same 3, newest first: one healthy (still open), two `crashed` (the first with 1 error, 1 failed request and its traces) |
| The JS crash | **Issues**: "Error: Cart total is NaN", fatal, unhandled; the stack is the minified bundle until you upload source maps | the first session ends in **Fatal error** "Cart total is NaN" on its activity list, with the stack as the SDK sent it |
| The native crash | **Issues**: `EXC_BAD_ACCESS`, "Attempted to dereference null pointer", symbolicated once you upload dSYMs | the second session's fatal `EXC_BAD_ACCESS`, its frames as image name and address |
| The handled error | **Issues**: "Error: Coupon service timed out", handled | an **Error** entry on the first session's activity |
| The broken API call | the `call broken API` transaction, its `http.client` span with status 500 | a failed request on the timeline, and its trace into the API's span with the recorded exception |
| Checkout | **Explore -> Traces**: the `checkout` trace, two app spans | the same trace id in Tempo, with the API's six spans under the app's two |
| Logs | **Explore -> Logs**: "added Coffee to cart", "added Tea to cart", "order … placed", and `Running "main"` per launch | the same lines on the sessions' activity lists, and in Loki: `{service_name="tiny-shop-mobile", event_name="log"}` (`"console"` for the startup lines) |
| Replay | **Replays**: one per session, with Activity, Console, Logs, Network, Errors, Trace and Tags tabs | the session's **Replay** panel: the same segments (the manifest names Sentry's replay id), taps, navigations and errors as markers on its timeline |

Replay ids, trace ids and event ids are the same on both sides: paste a trace id from Tempo into
Sentry's **Explore -> Traces** search (`trace:<id>`) to open the same trace there. Neither UI
links to the other yet.

## Step 9. What each side shows that the other does not

Through the bridge, ouo sees what Sentry accepted, translated into OpenTelemetry. Neither side is
a superset of the other.

**Only in ouo:**

| What | Why |
|---|---|
| The trace across the app and an OpenTelemetry backend | Sentry shows spans from Sentry SDKs only; the API's OTLP spans go to Tempo. Instrument the backend with Sentry too and Sentry has them, but then they are not OpenTelemetry |
| The data in your own stores, queried with TraceQL, LogQL and PromQL | Tempo, Loki and Mimir are yours: join app sessions with backend logs and metrics in one Grafana, and keep them as long as you choose |
| Mobile and web sessions in one list | a web app on `@ouo11y/browser` lands in the same ouo11y RUM, with the same session model |
| The bridge's own metrics | `ouo_sentry_envelopes_total`, `ouo_sentry_upstream_duration_seconds`: how much went to Sentry and how fast it answered, from your side |

**Only in Sentry:**

| What | Why |
|---|---|
| Issues: grouping, assignment, resolve and regress, alerts on new issues | ouo lists each error event in its session; it does not group them into issues |
| Symbolicated stacks | Sentry applies the source maps and dSYMs you upload; ouo keeps the frames as the SDK sent them (bundle positions, native image and address) |
| Tags, `extra`, user email and IP address, screenshots and view hierarchies attached to errors | not copied by design (privacy allowlist, [spec section 12](../../../docs/specs/sentry-bridge.md#12-attribute-allowlist)); `copy_tags: true` in the bridge's project table copies tags |
| Profiling, user feedback, release health over weeks and releases | outside what the bridge translates |
| Anything Sentry drops | over quota, filtered or rate limited: the bridge translates only what Sentry accepted (step 10) |

**On both:** the sessions with their state, the errors and crashes, every request of the session,
taps and screens, the logs, the replay video, app start and time to initial display. ouo builds
its session timeline from the same envelopes Sentry stores.

**The same on both sides, read differently:** session counts and crash-free rate (same, from
Sentry's sessions); session boundaries are Sentry's (a session ends when the app goes to the
background); `captureMessage` is an info message, not an error, on both sides. The full table of
expected differences is in [the bridge spec, section 13](../../../docs/specs/sentry-bridge.md#13-expected-differences-between-sentry-and-ouo).

## Step 10. Running the bridge for real

- **One replica.** The bridge keeps each device's session state in memory, so it runs as exactly
  one process ([sentry-bridge-deployment.md](../../../docs/sentry-bridge-deployment.md), roadmap
  N4). Sentry still gets every envelope unchanged with more replicas; the ouo copy loses its
  links between envelopes (logs and spans without a session, replay gaps).
- **Sentry's answer passes through unchanged:** status, body and every header, including
  `X-Sentry-Rate-Limits` and `Retry-After`. The SDK throttles itself exactly as it would without
  ouo.
- **Sentry down or unreachable:** the bridge drops the connection instead of answering, so the SDK
  sees what it sees when Sentry is down, keeps the envelope on the device and sends it again
  later (sentry-cocoa did at its next send). ouo gets the copy when Sentry finally accepts it,
  once. Nothing reaches ouo while Sentry is down: ouo's availability depends on your Sentry's.
- **Sentry over quota or rate limiting (`429`), or rejecting an envelope (any non-`2xx`):** the
  answer goes back to the SDK, which then holds back for the `Retry-After` time, and **nothing
  reaches ouo** for that envelope. ouo's copy is never larger than what Sentry kept. An error
  lost this way still counts in the session's error count, which Sentry's next session update
  carries: ouo shows it as a `sentry.unsampled_error` with no message. No bridge metric shows
  how much Sentry refused (a `429` counts as `forwarded`); look at the project's stats in Sentry.
  To decouple the two, point the DSN at a bridge with `upstream: none` (ouo only) or move to the
  ouo SDK.
- **Latency:** one extra hop. Measured on one machine with self-hosted Sentry: p50 8 ms instead
  of 3 ms, p95 56 instead of 35 ms per envelope; the SDK sends in the background.
- **Production:** the bridge listens on plain HTTP. Put it behind TLS on its own host and use
  `https://<key>@sentry-bridge.example.com/<project>` as the DSN (the deployment guide has a
  Kubernetes manifest). Ship the DSN change in an app release; older releases keep reporting to
  Sentry directly, and ouo sees only the new ones.
- **Going back** is the same one-line change: put the original DSN back in the next release.

## Step 11. Clean up

Stop the API and Metro with Ctrl+C. Stop the stack, keeping its data (in the stack's tab, from
`stack/`):

```bash
docker compose down
```

or delete its data too:

```bash
docker compose down -v
```

The events in your Sentry project stay there; delete the test project in Sentry if you made one.

## When something does not work

| You see | Cause and fix |
|---|---|
| `Unicode Normalization not appropriate for ASCII-8BIT` during `expo run:ios` | no UTF-8 locale for CocoaPods: step 0, `export LANG=en_US.UTF-8` |
| The app stops at launch on iOS 27, `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` | the UIScene plugin is missing from `app.json` (step 3b); run `npx expo prebuild --clean`, then `npx expo run:ios` |
| `EXPO_PUBLIC_SENTRY_DSN is not set` on the red screen | `app/.env` is missing or Metro was not restarted with `--clear` after you changed it |
| Nothing in Sentry and nothing in ouo, no error | a Release build with a `sentry.options.json` and no native start: keep `autoInitializeNativeSdk: true` (step 4b) |
| `rejected` in `ouo_sentry_envelopes_total`, nothing in Sentry | the DSN's key or project id differs from `OUO_SENTRY_PUBLIC_KEY` / `OUO_SENTRY_PROJECT_ID` in `stack/.env`; the bridge answers `403` and forwards nothing. After changing `.env`: `docker compose up -d` |
| `upstream_error`, the app retries | the bridge cannot reach `OUO_SENTRY_UPSTREAM`: a typo, no `https://`, or `localhost` for a Sentry on your machine (use `host.docker.internal`) |
| Events in Sentry, but no session in ouo | Sentry answered non-`2xx` (quota, rate limit, filtered): nothing is translated. Check the project's stats in Sentry |
| `Bind for 0.0.0.0:4320 failed: port is already allocated` | another stack has the port: step 5d, move this one with `stack/.env` |
| A collector or rum-api that keeps restarting after a pull | a newer `latest` that wants a different config: `docker compose logs <service>` names the key; pin the tested version (step 5a, "Image versions") |
| `denied` when pulling `ghcr.io/ouo11y/...` | not logged in to ghcr.io, or no read access yet: step 5c |
| The API's trace starts at `POST /api/checkout`, without the app's spans | `tracePropagationTargets` does not match `EXPO_PUBLIC_API_URL`, or `propagateTraceparent` is missing (step 4b) |
| The API's spans hang off a missing parent | a request without a span around it: `src/api.ts` (step 4b) wraps each one |
| No crash in ouo or Sentry after "Throw error" | a Debug build: the red screen catches it. Use the Release build (step 8) |
| No replay | the session ended before its first segment was sent (Sentry sends one every 5 seconds or so): stay in the app a little longer before you leave it |
| Nothing in Tempo yet | wait up to a minute: new traces reach search later than trace-by-id |
