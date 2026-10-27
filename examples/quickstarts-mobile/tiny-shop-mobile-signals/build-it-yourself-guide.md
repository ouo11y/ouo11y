# Build Tiny Shop Mobile: vitals, logs and a native crash through the Sentry bridge

This guide is for teams that ship a React Native app with `@sentry/react-native` and want to know
what ouo shows about the app itself: how fast it starts, how fast each screen appears, whether it
drops frames, what it logs, and what happens when it crashes in native code. The app keeps the
Sentry SDK and only changes its DSN: it sends to the **ouo Sentry bridge** in the ouo collector,
with `upstream: none`, so you need no Sentry account and nothing leaves your machine.

You build, one step at a time, with no scripts:

1. a plain Express API and a plain Expo app (Products, Product, Cart), with no telemetry at all;
2. the ouo stack (the ouo collector with its Sentry bridge, Tempo, Loki, Mimir, rum-api, Grafana),
   one folder per service, with a small dashboard for the API;
3. the API traced and measured with the OpenTelemetry Node SDK;
4. the app with `@sentry/react-native` pointed at the bridge, then each signal in turn: app start,
   time to initial display, slow and frozen frames, JavaScript stalls, structured logs, the release,
   and a native crash in a Release build.

At the end your files are the same as [`result/`](result): compare with them when you are stuck.
Plan on about an hour, plus about 10 minutes for the first iOS build.

```
tiny-shop-mobile-signals/
├── stack/      the ouo stack, one folder per service
├── backend/    Express API, OpenTelemetry traces and metrics
└── app/        Expo app (React Native), @sentry/react-native, DSN = the ouo bridge
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`tiny-shop-mobile-signals/`, wherever you create it, and each command says which of its folders it
runs in. When a step says "replace the file", select everything in it and paste the new content
over it. Everything runs on the iOS Simulator; no phone is needed.

## What the bridge makes of the Sentry SDK's data

The Sentry SDK measures and sends; the bridge translates each piece into the OpenTelemetry records
ouo reads ([mobile vitals spec](../../../docs/specs/mobile-vitals.md),
[bridge spec](../../../docs/specs/sentry-bridge.md)). This is what you build and look at:

| The Sentry SDK sends | The bridge writes | You see it in | Step |
|---|---|---|---|
| a `session` per foreground use (`ok`, `errored`, `crashed`, `abnormal`) | `session.start`, `session.end` with the end reason | ouo11y RUM, session list: healthy, errored or crashed | [6](#step-6-point-the-sentry-sdk-at-the-bridge) |
| `app_start_cold` / `app_start_warm` on the first transaction | `ouo.app.start` (`cold` or `warm`, duration) | the session header and its timeline | [7a](#7a-app-start-cold-and-warm) |
| `time_to_initial_display`, `time_to_full_display` per screen (React Navigation) | `ouo.screen.display` (TTID, TTFD) | the header (TTID p50 / max) and the timeline | [7b](#7b-time-to-initial-display-and-full-display) |
| `frames_total`, `frames_slow`, `frames_frozen` per transaction | `app.jank` (the semantic-convention event) | the header (slow and frozen frames) and the timeline | [7c](#7c-slow-and-frozen-frames-js-stalls) |
| `stall_count`, `stall_longest_time`, ... (JavaScript event loop) | `ouo.stall` | the header and the timeline | [7c](#7c-slow-and-frozen-frames-js-stalls) |
| `log` items (`Sentry.logger.*`, `enableLogs`) | one log record each, the message as its body | Loki, one readable line per log | [7d](#7d-structured-logs) |
| `release`, `dist`, `environment` on everything | `service.version`, `ouo.app.build`, `ouo.sentry.release`, `deployment.environment.name` | every record and span | [7e](#7e-release-environment-and-dist) |
| transactions and their spans, with `traceparent` to your API | spans in Tempo, in the same trace as the API's | Tempo, from the tap to the API's `charge card` | [6](#step-6-point-the-sentry-sdk-at-the-bridge) |
| a native crash report, on the next launch | a fatal `exception` with the native frames, `session.end` reason `crash` | the session, `crashed` | [8](#step-8-a-native-crash-release-build) |

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

Docker Desktop must be running. This prints the server details, not "Cannot connect":

```bash
docker info
```

Xcode with an iOS Simulator runtime (this guide was tested with Xcode 27.0 and iOS 27.0). This
lists the iPhone simulators you can use:

```bash
xcrun simctl list devices available
```

VS Code's `code` command. If it is not found, open VS Code, press Cmd+Shift+P and run
**Shell Command: Install 'code' command in PATH**.

```bash
code --version
```

## Step 1. Create the folders and open VS Code

From the folder where you keep your projects:

```bash
mkdir -p tiny-shop-mobile-signals/backend tiny-shop-mobile-signals/stack
```

```bash
cd tiny-shop-mobile-signals
```

```bash
code .
```

In VS Code, open a terminal with Ctrl+\`. You will use three terminal tabs (the `+` button): one
for the backend, one for the app, one for the stack. Each new tab opens in
`tiny-shop-mobile-signals/`.

## Step 2. A simple API, no telemetry yet

In the backend tab:

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
// The Tiny Shop API: three products, a checkout, and an endpoint that always fails.
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
  await sleep(50 + Math.random() * 100);
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
app.listen(port, () => console.log(`tiny-shop-mobile-signals API on http://localhost:${port}`));
```

```bash
node server.js
```

It prints `tiny-shop-mobile-signals API on http://localhost:5001`. A native app sends no CORS
preflight, so unlike the web quickstarts this API needs no `cors()`. Leave it running.

## Step 3. A plain Expo app

### 3a. Create it

In the app tab, from `tiny-shop-mobile-signals/`, create the app from Expo's blank TypeScript
template, on Expo SDK 57 (React Native 0.86):

```bash
npx create-expo-app@latest app --template blank-typescript@sdk-57
```

```bash
cd app
```

The template also writes an `AGENTS.md`, a `.claude/` folder and a `LICENSE` for AI coding tools;
keep or delete them, nothing below uses them. Add React Navigation (`npx expo install` picks the
versions that match Expo 57):

```bash
npx expo install @react-navigation/native @react-navigation/native-stack react-native-screens react-native-safe-area-context
```

| Package | What it does here |
|---|---|
| `expo`, `react-native`, `react` | the app runtime, from the template |
| `@react-navigation/native` | navigation state and the container the Sentry integration listens to |
| `@react-navigation/native-stack` | the Products → Product → Cart stack, with native iOS screens |
| `react-native-screens`, `react-native-safe-area-context` | native pieces the native stack needs |

### 3b. The app's files

Create `app/src/config.ts`:

```ts
// The Tiny Shop API (backend/). On the Simulator, localhost is your Mac.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";
```

Create `app/src/api.ts`:

```ts
// The Tiny Shop API, with plain fetch.
import { API_URL } from "./config";

export interface Product {
  id: number;
  name: string;
  price: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`${path} answered ${status}`);
    this.name = "HttpError";
  }
}

export async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: init.json === undefined ? {} : { "content-type": "application/json" },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  if (!res.ok) throw new HttpError(res.status, path);
  return (await res.json()) as T;
}

export const formatPrice = (n: number) => `$${n.toFixed(2)}`;
```

Create `app/src/navigation.ts`, the screens and their parameters, and a promise that resolves
once navigation is ready (step 6 uses it):

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/src/navigation.ts -->
```ts
import { createNavigationContainerRef } from "@react-navigation/native";
import type { Product } from "./api";

export type RootStackParamList = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

let markReady: () => void = () => {};
/** Resolves once the navigation container is ready (App.tsx onReady). */
export const navigationReady = new Promise<void>((resolve) => (markReady = resolve));
export const setNavigationReady = () => markReady();
```

Create `app/src/cart.tsx`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/src/cart.tsx -->
```tsx
// The cart lives in memory, in a React context shared by the three screens.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Product } from "./api";

interface CartValue {
  items: Product[];
  add: (p: Product) => void;
  clear: () => void;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Product[]>([]);
  const value = useMemo(
    () => ({ items, add: (p: Product) => setItems((xs) => [...xs, p]), clear: () => setItems([]) }),
    [items],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart outside CartProvider");
  return cart;
}
```

Create `app/src/screens/ProductsScreen.tsx`:

```tsx
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useState } from "react";
import { Alert, Button, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { api, formatPrice, type Product } from "../api";
import { useCart } from "../cart";
import type { RootStackParamList } from "../navigation";

type Nav = NativeStackNavigationProp<RootStackParamList, "Products">;

export function ProductsScreen() {
  const navigation = useNavigation<Nav>();
  const cart = useCart();
  const [products, setProducts] = useState<Product[] | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <Button title={`Cart (${cart.items.length})`} onPress={() => navigation.navigate("Cart")} />,
    });
  }, [navigation, cart.items.length]);

  useEffect(() => {
    api<Product[]>("/api/products").then(setProducts, (err: Error) => Alert.alert("Could not load products", err.message));
  }, []);

  const callBrokenApi = () => api("/api/fail").catch((err: Error) => Alert.alert("The API failed", err.message));

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {products === null ? <Text>Loading…</Text> : null}
      {products?.map((p) => (
        <Pressable key={p.id} style={styles.row} onPress={() => navigation.navigate("Product", { product: p })}>
          <Text style={styles.name}>{p.name}</Text>
          <Text>{formatPrice(p.price)}</Text>
        </Pressable>
      ))}

      <Text style={styles.section}>Debug</Text>
      <Button title="Call broken API" onPress={callBrokenApi} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", padding: 16, backgroundColor: "#f2f2f2", borderRadius: 8 },
  name: { fontWeight: "600" },
  section: { marginTop: 24, fontWeight: "700", color: "#888" },
});
```

Create `app/src/screens/ProductScreen.tsx`:

```tsx
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useLayoutEffect } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { formatPrice } from "../api";
import { useCart } from "../cart";
import type { RootStackParamList } from "../navigation";

export function ProductScreen() {
  const navigation = useNavigation();
  const { product } = useRoute<RouteProp<RootStackParamList, "Product">>().params;
  const cart = useCart();

  useLayoutEffect(() => navigation.setOptions({ title: product.name }), [navigation, product.name]);

  const addToCart = () => {
    cart.add(product);
    navigation.goBack();
  };

  return (
    <View style={styles.page}>
      <Text style={styles.name}>{product.name}</Text>
      <Text style={styles.price}>{formatPrice(product.price)}</Text>
      <Button title="Add to cart" onPress={addToCart} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  name: { fontSize: 28, fontWeight: "700" },
  price: { fontSize: 20 },
});
```

Create `app/src/screens/CartScreen.tsx`:

```tsx
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Button, StyleSheet, Text, View } from "react-native";
import { api, formatPrice } from "../api";
import { useCart } from "../cart";

export function CartScreen() {
  const navigation = useNavigation();
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  const checkout = () => {
    setBusy(true);
    const items = cart.items.map((p) => p.id);
    api<{ orderId: number }>("/api/checkout", { method: "POST", json: { items } })
      .then(() => {
        cart.clear();
        navigation.goBack();
      })
      .catch((err: Error) => Alert.alert("Checkout failed", err.message))
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.page}>
      {cart.items.length === 0 ? <Text>Your cart is empty.</Text> : null}
      {cart.items.map((p, i) => (
        <Text key={i}>
          {p.name} {formatPrice(p.price)}
        </Text>
      ))}
      <Text style={styles.total}>Total {formatPrice(total)}</Text>
      <Button title={busy ? "Placing order…" : "Checkout"} onPress={checkout} disabled={busy || cart.items.length === 0} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 8 },
  total: { fontSize: 20, fontWeight: "700", marginVertical: 12 },
});
```

Replace `app/App.tsx` with:

```tsx
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import { navigationRef, setNavigationReady, type RootStackParamList } from "./src/navigation";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <CartProvider>
      <NavigationContainer ref={navigationRef} onReady={setNavigationReady}>
        <Stack.Navigator>
          <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
          <Stack.Screen name="Product" component={ProductScreen} />
          <Stack.Screen name="Cart" component={CartScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </CartProvider>
  );
}
```

### 3c. iOS 27 and the app's identity

iOS 27 stops an app at launch unless it adopts the UIScene life cycle, and Expo 57's template does
not add it yet. A small config plugin does. Create `app/plugins/withUIScene.js`:

<details>
<summary><code>app/plugins/withUIScene.js</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/plugins/withUIScene.js -->
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

Replace `app/app.json` with the version below. It names the app and its bundle id, lets it call
`http://localhost` (Apple blocks plain http by default; `NSAllowsLocalNetworking` allows local
addresses only), and lists two config plugins: the UIScene one, and Sentry's, which you install in
step 6.

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/app.json -->
```json
{
  "expo": {
    "name": "Tiny Shop",
    "slug": "tiny-shop-mobile-signals",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "ios": {
      "supportsTablet": false,
      "bundleIdentifier": "dev.ouo.tinyshop.m3",
      "buildNumber": "1",
      "infoPlist": {
        "NSAppTransportSecurity": { "NSAllowsLocalNetworking": true }
      }
    },
    "plugins": [
      "./plugins/withUIScene.js",
      ["@sentry/react-native", { "disableAutoUpload": true }]
    ]
  }
}
```

Until step 6, take the Sentry line out of `plugins` (the package is not installed yet): keep only
`"./plugins/withUIScene.js"` in the list.

### 3d. Run it

From `app/`:

```bash
npx expo run:ios
```

The first run generates `app/ios/`, installs the CocoaPods and builds the app: about 10 minutes.
Expo then starts Metro (the JavaScript server, port 8081), boots a Simulator and opens the app.
Pick an iPhone if it asks. You see **Tiny Shop** with Coffee, Tea and Cake. Tap one, **Add to
cart**, then **Cart (1)** and **Checkout**. **Call broken API** shows an alert.

Leave Metro running in this tab: `r` reloads the app, Ctrl+C stops it.

## Step 4. The stack, one service at a time

### 4a. Create the files

In the stack tab, from `tiny-shop-mobile-signals/`:

```bash
cd stack
```

```bash
mkdir -p 10-collector 20-tempo 30-loki 40-mimir 50-rum-api 60-grafana/provisioning/datasources 60-grafana/provisioning/plugins 60-grafana/provisioning/dashboards 60-grafana/dashboards
```

**`stack/compose.yaml` only lists the services**, each in its own folder:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/compose.yaml -->
```yaml
# The ouo stack for tiny-shop-mobile-signals: one folder per service, each with its compose file
# and its config. This file only lists them. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), Sentry bridge http://localhost:4320 (the
# app's DSN), OTLP http://localhost:4318 (the API). Ports taken? Set OUO_GRAFANA_PORT,
# OUO_SENTRY_PORT, OUO_OTLP_HTTP_PORT in stack/.env before `up`.
include:
  - 10-collector/compose.yaml   # ingest: the Sentry bridge for the app, OTLP for the API
  - 20-tempo/compose.yaml       # traces
  - 30-loki/compose.yaml        # logs, session events and mobile vitals
  - 40-mimir/compose.yaml       # metrics: the API's request and order counters
  - 50-rum-api/compose.yaml     # sessions and vitals for the Grafana plugin
  - 60-grafana/compose.yaml     # the UI: datasources, the ouo11y RUM app, the API dashboard
```

**The ouo collector is the only thing your app and API talk to.** Its Sentry bridge receives
the app's envelopes on 4320 (the DSN points there) and translates them; the API sends OTLP to
4318.

<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/10-collector/compose.yaml -->
```yaml
# ouo-collector: the only ingest. The app's Sentry SDK sends its envelopes to the Sentry bridge
# on 4320 (its DSN); the Node API sends OTLP to 4318. The collector checks the credentials,
# translates the Sentry envelopes into OpenTelemetry and forwards traces to Tempo, logs to Loki
# and metrics to Mimir. Ports: 4318 OTLP/HTTP, 4320 Sentry bridge (both public), 13133 health
# (loopback).
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
    volumes:
      - ./config.yaml:/etc/otelcol/config.yaml:ro
      - ./projects.htpasswd:/etc/otelcol/projects.htpasswd:ro
    depends_on: [tempo, loki, mimir]
```

</details>

<details>
<summary><code>stack/10-collector/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/10-collector/config.yaml -->
```yaml
# ouo-collector pipelines, a trimmed copy of the full stack's config (no replay, no rate limits).
# Receivers: the Sentry bridge on 4320 (Sentry DSN key auth, nothing forwarded to Sentry) and
# OTLP/HTTP on 4318 behind the project credential in projects.htpasswd.
# Exporters: Tempo, Loki and Mimir.

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
  # The Sentry bridge: the app's DSN is http://publickey0000000000000000000000@localhost:4320/1.
  # It accepts envelopes for Sentry project 1 with that public key, stamps them with the ouo
  # project `demo`, and translates sessions, errors, transactions, logs and the mobile vitals
  # in transaction measurements into OpenTelemetry. `upstream: none`: no Sentry account,
  # nothing leaves your machine.
  ouosentry:
    endpoint: 0.0.0.0:4320
    projects:
      - sentry_project_id: "1"
        public_keys: ["publickey0000000000000000000000"]
        upstream: none
        ouo_project_id: demo
        service_name: tiny-shop-mobile-signals   # service.name of everything the app sends

processors:
  # Stamp the authenticated project id on every resource (and drop any value the client sent).
  # The bridge puts its project in the same place as basicauth, so this covers both.
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

service:
  extensions: [health_check, basicauth/server]
  pipelines:
    traces:
      receivers: [otlp, ouosentry]
      processors: [resource/project, batch]
      exporters: [otlp_grpc/tempo]
    logs:
      receivers: [otlp, ouosentry]
      processors: [resource/project, transform/events, batch]
      exporters: [otlp_http/loki]
    metrics:
      receivers: [otlp]
      processors: [resource/project, batch]
      exporters: [otlp_http/mimir]
```

</details>

<details>
<summary><code>stack/10-collector/projects.htpasswd</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/10-collector/projects.htpasswd -->
```
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

The `ouosentry` receiver is the bridge. Its project table maps a Sentry project id and public key
(the two parts of a DSN) to an ouo project and a service name. `upstream: none` means it answers
the SDK itself and forwards nothing; with a Sentry URL there instead, it would forward every
envelope to that Sentry unchanged and still translate a copy for ouo. The public key here is a
development value, as are `demo` / `pt_dev_demo_0000000000000000` (the API's credential) and
`admin` / `testing567` (Grafana): they are public, use them locally only.

**Tempo stores traces**: the app's transactions and the API's spans.

<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/20-tempo/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/20-tempo/config.yaml -->
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

**Loki stores logs**: the session events, the mobile vitals and the app's log lines.

<details>
<summary><code>stack/30-loki/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/30-loki/compose.yaml -->
```yaml
# Loki: stores logs. The collector sends it the app's session events, vitals and logs over OTLP
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/30-loki/config.yaml -->
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

**Mimir stores metrics**: the API's request and order counters (step 5).

<details>
<summary><code>stack/40-mimir/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/40-mimir/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/40-mimir/config.yaml -->
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

**rum-api builds the sessions** (healthy, errored, crashed) and their vitals from Loki and Tempo,
for the Grafana plugin.

<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/50-rum-api/compose.yaml -->
```yaml
# rum-api: the ouo platform service behind the Grafana plugin. It builds the session list
# (healthy / errored / crashed) and their mobile vitals from Loki and Tempo. Internal: only the
# collector and Grafana talk to it, on 8080 inside the network.
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/50-rum-api/config.yaml -->
```yaml
# rum-api configuration: where Loki and Tempo are, and the session timeouts.
# The tokens come from the environment set in compose.yaml (-config.expand-env=true).
# Its data is stored on the rum-api-data volume.
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

**Grafana is the UI**, with the ouo11y RUM app, the three datasources and a dashboard for the API.

<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/60-grafana/compose.yaml -->
```yaml
# Grafana with the ouo11y RUM app plugin: the UI for everything above. It reads Tempo, Loki and
# Mimir directly and sessions from rum-api through the plugin. Port 3000, admin / testing567.
# provisioning/ sets up the datasources, the plugin and the "Tiny Shop Mobile API" dashboard.
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
      - ./dashboards:/var/lib/grafana/dashboards:ro
    depends_on: [loki, tempo, mimir, rum-api]
```

</details>

<details>
<summary><code>stack/60-grafana/provisioning/datasources/datasources.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/60-grafana/provisioning/datasources/datasources.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml -->
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

<details>
<summary><code>stack/60-grafana/provisioning/dashboards/dashboards.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/60-grafana/provisioning/dashboards/dashboards.yaml -->
```yaml
# Loads every dashboard JSON file in /var/lib/grafana/dashboards (the dashboards/ folder next
# to compose.yaml) into the "Tiny Shop Mobile" folder. Edit the JSON file and restart Grafana to change one.
apiVersion: 1

providers:
  - name: tiny-shop-mobile
    folder: Tiny Shop Mobile
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

</details>

<details>
<summary><code>stack/60-grafana/dashboards/tiny-shop-mobile-api.json</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/stack/60-grafana/dashboards/tiny-shop-mobile-api.json -->
```json
{
  "uid": "tiny-shop-mobile-api",
  "title": "Tiny Shop Mobile API",
  "description": "The API's OpenTelemetry metrics in Mimir: request rate, errors, latency and orders.",
  "tags": [
    "tiny-shop",
    "ouo"
  ],
  "schemaVersion": 41,
  "time": {
    "from": "now-30m",
    "to": "now"
  },
  "refresh": "10s",
  "panels": [
    {
      "type": "timeseries",
      "title": "Requests per second, by route and status",
      "gridPos": {
        "x": 0,
        "y": 0,
        "w": 12,
        "h": 8
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {
          "unit": "reqps"
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum by (http_route, http_response_status_code) (rate(shop_http_requests[1m]))",
          "legendFormat": "{{http_route}} {{http_response_status_code}}"
        }
      ]
    },
    {
      "type": "timeseries",
      "title": "Request duration p50 / p95 (ms)",
      "gridPos": {
        "x": 12,
        "y": 0,
        "w": 12,
        "h": 8
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {
          "unit": "ms"
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "histogram_quantile(0.5, sum by (le) (rate(shop_http_request_duration_bucket[1m])))",
          "legendFormat": "p50"
        },
        {
          "refId": "B",
          "expr": "histogram_quantile(0.95, sum by (le) (rate(shop_http_request_duration_bucket[1m])))",
          "legendFormat": "p95"
        }
      ]
    },
    {
      "type": "stat",
      "title": "Orders placed since the API started",
      "gridPos": {
        "x": 0,
        "y": 8,
        "w": 8,
        "h": 6
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {
          "decimals": 0
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(shop_orders)"
        }
      ]
    },
    {
      "type": "stat",
      "title": "5xx answers since the API started",
      "gridPos": {
        "x": 8,
        "y": 8,
        "w": 8,
        "h": 6
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {
          "decimals": 0,
          "color": {
            "mode": "thresholds"
          },
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {
                "color": "green",
                "value": null
              },
              {
                "color": "red",
                "value": 1
              }
            ]
          }
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(shop_http_requests{http_response_status_code=~\"5..\"}) or vector(0)"
        }
      ]
    },
    {
      "type": "stat",
      "title": "Requests since the API started",
      "gridPos": {
        "x": 16,
        "y": 8,
        "w": 8,
        "h": 6
      },
      "datasource": {
        "type": "prometheus",
        "uid": "mimir"
      },
      "fieldConfig": {
        "defaults": {
          "decimals": 0
        },
        "overrides": []
      },
      "targets": [
        {
          "refId": "A",
          "expr": "sum(shop_http_requests)"
        }
      ]
    }
  ]
}
```

</details>

**Image versions.** The three ouo images use `latest`, which follows each release; the comment
above each `image:` line says which version this guide was tested with (collector 0.4.0, rum-api
0.5.0, grafana 0.5.0) and its digest. To stay on it, pin `ghcr.io/ouo11y/collector:0.4.0` or the
`@sha256:...` digest. The configs here are written for those versions; a much newer image may
refuse a key, and `docker compose logs <service>` names it.

### 4b. Log in to ghcr.io

The ouo images are private for now. You need read access to the `ouo11y` packages and a
**classic** GitHub token with only the `read:packages` scope. Put the token in your shell
(`export GHCR_TOKEN=...`), never in a file, then:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <your-github-user> --password-stdin
```

### 4c. Check the ports

The stack publishes 3000 (Grafana), 4318 (OTLP) and 4320 (the Sentry bridge) to your network, and
3100, 3200, 9009 and 13133 on loopback only. This prints nothing when they are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4320|9009|13133) '
```

If something is listed, do not stop it: move this stack instead. From `stack/`:

```bash
code .env
```

and set the ports that are taken, for example:

```
OUO_GRAFANA_PORT=13000
OUO_SENTRY_PORT=14320
OUO_OTLP_HTTP_PORT=14318
```

Compose reads `.env` on its own. The others are `OUO_LOKI_PORT`, `OUO_TEMPO_PORT`,
`OUO_MIMIR_PORT` and `OUO_COLLECTOR_HEALTH_PORT`. Remember the new bridge and OTLP ports: steps 5
and 6 say where they go.

### 4d. Start it

From `stack/`:

```bash
docker compose up -d
```

```bash
docker compose ps
```

Six services are `Up`. Open http://localhost:3000 and log in with **admin / testing567**.
**More apps → ouo11y RUM** is there and still empty, and **Dashboards → Tiny Shop Mobile → Tiny
Shop Mobile API** has empty panels.

## Step 5. Instrument the API: traces and metrics

Stop the API with Ctrl+C in the backend tab (still in `backend/`), then:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/sdk-metrics @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/resources @opentelemetry/semantic-conventions
```

| Package | What it does here |
|---|---|
| `@opentelemetry/api` | the API `server.js` calls: `trace.getTracer`, `metrics.getMeter` |
| `@opentelemetry/sdk-node` | `NodeSDK`: wires the providers, the instrumentations and the resource |
| `@opentelemetry/sdk-trace` | `BatchSpanProcessor` (OpenTelemetry JS 3.0; `sdk-trace-base` before) |
| `@opentelemetry/sdk-metrics` | `PeriodicExportingMetricReader`: exports the counters every 10 s |
| `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http` | OTLP/HTTP to the collector, with the project credential |
| `@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-express` | a server span per request, named after the Express route; reads the app's `traceparent` |
| `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` | the resource: `service.name`, `service.version`, `deployment.environment.name` |

Create `backend/instrumentation.js`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/backend/instrumentation.js -->
```js
// OpenTelemetry SDK init: traces and metrics, both to the ouo collector over OTLP/HTTP.
// Loaded before the app with `node --require ./instrumentation.js` so the http and express
// instrumentations can patch those modules before server.js loads them.
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

// The ouo collector, the only ingest. Moved ports? OUO_OTLP_ENDPOINT=http://localhost:14318
const endpoint = process.env.OUO_OTLP_ENDPOINT || "http://localhost:4318";

// Every request needs the project credential: Basic base64("<project id>:<project token>").
// This is the quickstart's `demo` project: base64("demo:pt_dev_demo_0000000000000000").
const headers = { Authorization: "Basic ZGVtbzpwdF9kZXZfZGVtb18wMDAwMDAwMDAwMDAwMDAw" };

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "tiny-shop-mobile-signals-backend",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "local",
  }),
  // The app's Sentry SDK sends W3C `traceparent` (propagateTraceparent), which the default
  // propagator reads: the server span joins the app's trace.
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }) })],
  // Metrics: every 10 s the reader exports the current value of every counter and histogram in
  // server.js. The collector forwards /v1/metrics to Mimir.
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers }),
      exportIntervalMillis: 10000,
    }),
  ],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

sdk.start();
console.log(`[otel] traces and metrics to ${endpoint}`);

const shutdown = () => sdk.shutdown().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Replace `backend/server.js` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/backend/server.js -->
```js
// The API. HTTP server spans come from the auto-instrumentation; the spans and the metrics
// below are manual. A native app sends no CORS preflight, so there is no cors() here: the
// `traceparent`, `baggage` and `sentry-trace` headers the app adds are accepted as they are.
const express = require("express");
const { trace, metrics, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-mobile-signals-backend");
const meter = metrics.getMeter("tiny-shop-mobile-signals-backend");

// Three metrics, named like OpenTelemetry semantic conventions. Mimir turns dots into
// underscores: shop_http_requests, shop_http_request_duration_bucket, shop_orders.
const requests = meter.createCounter("shop.http.requests", {
  description: "API requests, by route and status code",
});
const duration = meter.createHistogram("shop.http.request.duration", {
  description: "API request duration",
  unit: "ms",
  advice: { explicitBucketBoundaries: [10, 25, 50, 100, 200, 400, 800] },
});
const orders = meter.createCounter("shop.orders", {
  description: "Checkouts placed, by number of items",
});

const app = express();
app.use(express.json());

// Count and time every request once the response is sent.
app.use((req, res, next) => {
  const start = performance.now();
  res.on("finish", () => {
    const attrs = { "http.route": req.route?.path ?? "unknown", "http.response.status_code": res.statusCode };
    requests.add(1, attrs);
    duration.record(performance.now() - start, attrs);
  });
  next();
});

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
  orders.add(1, { "app.cart.items": items.length });
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
app.listen(port, () => console.log(`tiny-shop-mobile-signals API on http://localhost:${port}`));
```

The SDK has to load before Express so the instrumentation can patch it. Save that as the start
script, then start the API:

```bash
npm pkg set scripts.start="node --require ./instrumentation.js server.js"
```

```bash
npm start
```

It prints `[otel] traces and metrics to http://localhost:4318`. Collector on 14318 (step 4c)?
Start it with `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` instead.

Three metrics, all from `server.js`: `shop.http.requests` (a counter by route and status code),
`shop.http.request.duration` (a histogram) and `shop.orders`. Mimir turns the dots into
underscores, so the dashboard queries `shop_http_requests`, `shop_http_request_duration_bucket`
and `shop_orders`.

## Step 6. Point the Sentry SDK at the bridge

### 6a. Install it

Stop Metro with Ctrl+C in the app tab (still in `app/`), then:

```bash
npm install --save-exact @sentry/react-native@8.32.0 @sentry/core@10.76.2
```

| Package | What it does here |
|---|---|
| `@sentry/react-native` 8.32.0 | the Sentry SDK for React Native: the JavaScript layer and, through CocoaPods, sentry-cocoa (native crashes, sessions, app start, frames, the transport) |
| `@sentry/core` 10.76.2 | `startNewTrace`, which `@sentry/react-native` does not re-export; pinned to the version `@sentry/react-native` 8.32.0 itself depends on, so there is one copy |

<details>
<summary>Which Sentry package is which (click to open)</summary>

| Package | Status | Used here? |
|---|---|---|
| `@sentry/react-native` | current, the React Native SDK (8.x) | yes |
| `sentry-expo` | deprecated since Expo SDK 50: `@sentry/react-native` has its own Expo config plugin | no |
| `@sentry/react` | the browser SDK for React web apps; no native crashes, no app start, no frames | no |
| `@sentry/core` | the shared core of every Sentry JavaScript SDK | only for `startNewTrace`, at the version `@sentry/react-native` uses |
| `@sentry/browser` | the browser SDK, a dependency of `@sentry/react-native` | not directly |

Why 8.32.0 and not `npx expo install @sentry/react-native`: Expo 57's list of tested native
modules still says `~7.11.0` (January 2026, sentry-cocoa 8). The bridge is tested with 8.30 and
later (`docs/compatibility.md` in the ouo repo), 8.32.0 accepts Expo 57 and React Native 0.86,
and it is the version this guide was verified with. Expo prints a warning that the version differs
from the expected one; that is this choice.

</details>

Put the Sentry plugin back into `plugins` in `app/app.json` (the file as it is in step 3c). The
plugin option `disableAutoUpload: true` matters: without it, every Release build runs sentry-cli
to upload source maps and debug symbols to sentry.io, and fails without a Sentry token.

### 6b. Configure and start the SDK

Replace `app/src/config.ts` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/src/config.ts -->
```ts
// Where the app sends its data, and the release it reports. EXPO_PUBLIC_* variables are read
// when Metro bundles the app: set them in app/.env (or the shell) and restart Metro.

// The ouo Sentry bridge, not sentry.io: http://<public key>@<bridge host>/<Sentry project id>.
// The stack's bridge accepts this public key for project 1. On the Simulator, localhost is your Mac.
export const SENTRY_DSN =
  process.env.EXPO_PUBLIC_SENTRY_DSN ?? "http://publickey0000000000000000000000@localhost:4320/1";

// The Tiny Shop API (backend/).
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

// Keep these in step with "version" and "ios.buildNumber" in app.json.
const VERSION = "1.0.0";
const BUILD = "1";

// release = <package>@<version>+<build>. The bridge turns it into service.version 1.0.0 and
// ouo.app.build 1 on every record; dist is the build again, as Sentry expects it.
export const RELEASE = `tiny-shop-mobile-signals@${VERSION}+${BUILD}`;
export const DIST = BUILD;
export const ENVIRONMENT = process.env.EXPO_PUBLIC_ENVIRONMENT ?? "development";
```

The DSN has the form `http://<public key>@<host>/<project id>`, the same as a sentry.io DSN with
another host: the bridge's project table (step 4a) accepts this key for project 1. Bridge on 14320
(step 4c)? Create `app/.env` with
`EXPO_PUBLIC_SENTRY_DSN=http://publickey0000000000000000000000@localhost:14320/1`; API on another
port, `EXPO_PUBLIC_API_URL=http://localhost:5002`. Expo reads `.env` when it bundles the app.

Create `app/src/sentry.ts`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/src/sentry.ts -->
```ts
// @sentry/react-native, pointed at the ouo Sentry bridge. Imported first by index.ts, so the
// SDK starts before the first screen renders and can measure the app start.
import * as Sentry from "@sentry/react-native";
import { API_URL, DIST, ENVIRONMENT, RELEASE, SENTRY_DSN } from "./config";

// One `navigation` transaction per screen change, with the time to initial display (TTID) of
// the new screen. App.tsx registers the navigation container with it.
export const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: true,
});

Sentry.init({
  dsn: SENTRY_DSN,
  // On every session, error, transaction and log: ouo shows them on each record.
  release: RELEASE,
  dist: DIST,
  environment: ENVIRONMENT,

  // Trace every screen and request. Below 1, unsampled requests tell the API not to record
  // its spans (docs/sentry-client-setup.md in the ouo repo, section 3).
  tracesSampleRate: 1.0,
  // Add sentry-trace, baggage and W3C traceparent to requests to the API only: traceparent is
  // what the OpenTelemetry API reads, so app and API spans share one trace.
  tracePropagationTargets: [API_URL],
  propagateTraceparent: true,

  // Sentry.logger.* (and console.*) as structured logs: one Loki line each.
  enableLogs: true,

  // The defaults that make the mobile vitals, written out so you can find them:
  enableAppStartTracking: true, // app_start_cold / app_start_warm on the first transaction
  enableNativeFramesTracking: true, // frames_total / frames_slow / frames_frozen per transaction
  enableStallTracking: true, // JS event-loop stalls per transaction
  enableNativeCrashHandling: true, // native crashes, reported on the next launch
  enableAutoSessionTracking: true, // one session per foreground use: healthy, errored, crashed
  // A Debug build loads its JavaScript from Metro while the main thread waits, which sentry-cocoa
  // reports as an "App Hang" error on every launch. Watch for hangs in Release builds only.
  enableAppHangTracking: !__DEV__,

  integrations: [navigationIntegration],
});

export { Sentry };
```

Each option in one line:

- `release`, `dist`, `environment`: on every session, error, transaction and log (step 7e).
- `tracesSampleRate: 1.0`: every screen and request is traced. Below 1, Sentry marks the unsampled
  requests' `traceparent` as not sampled and the API drops its spans for them.
- `tracePropagationTargets: [API_URL]`, `propagateTraceparent: true`: Sentry adds `sentry-trace`
  and `baggage` to requests to your API, and with `propagateTraceparent` also the W3C
  `traceparent` that OpenTelemetry reads. List your APIs only, never a bare `"localhost"`.
- `enableLogs: true`: `Sentry.logger.*` (and `console.*`) become structured logs.
- The `enable...Tracking` lines are the defaults, written out because each one is a vital you will
  look at. `enableAppHangTracking` is off in Debug builds only: a Debug build waits for its
  JavaScript from Metro on the main thread, and sentry-cocoa would report that as an "App Hang"
  error on every launch.
- `reactNavigationIntegration({ enableTimeToInitialDisplay: true })`: a `navigation` transaction
  for each screen change, with its time to initial display.

Replace `app/index.ts` with (Sentry has to start before React Native renders the first screen):

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/index.ts -->
```ts
// Sentry first: it must start before React Native renders anything, or the app start
// and the first screen's TTID are not measured.
import { Sentry } from "./src/sentry";
import { registerRootComponent } from "expo";
import App from "./App";

// Sentry.wrap adds touch breadcrumbs and the error boundary around the whole app.
registerRootComponent(Sentry.wrap(App));
```

Replace `app/App.tsx` with (the container is registered with the navigation integration once it
is ready):

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/App.tsx -->
```tsx
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import { navigationRef, setNavigationReady, type RootStackParamList } from "./src/navigation";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";
import { navigationIntegration } from "./src/sentry";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <CartProvider>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          // From here on, every screen change is a `navigation` transaction with its TTID.
          navigationIntegration.registerNavigationContainer(navigationRef);
          setNavigationReady();
        }}
      >
        <Stack.Navigator>
          <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
          <Stack.Screen name="Product" component={ProductScreen} />
          <Stack.Screen name="Cart" component={CartScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="auto" />
    </CartProvider>
  );
}
```

Replace `app/src/api.ts` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/src/api.ts -->
```ts
// The Tiny Shop API, with plain fetch. Sentry's fetch instrumentation records an http.client
// span for each request and adds sentry-trace, baggage and traceparent to it.
import { startNewTrace } from "@sentry/core";
import { Sentry } from "./sentry";
import { API_URL } from "./config";
import { navigationReady } from "./navigation";

export interface Product {
  id: number;
  name: string;
  price: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`${path} answered ${status}`);
    this.name = "HttpError";
  }
}

export async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  // A request that starts before the first screen's transaction exists would carry a parent
  // span id that no span has: wait the few ms until navigation is ready.
  await navigationReady;
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: init.json === undefined ? {} : { "content-type": "application/json" },
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  if (!res.ok) throw new HttpError(res.status, path);
  return (await res.json()) as T;
}

// A tap that does work: its own trace and its own `ui.action` transaction, so its requests
// are children of a span (never orphans) and its frames and stalls are measured.
export function action<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, fn));
}

export const formatPrice = (n: number) => `$${n.toFixed(2)}`;
```

Two rules from [the bridge's client setup](../../../docs/sentry-client-setup.md), section 4, are
in that file. A request sent while no span is active still gets a `traceparent`, with a parent
span id that no span has, and Tempo then shows the API's spans under a missing root. So
`api()` waits until navigation is ready (the first screen's data load then runs inside that
screen's transaction), and `action()` gives each tap that does work its own trace and its own
`ui.action` transaction.

### 6c. Rebuild and run

The SDK has native code, so this is a native rebuild (a few minutes, not ten). From `app/`:

```bash
npx expo run:ios
```

The app looks the same. Tap **Coffee**, then go back.

**More apps → ouo11y RUM → Sessions**: a `tiny-shop-mobile-signals` session, version `1.0.0`,
`active` and healthy. Its header already shows an app start and a TTID (step 7 explains them), its
activity has the screens and the products request, and its first trace is `Products`: the screen's
transaction → its `GET` span → the API's `GET /api/products` → `db.select products`, one trace
across app and API.

The screens are still the plain ones: their Checkout and Call broken API run outside any
transaction. Step 7's versions wrap them in `action()`.

## Step 7. The signals, one at a time

Replace the three screens with their final versions. They add log lines, a time-to-full-display
marker, and the Debug buttons that produce each signal.

Replace `app/src/screens/ProductsScreen.tsx` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/src/screens/ProductsScreen.tsx -->
```tsx
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Pressable, ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { startNewTrace } from "@sentry/core";
import { action, api, formatPrice, type Product } from "../api";
import { useCart } from "../cart";
import type { RootStackParamList } from "../navigation";
import { Sentry } from "../sentry";

type Nav = NativeStackNavigationProp<RootStackParamList, "Products">;
type Span = ReturnType<typeof Sentry.startInactiveSpan>;

// A text view this long takes iOS about a second to lay out, on the main thread: the UI
// freezes, and Sentry counts a frozen frame (700 ms or more) and a few slow ones.
const LONG_TEXT_LINES = 6000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ProductsScreen() {
  const navigation = useNavigation<Nav>();
  const cart = useCart();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [longText, setLongText] = useState<string | null>(null);
  const longTextSpan = useRef<Span | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => <Button title={`Cart (${cart.items.length})`} onPress={() => navigation.navigate("Cart")} />,
    });
  }, [navigation, cart.items.length]);

  // Runs inside this screen's navigation transaction: the request is one of its spans.
  useEffect(() => {
    api<Product[]>("/api/products")
      .then((list) => {
        setProducts(list);
        Sentry.logger.info(Sentry.logger.fmt`Loaded ${list.length} products`);
      })
      .catch((err: Error) => Sentry.logger.error(Sentry.logger.fmt`Could not load products: ${err.message}`));
  }, []);

  // The long text is on screen: end its `Render long text` transaction 3 s later. Sentry reads
  // the frame counters from the main thread when a transaction ends; ending it while the main
  // thread is still frozen would miss the frozen frame.
  useEffect(() => {
    const span = longTextSpan.current;
    if (longText === null || !span) return;
    longTextSpan.current = null;
    setTimeout(() => {
      span.end();
      Sentry.logger.info(Sentry.logger.fmt`Rendered a text of ${LONG_TEXT_LINES} lines`);
    }, 3000);
  }, [longText]);

  const renderLongText = () => {
    if (longText !== null) return setLongText(null);
    startNewTrace(() => {
      longTextSpan.current = Sentry.startInactiveSpan({ name: "Render long text", op: "ui.action", forceTransaction: true });
    });
    setLongText(Array.from({ length: LONG_TEXT_LINES }, (_, i) => `Line ${i + 1}`).join("\n"));
  };

  // Busy JavaScript for 1 s: the UI still draws, but taps wait. Sentry reports a JS stall.
  const blockJavaScript = () =>
    action("Block JavaScript", async () => {
      const end = Date.now() + 1000;
      while (Date.now() < end) {
        // busy
      }
      await sleep(500); // keep the transaction open past the stall
      Sentry.logger.warn("Blocked the JavaScript thread for 1 s");
    });

  const callBrokenApi = () =>
    action("Call broken API", () => api("/api/fail")).catch((err: Error) => {
      Sentry.logger.error(Sentry.logger.fmt`Broken API: ${err.message}`);
      Alert.alert("The API failed", err.message);
    });

  const handledError = () => {
    try {
      JSON.parse("{ coupon: ");
    } catch (err) {
      Sentry.captureException(err);
      Sentry.logger.warn("Coupon parse failed, reported as a handled error");
    }
  };

  const throwError = () => {
    Sentry.logger.error("About to throw an unhandled error");
    // Outside React's render: a JavaScript fatal error, the session ends `crashed`.
    setTimeout(() => {
      throw new Error("Cart total is NaN");
    });
  };

  const nativeCrash = () => {
    Sentry.logger.error("About to crash in native code");
    // Crashes sentry-cocoa's native code on purpose. The report is written to disk and sent on
    // the next launch. Use a Release build: in Debug, Xcode's debugger can catch it first.
    Sentry.nativeCrash();
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {/* Time to full display: the screen counts as fully drawn once the products are shown. */}
      <Sentry.TimeToFullDisplay record={products !== null} />
      {products === null ? <Text>Loading…</Text> : null}
      {products?.map((p) => (
        <Pressable key={p.id} style={styles.row} onPress={() => navigation.navigate("Product", { product: p })}>
          <Text style={styles.name}>{p.name}</Text>
          <Text>{formatPrice(p.price)}</Text>
        </Pressable>
      ))}

      <Text style={styles.section}>Debug</Text>
      <Button title="Call broken API" onPress={callBrokenApi} />
      <Button title="Handled error" onPress={handledError} />
      <Button title="Throw error" onPress={throwError} />
      <Button title="Native crash" onPress={nativeCrash} />
      <Button title={longText === null ? "Render long text" : "Hide long text"} onPress={renderLongText} />
      <Button title="Block JavaScript 1 s" onPress={blockJavaScript} />
      {longText !== null ? <TextInput multiline editable={false} scrollEnabled={false} value={longText} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", padding: 16, backgroundColor: "#f2f2f2", borderRadius: 8 },
  name: { fontWeight: "600" },
  section: { marginTop: 24, fontWeight: "700", color: "#888" },
});
```

Replace `app/src/screens/ProductScreen.tsx` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/src/screens/ProductScreen.tsx -->
```tsx
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { useLayoutEffect } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { formatPrice } from "../api";
import { useCart } from "../cart";
import type { RootStackParamList } from "../navigation";
import { Sentry } from "../sentry";

export function ProductScreen() {
  const navigation = useNavigation();
  const { product } = useRoute<RouteProp<RootStackParamList, "Product">>().params;
  const cart = useCart();

  useLayoutEffect(() => navigation.setOptions({ title: product.name }), [navigation, product.name]);

  const addToCart = () => {
    cart.add(product);
    // The log body is the Loki line; the attributes are searchable next to it.
    Sentry.logger.info(Sentry.logger.fmt`Added ${product.name} to cart`, {
      "product.id": product.id,
      "cart.items": cart.items.length + 1,
    });
    navigation.goBack();
  };

  return (
    <View style={styles.page}>
      <Text style={styles.name}>{product.name}</Text>
      <Text style={styles.price}>{formatPrice(product.price)}</Text>
      <Button title="Add to cart" onPress={addToCart} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  name: { fontSize: 28, fontWeight: "700" },
  price: { fontSize: 20 },
});
```

Replace `app/src/screens/CartScreen.tsx` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-signals/result/app/src/screens/CartScreen.tsx -->
```tsx
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Button, StyleSheet, Text, View } from "react-native";
import { action, api, formatPrice } from "../api";
import { useCart } from "../cart";
import { Sentry } from "../sentry";

export function CartScreen() {
  const navigation = useNavigation();
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  const checkout = () => {
    setBusy(true);
    const items = cart.items.map((p) => p.id);
    // POST /api/checkout in its own trace: the API's checkout -> validate cart, charge card
    // spans are children of this tap's http.client span.
    action("Checkout", () => api<{ orderId: number }>("/api/checkout", { method: "POST", json: { items } }))
      .then((order) => {
        Sentry.logger.info(Sentry.logger.fmt`Order ${order.orderId} placed: ${items.length} items, ${formatPrice(total)}`);
        cart.clear();
        navigation.goBack();
      })
      .catch((err: Error) => {
        Sentry.logger.error(Sentry.logger.fmt`Checkout failed: ${err.message}`);
        Alert.alert("Checkout failed", err.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.page}>
      {cart.items.length === 0 ? <Text>Your cart is empty.</Text> : null}
      {cart.items.map((p, i) => (
        <Text key={i}>
          {p.name} {formatPrice(p.price)}
        </Text>
      ))}
      <Text style={styles.total}>Total {formatPrice(total)}</Text>
      <Button title={busy ? "Placing order…" : "Checkout"} onPress={checkout} disabled={busy || cart.items.length === 0} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 8 },
  total: { fontSize: 20, fontWeight: "700", marginVertical: 12 },
});
```

Metro reloads the app when you save. The Products screen now has six Debug buttons. Tap
**Coffee**, **Add to cart**, **Cart (1)**, **Checkout**, then **Call broken API**: the session
becomes `errored` (the failed request), and the `Checkout` trace runs from the app's `Checkout`
transaction → its `POST` span → the API's `POST /api/checkout` → `checkout` → `validate cart`,
`charge card`.

Where to look for everything below: **ouo11y RUM → Sessions → the newest session**. Its header sums
up the vitals (app start, TTID p50 / max, slow and frozen frames, JS stalls), and its timeline has
one entry per record, coloured by rating. In Loki (Explore → Loki), the records are
`{service_name="tiny-shop-mobile-signals"}`, one `event_name` label per kind. Give each one up to
half a minute: the SDK sends a transaction when it ends, and logs 5 s after the last one.

### 7a. App start, cold and warm

sentry-cocoa measures from the process start to the first frame, and the SDK puts it on the first
transaction; the bridge writes one `ouo.app.start` per session, shown as `App start (warm) 1.75 s`
on the timeline and `Warm start 1.75 s` in the header:

- **cold**: the first launch after the app was installed (or the device restarted). To see one,
  delete the app from the Simulator (long-press its icon, **Remove App**) and run
  `npx expo run:ios` again.
- **warm**: the process was started again while iOS still had the app cached. Leave Metro
  running, quit the app from the stack tab (any folder works):

```bash
xcrun simctl terminate booted dev.ouo.tinyshop.m3
```

  then tap the Tiny Shop icon on the Simulator's home screen.

The plugin rates a cold start under 2 s as good and 5 s or more as poor; a warm start under 1 s
and 2 s or more. **Debug numbers are not your app's numbers**: a Debug build loads and parses its
JavaScript from Metro before the first frame, so a first Debug launch reads 20 to 30 s and a warm
one 3 to 5 s. Step 8's Release build shows real values.

`simctl terminate` kills the process, so the session you left ends as `terminated` (Sentry's
`abnormal`), reported when the app starts again.

### 7b. Time to initial display and full display

The React Navigation integration times each screen change from the navigation to the first frame
of the new screen: `ouo.screen.display` with `ouo.screen.ttid_ms`. Tap **Coffee**: the timeline
gets `Product displayed in ...`. The first screen's TTID counts from the app start, so it is close
to the app start's duration.

Time to full display is yours to mark: `<Sentry.TimeToFullDisplay record={products !== null} />`
in `ProductsScreen` says the screen is complete once the products are shown, and the record gets
`ouo.screen.ttfd_ms` too. Screens without the marker have TTID only.

### 7c. Slow and frozen frames, JS stalls

Two threads draw a React Native app. The **main thread** draws the native views: a frame longer
than the screen's frame time (16.7 ms at 60 Hz) is **slow**, one of 700 ms or more is **frozen**
(the UI does not respond at all). The **JavaScript thread** runs your React code: a loop iteration
of 100 ms or more is a **stall** (the UI still draws, but taps wait).

- **Render long text**: one 6,000-line text view. iOS lays it out on the main thread, which takes
  about a second: the `Render long text` transaction's `app.jank` record has `ouo.frames.frozen`
  1, the timeline says `Janky frames 2 / 101 (1 frozen)`, and the header
  `Frames 2 slow · 1 frozen / 206`.
- **Block JavaScript 1 s**: a busy loop on the JavaScript thread. The `Block JavaScript`
  transaction gets an `ouo.stall` record of about 1,000 ms; its frames stay smooth.

Every transaction that drew frames gets an `app.jank` record (`ouo.vital.window` says whether it was
a screen load or an interaction), so even plain navigation adds a few slow frames in Debug builds.
Frames and stalls are measured per transaction: work outside any transaction is not counted.
An interaction's screen is the screen of the last transaction the bridge saw: after going back from
Cart to Products (a back navigation sends no transaction), the timeline still says `Cart` for the
next taps.

In Loki, the vital records have no message (their body is empty by design), so the line shows
only the event name; open a line to read its attributes, or query them:

```
{service_name="tiny-shop-mobile-signals", event_name="app.jank"} | ouo_frames_frozen > 0
```

### 7d. Structured logs

Each `Sentry.logger.info(...)`, `.warn`, `.error` call becomes one Loki line whose text is the
message: `Loaded 3 products`, `Added Coffee to cart`, `Order 70939 placed: 1 items, $4.00`,
`Broken API: /api/fail answered 500`. `Sentry.logger.fmt` keeps the template as
`ouo_sentry_log_template` next to it, so you can count all `Added %s to cart` lines whatever the
product; extra attributes (`product.id`, `cart.items`) are searchable too:

```
{service_name="tiny-shop-mobile-signals", event_name="log"}
```

Each line carries the trace id of the tap that wrote it (open it to jump to the trace) and the
session id. With `enableLogs`, `console.*` output is sent too, as `event_name="console"`.

### 7e. Release, environment and dist

`release` = `tiny-shop-mobile-signals@1.0.0+1`, `dist` = `1`, `environment` = `development`
(`src/config.ts`). On every record and span the bridge writes:

| Attribute | Value | Where you filter on it |
|---|---|---|
| `service.version` | `1.0.0` (between `@` and `+`) | the session list, Tempo, Loki (`service_version`) |
| `ouo.app.build` | `1` (after `+`) | Loki (`ouo_app_build`), Tempo |
| `ouo.sentry.release` | the release as the SDK sent it | Loki, Tempo |
| `deployment.environment.name` | `development` | a Loki label, Tempo |

To see a new release, change `"version"` and `"buildNumber"` in `app.json` and `VERSION` and
`BUILD` in `src/config.ts` (for example `1.1.0` and `2`), rebuild, and compare the sessions of the
two versions. With `EXPO_PUBLIC_ENVIRONMENT=staging` in `app/.env`, a build reports `staging`.

### 7f. The API's metrics

**Dashboards → Tiny Shop Mobile → Tiny Shop Mobile API**: requests per second by route and status
(`/api/fail 500` from **Call broken API**), p50 / p95 latency, and the orders placed. Each tap
in the app shows there within 10 s, the API's export interval.

### 7g. Errors

**Handled error** reports a caught `SyntaxError` with `Sentry.captureException`: the session
becomes `errored`, and the timeline has the exception with its JavaScript stack. **Throw error**
throws outside React: a JavaScript fatal error, `Error: Cart total is NaN`. In a Release build
(step 8) the app closes, and when you open it again the session shows as `crashed` with that
error; in a Debug build React Native shows its red error screen instead of closing.

## Step 8. A native crash (Release build)

`Sentry.nativeCrash()` crashes in sentry-cocoa's native code, like a bug in a native module would.
sentry-cocoa writes the crash report to disk as the process dies and sends it on the **next
launch**. Use a Release build: the JavaScript is bundled into the app (no Metro), the numbers are
real, and nothing can catch the crash first.

In the app tab, stop Metro (Ctrl+C), then from `app/`:

```bash
npx expo run:ios --configuration Release
```

The Release build takes a few minutes the first time, and the app opens on its own. Installed over
the Debug build of the same version, this launch counts as **warm**; remove the app first for a
**cold** one (step 7a). The values are now real: on the Mac this guide was verified on, about
1.7 s cold, 1.5 s warm, and 0.5 to 0.6 s TTID for Product and Cart.

1. Tap **Coffee**, **Add to cart**, then **Native crash**. The app disappears.
2. Open it again from the Simulator's home screen (tap the Tiny Shop icon).
3. Wait half a minute.

**ouo11y RUM → Sessions**: the session before the crash is **crashed**, with 1 crash. Its timeline
ends with the exception: `EXC_BAD_ACCESS`, `Attempted to dereference null pointer.`, mechanism
`mach`, fatal, unhandled, and the native stack, newest frame first. The frames read like
`at ? (TinyShop 0x00000001005441d8 0x100510000 + 213464) [in app]`: image, address, load address
and offset, the form Apple's `atos` takes with the app's dSYM to turn them into function names and
lines. ouo does not symbolicate native frames yet; `ouo.sentry.debug_images` on the record lists
the images and their debug ids for when you do. The record also carries the release
(`service.version` 1.0.0, `ouo.app.build` 1): the build whose dSYM you need. The new session after
the crash starts with its own app start.

To get back to Debug, run `npx expo run:ios` again.

## Step 9. Clean up

Stop the API and Metro with Ctrl+C. Remove the app from the Simulator (long-press its icon, **Remove
App**), or erase it with:

```bash
xcrun simctl uninstall booted dev.ouo.tinyshop.m3
```

Stop the stack, keeping its data (in the stack's tab, from `stack/`):

```bash
docker compose down
```

or delete its data too:

```bash
docker compose down -v
```

## When something does not work

| You see | Cause and fix |
|---|---|
| `Bind for 0.0.0.0:4320 failed: port is already allocated` | another stack has the port: step 4c, move this one with `stack/.env`, then set `EXPO_PUBLIC_SENTRY_DSN` in `app/.env` |
| `denied` when pulling `ghcr.io/ouo11y/...` | not logged in to ghcr.io, or no read access yet: step 4b |
| A service keeps restarting after a pull | a newer `latest` that wants a different config: `docker compose logs <service>` names the key; pin the tested version (step 4a, "Image versions") |
| The app starts, nothing in ouo11y RUM | the DSN does not reach the bridge: check its port, and `docker compose logs otel-collector` for `401` (wrong public key or project id in the DSN) |
| `The resource could not be loaded because the App Transport Security policy requires the use of a secure connection` | `NSAllowsLocalNetworking` is missing from `app.json`, or the app was not rebuilt after adding it (`npx expo run:ios`) |
| The build fails in "Upload Debug Symbols to Sentry" or asks for `SENTRY_AUTH_TOKEN` | the Sentry plugin lost `"disableAutoUpload": true` in `app.json` |
| The app stops at launch on iOS 27, `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` | the UIScene plugin is missing from `app.json` `plugins` (step 3c); run `npx expo prebuild --clean`, then `npx expo run:ios` |
| A Debug session is `errored` with an "App Hang" | `enableAppHangTracking` is on in a Debug build: keep `!__DEV__` (step 6b) |
| The API's spans hang under a missing parent in Tempo | a request outside any transaction: wrap it in `action()` (step 6b) |
| The API's spans are in their own trace | `traceparent` is not sent: `propagateTraceparent: true`, and `tracePropagationTargets` must match the API URL including its port |
| A session has no app start or TTID, although Tempo has its first transaction | a known bridge race (N53): the transaction was translated before its session existed. Seen 0 times in this guide's verification runs; quit and relaunch to get a new session |
| `Render long text` has no frozen frame | the transaction ended while the main thread was still busy, so Sentry read the frame counters before the frozen frame was recorded; keep the 3 s delay in `ProductsScreen.tsx` |
| No native crash after relaunching | the app was launched from Xcode with the debugger attached (it catches the crash), or you did not open it again: the report is sent on the next launch |
| `npx expo install` wants `@sentry/react-native@~7.11.0` | Expo's tested version; this guide uses 8.32.0 on purpose (step 6a) |
| Nothing in Tempo yet | wait up to a minute: new traces reach search later than trace-by-id |
