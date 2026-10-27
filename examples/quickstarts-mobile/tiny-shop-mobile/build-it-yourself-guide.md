# Build Tiny Shop Mobile with Sentry, through the ouo bridge

This guide is for teams whose React Native app already reports to Sentry with
`@sentry/react-native` and who want ouo's sessions, errors, traces and logs without changing SDK.
The app keeps the Sentry SDK; its DSN points at the **ouo Sentry bridge**, a receiver in the ouo
collector that answers like Sentry and translates every envelope into OpenTelemetry. Here the
bridge runs with `upstream: none`: you need no Sentry account, and nothing leaves your laptop.

You build, one step at a time, with no scripts:

1. a plain Express API and a plain Expo app (Products, Product, Cart, a Debug section), with no
   telemetry at all;
2. the ouo stack (the ouo collector with its Sentry bridge, Tempo, Loki, Mimir, rum-api, Grafana),
   one folder per service;
3. the API traced with the OpenTelemetry Node SDK (the same as in
   [tiny-shop-otel](../../quickstarts/tiny-shop-otel/build-it-yourself-guide.md));
4. `@sentry/react-native` in the app, with the DSN pointed at the bridge, so that one tap is one
   trace from the app to the API.

At the end your files are the same as [`result/`](result): compare with them when you are
stuck. Plan on about 60 minutes, 10 to 15 of them for the first iOS builds.

```
tiny-shop-mobile/
├── stack/      the ouo stack, one folder per service
├── backend/    Express API, OpenTelemetry traces
└── app/        Expo app (React Native), @sentry/react-native with the bridge as DSN
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`tiny-shop-mobile/`, wherever you create it, and each command says which of its folders it runs
in. When a step says "replace the file", select everything in it and paste the new content over it.

## What ouo needs from a Sentry app

The Sentry SDK already sends sessions, errors, transactions and logs. The bridge needs four
things from you, and each line links to the step that sets it:

| What | How | Step |
|---|---|---|
| **Where** | the DSN's host is the bridge: `http://<public key>@localhost:4320/<project id>` | [6c](#6c-point-sentry-at-the-bridge) |
| **Which project** | the bridge's `projects` table maps that public key and project id to the ouo project and the service name (`tiny-shop-mobile`) | [4a](#4a-create-the-files) |
| **One trace with the API** | `tracesSampleRate: 1`, `propagateTraceparent: true`, `tracePropagationTargets: [<API URL>]`, and an active span around every request | [6c](#6c-point-sentry-at-the-bridge), [6d](#6d-one-trace-per-tap) |
| **Readable logs** | `enableLogs: true` and `Sentry.logger.*` lines that say what happened | [6e](#6e-log-what-happens) |

From these, ouo builds the session (healthy, errored or crashed) from Sentry's own session
updates, its errors with their stacks, its traces, and its logs. A session Sentry reports as
`crashed` is `crashed`; one with a handled error or a failed request is `errored`.

## Step 0. Check your tools

A Mac with Xcode 27 and its iOS 27 simulator. This prints `Xcode 27.0` or newer:

```bash
xcodebuild -version
```

This lists an `iOS 27` runtime (Xcode -> Settings -> Components installs it):

```bash
xcrun simctl list runtimes
```

Node 24 or newer:

```bash
node -v
```

Docker Desktop must be running. This prints the server details, not "Cannot connect":

```bash
docker info
```

VS Code's `code` command. If it is not found, open VS Code, press Cmd+Shift+P and run
**Shell Command: Install 'code' command in PATH**.

```bash
code --version
```

## Step 1. Create the folders and open VS Code

From the folder where you keep your projects:

```bash
mkdir -p tiny-shop-mobile/backend tiny-shop-mobile/stack
```

```bash
cd tiny-shop-mobile
```

```bash
code .
```

In VS Code, open a terminal with Ctrl+\`. You will use three terminal tabs (the `+` button):
one for the backend, one for the app, one for the stack. Each new tab opens in
`tiny-shop-mobile/`.

## Step 2. A simple API, no telemetry yet

In the first terminal tab, from `tiny-shop-mobile/`:

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

app.listen(5001, () => console.log("tiny-shop API on http://localhost:5001"));
```

No `cors()`, unlike the web Tiny Shop: a native app sends no CORS preflight, so every header it
adds reaches the API as it is.

Run it:

```bash
node server.js
```

In another terminal tab, check that it answers:

```bash
curl localhost:5001/api/products
```

You get the three products as JSON. Leave the API running.

## Step 3. A plain Expo app

In the second terminal tab, from `tiny-shop-mobile/`. `create-expo-app` creates `app/` from
Expo's TypeScript template, pinned to Expo SDK 57 (React Native 0.86): without `@sdk-57` it
now picks SDK 58.

```bash
npx create-expo-app@latest app --template blank-typescript@sdk-57
```

```bash
cd app
```

`npx expo install` picks the versions that match the app's Expo SDK:

```bash
npx expo install @react-navigation/native @react-navigation/native-stack react-native-screens react-native-safe-area-context
```

| Package | What it does here |
|---|---|
| `@react-navigation/native` | the navigation container: which screen is shown, the back stack |
| `@react-navigation/native-stack` | a stack of screens with the native iOS header and back button |
| `react-native-screens`, `react-native-safe-area-context` | the native views the stack is built on, and the notch and home bar insets |

The app's code goes in two new folders:

```bash
mkdir -p src/screens plugins
```

### 3a. Run on iOS 27

iOS 27 stops any app at launch that does not use the UIScene life cycle, and Expo 57's template
does not add it yet. This config plugin does, when Expo generates the iOS project. Create
`app/plugins/withUIScene.js`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/plugins/withUIScene.js -->
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

Replace `app/app.json` with the app's name, its bundle id, plain-http access to your Mac (the
API is `http://localhost`) and the plugin:

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
      "bundleIdentifier": "dev.ouo.tinyshop.m1",
      "infoPlist": {
        "NSAppTransportSecurity": { "NSAllowsLocalNetworking": true }
      }
    },
    "plugins": ["./plugins/withUIScene.js"]
  }
}
```

### 3b. The code

`app/src/config.ts`, where the API is. `EXPO_PUBLIC_*` variables are put into the JS bundle by
Metro, so you can move the API later with an `app/.env` file:

```ts
// Where the app sends its requests. Expo inlines EXPO_PUBLIC_* variables into the JS bundle when
// Metro builds it: set them in app/.env and restart Metro to change them.

// The Tiny Shop API (backend/). The simulator reaches your Mac on localhost.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";
```

`app/src/api.ts`, the three API calls:

```ts
// The Tiny Shop API, with plain fetch.
import { API_URL } from "./config";

export interface Product {
  id: number;
  name: string;
  price: number;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`${path} answered ${status}`);
    this.name = "HttpError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new HttpError(res.status, path);
  return (await res.json()) as T;
}

export const getProducts = () => request<Product[]>("/api/products");

export const checkout = (items: number[]) =>
  request<{ ok: boolean; orderId: number }>("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });

export const callBrokenApi = () => request<unknown>("/api/fail");
```

`app/src/navigation.ts`, the three screens and their parameters:

```ts
// The screens and their parameters.
import { createNavigationContainerRef } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Product } from "./api";

export type RootStackParamList = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;

export const navigationRef = createNavigationContainerRef<RootStackParamList>();
```

`app/src/cart.tsx`, the cart, shared by the screens:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/cart.tsx -->
```tsx
// The cart, shared by the three screens.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { Product } from "./api";

type Cart = { items: Product[]; add: (p: Product) => void; clear: () => void };

const CartContext = createContext<Cart>({ items: [], add: () => {}, clear: () => {} });

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Product[]>([]);
  const add = (p: Product) => setItems((prev) => [...prev, p]);
  const clear = () => setItems([]);
  return <CartContext.Provider value={{ items, add, clear }}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
```

`app/src/ui.tsx`, a button and the styles:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/ui.tsx -->
```tsx
// Two small building blocks the screens share.
import { Pressable, StyleSheet, Text } from "react-native";

export function Button({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fff" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12 },
  title: { fontSize: 22, fontWeight: "600" },
  text: { fontSize: 17 },
  muted: { fontSize: 15, color: "#666" },
  section: { marginTop: 24, fontSize: 13, fontWeight: "600", color: "#666", textTransform: "uppercase" },
  button: { backgroundColor: "#1f6feb", borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
```

`app/src/screens/ProductsScreen.tsx`, the list and the Debug section:

```tsx
// Products: the list from GET /api/products, and the Debug section.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { callBrokenApi, getProducts, type Product } from "../api";
import type { ScreenProps } from "../navigation";
import { Button, styles } from "../ui";

export function ProductsScreen({ navigation }: ScreenProps<"Products">) {
  const [products, setProducts] = useState<Product[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getProducts()
      .then(setProducts)
      .catch((e: Error) => setMessage(e.message));
  }, []);

  const brokenApi = async () => {
    try {
      await callBrokenApi();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const handledError = () => {
    try {
      throw new Error("Coupon code TINY10 is not valid");
    } catch (e) {
      setMessage(`Caught: ${(e as Error).message}`);
    }
  };

  const throwError = () => {
    throw new Error("Button exploded");
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {products.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          accessibilityLabel={p.name}
          style={styles.row}
          onPress={() => navigation.navigate("Product", { product: p })}
        >
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.muted}>${p.price}</Text>
        </Pressable>
      ))}
      <Button title="Cart" onPress={() => navigation.navigate("Cart")} />

      <Text style={styles.section}>Debug</Text>
      <Button title="Call broken API" onPress={brokenApi} />
      <Button title="Handled error" onPress={handledError} />
      <Button title="Throw error" onPress={throwError} />
      <Text style={styles.muted}>{message}</Text>
    </ScrollView>
  );
}
```

`app/src/screens/ProductScreen.tsx`:

```tsx
// Product: one product and "Add to cart".
import { Text, View } from "react-native";
import { useCart } from "../cart";
import type { ScreenProps } from "../navigation";
import { Button, styles } from "../ui";

export function ProductScreen({ route, navigation }: ScreenProps<"Product">) {
  const { product } = route.params;
  const cart = useCart();

  const add = () => {
    cart.add(product);
    navigation.goBack();
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button title="Add to cart" onPress={add} />
    </View>
  );
}
```

`app/src/screens/CartScreen.tsx`:

```tsx
// Cart: the items and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { checkout } from "../api";
import { useCart } from "../cart";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [message, setMessage] = useState("");
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  const onCheckout = async () => {
    const order = await checkout(cart.items.map((p) => p.id));
    setMessage(`Order #${order.orderId} placed`);
    cart.clear();
  };

  return (
    <View style={styles.screen}>
      {cart.items.map((p, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.muted}>${p.price}</Text>
        </View>
      ))}
      <Text style={styles.text}>Total: ${total}</Text>
      <Button title="Checkout" onPress={onCheckout} disabled={!cart.items.length} />
      <Text style={styles.muted}>{message}</Text>
    </View>
  );
}
```

Replace `app/App.tsx` with the navigation:

```tsx
// Navigation: Products, Product and Cart in a native stack, around the shared cart.
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import { navigationRef, type RootStackParamList } from "./src/navigation";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <CartProvider>
      <NavigationContainer ref={navigationRef}>
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

### 3c. Build and run it

From `app/`:

```bash
npx expo run:ios
```

The first run generates `ios/`, installs the pods and builds the app: 5 to 10 minutes. Then the
simulator opens with **Tiny Shop**: Coffee, Tea and Cake (the app reached your API). Tap
**Coffee**, **Add to cart**, **Cart**, **Checkout**: "Order #… placed". **Throw error** on
Products shows a red error screen: that is how a Debug build shows an uncaught JS error. Dismiss
it, or press `r` in the Metro terminal to reload. The app works, and nothing is instrumented yet.

Metro keeps running in this tab: it serves the JS to the app, and every file you save reloads
the app.

## Step 4. The stack, one service at a time

### 4a. Create the files

Six services, one folder each. Each folder holds that service's compose file and its config, and
each file starts with what the service is for, who sends it data and its ports. Open a block, copy
all of it, and paste it into the file named in its title (VS Code creates the folders when you
save a new file as `stack/10-collector/compose.yaml`).

`compose.yaml` only lists the service folders:

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/compose.yaml -->
```yaml
# The ouo stack for tiny-shop-mobile: one folder per service, each with its compose file and
# its config. This file only lists them. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), Sentry bridge :4320, OTLP :4318.
# Ports taken? Set OUO_GRAFANA_PORT, OUO_SENTRY_PORT, OUO_OTLP_HTTP_PORT, ... in stack/.env.
include:
  - 10-collector/compose.yaml   # ingest: the app's Sentry SDK and the API's OpenTelemetry SDK send here
  - 20-tempo/compose.yaml       # traces
  - 30-loki/compose.yaml        # logs and session events
  - 40-mimir/compose.yaml       # metrics (none from this shop yet; the collector accepts /v1/metrics)
  - 50-rum-api/compose.yaml     # sessions for the Grafana plugin
  - 60-grafana/compose.yaml     # the UI: datasources and the ouo11y RUM app
```

</details>

**The ouo collector is the only thing the app and the API talk to.** It has two doors: the
Sentry bridge on 4320, for the app's Sentry SDK, and OTLP on 4318, for the API. The bridge's
`projects` table is where the app's DSN is checked: public key `publickey0000000000000000000000`,
project `1`, mapped to the ouo project `demo` and the service name `tiny-shop-mobile`.
`upstream: none` makes the bridge answer the SDK itself instead of forwarding to Sentry.

<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/10-collector/compose.yaml -->
```yaml
# ouo-collector: the only ingest. The app's Sentry SDK sends its envelopes to the Sentry bridge
# (4320), the API sends OTLP (4318). It translates the envelopes into OpenTelemetry and forwards
# traces to Tempo, logs to Loki and metrics to Mimir. Ports: 4320 Sentry bridge and 4318
# OTLP/HTTP (both public), 13133 health (loopback).
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
    volumes:
      - ./config.yaml:/etc/otelcol/config.yaml:ro
      - ./projects.htpasswd:/etc/otelcol/projects.htpasswd:ro
    depends_on: [tempo, loki, mimir]
```

</details>

<details>
<summary><code>stack/10-collector/config.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/10-collector/config.yaml -->
```yaml
# ouo-collector pipelines, a trimmed copy of the full stack's config (no rate limits, no replay
# receiver). Receivers: the Sentry bridge on 4320 (the app's DSN points here) and OTLP/HTTP on
# 4318 behind the project credential in projects.htpasswd (the API). Exporters: Tempo, Loki,
# Mimir, and rum-api for the replay chunks the bridge makes when an app turns Sentry replay on.

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
  # The Sentry bridge. The app's DSN is http://<public key>@<this host>:4320/<project id>; the
  # bridge looks the pair up in `projects` and turns sessions, errors, transactions and logs into
  # OpenTelemetry for the ouo project `demo`, under the service name below.
  ouosentry:
    endpoint: 0.0.0.0:4320
    projects:
      - sentry_project_id: "1"
        public_keys: ["publickey0000000000000000000000"]
        # `none`: answer the SDK here, send nothing to Sentry. A Sentry ingest URL
        # (https://oNNN.ingest.sentry.io) forwards every envelope there unchanged as well.
        upstream: none
        ouo_project_id: demo
        service_name: tiny-shop-mobile

connectors:
  # The bridge emits replay chunks on its logs output: send them to rum-api, the rest to Loki.
  routing/sentry:
    default_pipelines: [logs]
    table:
      - context: log
        condition: log.attributes["ouo.replay.chunk"] == true
        pipelines: [logs/replay]

processors:
  # Stamp the authenticated project id on every resource (and drop any value the client sent).
  # The bridge sets the project from its `projects` table, the API from its credential.
  resource/project:
    attributes:
      - key: ouo.project.id
        action: delete
      - key: ouo.project.id
        from_context: auth.username
        action: upsert
  # Copy the OTLP event name into the `event.name` attribute, which Loki turns into a label,
  # and `ouo.platform` from the resource onto each record.
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

service:
  extensions: [health_check, basicauth/server]
  pipelines:
    traces:
      receivers: [otlp, ouosentry]
      processors: [resource/project, batch]
      exporters: [otlp_grpc/tempo]
    # The bridge's records before routing (no batch here: it would drop the project context).
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/10-collector/projects.htpasswd -->
```
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

**Tempo stores the traces:** the app's transactions and spans, translated by the bridge, and
the API's spans.

<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/20-tempo/compose.yaml -->
```yaml
# Tempo: stores traces. The collector sends it spans from the app (via the bridge) and the API over OTLP/gRPC;
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/20-tempo/config.yaml -->
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

**Loki stores the logs:** the session events and errors the bridge writes, and your
`Sentry.logger` lines.

<details>
<summary><code>stack/30-loki/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/30-loki/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/30-loki/config.yaml -->
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

**Mimir stores metrics.** Nothing in this quickstart sends any yet; the stack is the same for
every quickstart.

<details>
<summary><code>stack/40-mimir/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/40-mimir/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/40-mimir/config.yaml -->
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

**rum-api builds the sessions** (healthy, errored, crashed) from Loki and Tempo for the Grafana
plugin.

<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/50-rum-api/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/50-rum-api/config.yaml -->
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

**Grafana is the UI**, with the ouo11y RUM app and the three datasources.

<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/60-grafana/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/60-grafana/provisioning/datasources/datasources.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml -->
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

### 4b. Log in to ghcr.io

The ouo images are private for now. You need read access to the `ouo11y` packages and a
**classic** GitHub token with only the `read:packages` scope. Put the token in your shell
(`export GHCR_TOKEN=...`), never in a file, then:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <your-github-user> --password-stdin
```

### 4c. Check the ports

The stack publishes 3000 (Grafana) and the collector's 4320 (Sentry bridge) and 4318 (OTLP) to
your network, and 3100, 3200, 9009 and 13133 on loopback only. This prints nothing when they are
all free:

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
`OUO_MIMIR_PORT` and `OUO_COLLECTOR_HEALTH_PORT` (the `${OUO_..._PORT:-...}` lines in the
compose files). Remember the new collector ports: steps 5 and 6 tell you where they go.

### 4d. Start it

In the third terminal tab, from `tiny-shop-mobile/`:

```bash
cd stack
```

```bash
docker compose up -d
```

```bash
docker compose ps
```

Six services are `Up`, and `rum-api` becomes `healthy`. Open http://localhost:3000 and log in
with **admin / testing567**. **More apps -> ouo11y RUM** is there and still empty.

The bridge answers like Sentry. A request with a key that is not in its `projects` table is
refused, which shows it is listening:

```bash
curl -i -X POST "localhost:4320/api/1/envelope/?sentry_key=wrong"
```

`HTTP/1.1 403 Forbidden`, `{"detail":"unknown project or public key"}`.

## Step 5. Instrument the API

The API is the same as in tiny-shop-otel. Stop it with Ctrl+C in its terminal tab (still in
`backend/`), then:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/resources @opentelemetry/semantic-conventions
```

| Package | What it does here |
|---|---|
| `@opentelemetry/api` | what `server.js` calls: `trace`, spans, status codes |
| `@opentelemetry/sdk-node` | starts tracing in Node: the provider, the context manager, the W3C `traceparent` propagator |
| `@opentelemetry/sdk-trace` | `BatchSpanProcessor`, which sends finished spans in batches |
| `@opentelemetry/exporter-trace-otlp-http` | sends them to the collector over OTLP/HTTP |
| `@opentelemetry/instrumentation-http`, `instrumentation-express` | a server span for every request, named after the Express route |
| `@opentelemetry/resources`, `semantic-conventions` | the resource: `service.name`, `service.version` |

Create `backend/instrumentation.js`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/backend/instrumentation.js -->
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

// The default propagator reads W3C `traceparent`, which the app's Sentry SDK sends next to
// `sentry-trace` (propagateTraceparent: true): every server span joins the app's trace.
const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "tiny-shop-mobile-api",
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

Replace `backend/server.js` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/backend/server.js -->
```js
// The API. HTTP server spans come from the auto-instrumentation; the spans below are manual.
const express = require("express");
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-mobile-api");
const app = express();
// A native app sends no CORS preflight, so no cors() here: `traceparent`, `baggage` and
// `sentry-trace` reach the handlers as they are.
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

const port = Number(process.env.PORT || 5001);
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

It prints `[otel] tracing to http://localhost:4318/v1/traces`. Collector on 14318 (step 4c)?
Stop it and start it with `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` instead.

Reload the app so it fetches the products again: press `r` in the Metro tab. In Grafana,
**Explore -> Tempo -> Search**, service `tiny-shop-mobile-api`: a `GET /api/products` trace with
its `db.select products` span. It is a trace of its own: the app sends no trace header yet.

## Step 6. Sentry in the app, pointed at the bridge

### 6a. Install the Sentry SDK

Stop Metro with Ctrl+C in the app's terminal tab (still in `app/`), then:

```bash
npm install --save-exact @sentry/react-native@8.32.0 @sentry/core@10.76.2
```

| Package | What it does here |
|---|---|
| `@sentry/react-native` | the Sentry SDK: the JS layer (errors, transactions, fetch spans, logs) and sentry-cocoa, which sends the envelopes and keeps the sessions |
| `@sentry/core` | only `startNewTrace` (step 6d), which `@sentry/react-native` does not re-export; the version `@sentry/react-native` 8.32.0 itself uses |

<details>
<summary>Which Sentry package and version? (click to open)</summary>

| Package | Status | Why or why not here |
|---|---|---|
| `@sentry/react-native` 8.x | current (8.32.0 on 2026-10-28) | the one this guide uses: fetch spans, `traceparent`, structured logs and app start all work on Expo 57 / React Native 0.86 |
| `@sentry/react-native` 7.11 | what `npx expo install @sentry/react-native` picks for Expo 57 | under React Native 0.86 it records no `fetch` spans (so no trace with the API), no app start, and transactions with wrong timestamps; hence `npm install` with the exact 8.x version |
| `sentry-expo` | deprecated | replaced by `@sentry/react-native`'s own Expo plugin |
| `@sentry/browser`, `@sentry/react` | current, for the web | `@sentry/react-native` already includes what it needs from them |

</details>

### 6b. The Sentry Expo plugin, with uploads off

Replace `app/app.json`. The new line is the `@sentry/react-native` plugin: it adds sentry-cocoa
to the iOS project. `disableAutoUpload: true` keeps the build from calling `sentry-cli`, which
would upload source maps and debug symbols to sentry.io.

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/app.json -->
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
      "bundleIdentifier": "dev.ouo.tinyshop.m1",
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

### 6c. Point Sentry at the bridge

Replace `app/src/config.ts`. The new constant is the DSN: Sentry's usual format, with the bridge
as its host. The public key and project id are the pair in the bridge's `projects` table
(step 4a).

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/config.ts -->
```ts
// Where the app sends its requests and its Sentry envelopes. Expo inlines EXPO_PUBLIC_* variables
// into the JS bundle when Metro builds it: set them in app/.env and restart Metro to change them.

// The Tiny Shop API (backend/). The simulator reaches your Mac on localhost.
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

// A Sentry DSN whose host is the ouo collector's Sentry bridge (stack/10-collector, port 4320).
// `publickey0000000000000000000000` and project `1` are the pair the bridge's `projects` table
// lists; they are public, local use only. Never put a sentry.io DSN here for this quickstart.
export const SENTRY_DSN =
  process.env.EXPO_PUBLIC_SENTRY_DSN ?? "http://publickey0000000000000000000000@localhost:4320/1";
```

Create `app/src/sentry.ts`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/sentry.ts -->
```ts
// @sentry/react-native, configured for the ouo Sentry bridge. Imported first by index.ts, so the
// SDK is running before the first screen renders.
import * as Sentry from "@sentry/react-native";
import { API_URL, SENTRY_DSN } from "./config";

// One `navigation` transaction per screen change (App.tsx registers the navigation container).
export const navigationIntegration = Sentry.reactNavigationIntegration();

Sentry.init({
  dsn: SENTRY_DSN,
  environment: "local",

  // Every transaction is sampled. Below 1, unsampled requests send `traceparent` with flag 00
  // and the API's OpenTelemetry sampler drops their spans.
  tracesSampleRate: 1,
  // Add W3C `traceparent` next to `sentry-trace` and `baggage`, only on requests to the API:
  // the OpenTelemetry SDK in the API reads `traceparent` and joins the app's trace.
  tracePropagationTargets: [API_URL],
  propagateTraceparent: true,

  // Sentry.logger.* sends structured logs; the bridge turns each into a log record in Loki.
  enableLogs: true,

  integrations: [navigationIntegration],
});

export { Sentry };
```

- `tracesSampleRate: 1`: every transaction is sent. Below 1, Sentry still sends `traceparent` for
  the requests it does not sample, with the flag `00`, and the API's OpenTelemetry sampler then
  drops their spans.
- `propagateTraceparent: true`: Sentry's own headers are `sentry-trace` and `baggage`; the API's
  OpenTelemetry SDK reads W3C `traceparent` only.
- `tracePropagationTargets: [API_URL]`: the trace headers go to your API and nowhere else. A bare
  `"localhost"` would also send them to the bridge.
- `enableLogs: true`: `Sentry.logger.*` calls are sent as Sentry logs, which the bridge writes to
  Loki.
- Sessions need nothing: Sentry tracks them by default and ends one after 30 seconds in the
  background.

Replace `app/index.ts`, so Sentry starts before anything else and wraps the app:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/index.ts -->
```ts
// Sentry first, so it is running before anything else loads; then the app, wrapped by Sentry
// (touch breadcrumbs, and the root component's errors).
import { Sentry } from "./src/sentry";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(Sentry.wrap(App));
```

### 6d. One trace per tap

Sentry records a `fetch` as an `http.client` span only while a span is active. The first
screen's request runs inside Sentry's first navigation transaction; a tap later on has none, and
Sentry would then send a `traceparent` whose parent span exists nowhere: in Tempo the API's span
hangs off a missing parent. So every tap that calls the API gets its own trace and transaction.

Replace `app/src/navigation.ts`. The new part is `navigationReady`, which the first request waits
for:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/navigation.ts -->
```ts
// The screens and their parameters, and a promise that resolves when navigation is ready.
import { createNavigationContainerRef } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Product } from "./api";

export type RootStackParamList = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, T>;

export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Resolved by App.tsx once Sentry's first navigation transaction has started. The product list
// loads on mount, a few milliseconds earlier: api.ts waits for this so that request is part of
// the first screen's transaction.
let markReady: () => void = () => {};
export const navigationReady = new Promise<void>((resolve) => {
  markReady = resolve;
});
export const setNavigationReady = (): void => markReady();
```

Replace `app/src/api.ts`. `getProducts` waits for `navigationReady`, and `tap()` starts a new
trace with one `ui.action` transaction around the call:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/api.ts -->
```ts
// The Tiny Shop API, with plain fetch. Sentry's fetch instrumentation turns each call into an
// `http.client` span and adds `sentry-trace`, `baggage` and `traceparent` to it.
import { startNewTrace } from "@sentry/core";
import { API_URL } from "./config";
import { navigationReady } from "./navigation";
import { Sentry } from "./sentry";

export interface Product {
  id: number;
  name: string;
  price: number;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`${path} answered ${status}`);
    this.name = "HttpError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, init);
  if (!res.ok) throw new HttpError(res.status, path);
  return (await res.json()) as T;
}

// The first screen loads its products on mount, inside Sentry's first navigation transaction.
export async function getProducts(): Promise<Product[]> {
  await navigationReady;
  return request<Product[]>("/api/products");
}

export const checkout = (items: number[]) =>
  request<{ ok: boolean; orderId: number }>("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });

export const callBrokenApi = () => request<unknown>("/api/fail");

// A tap that calls the API: its own trace (startNewTrace) and its own transaction. Without it, a
// request after the screen's transaction ended has no active span, and Sentry sends a
// `traceparent` whose parent span no span has: the API's spans would hang off a missing parent.
export const tap = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
  startNewTrace(() => Sentry.startSpan({ name, op: "ui.action", forceTransaction: true }, fn));
```

Replace `app/App.tsx`. `onReady` hands the navigation container to Sentry, which then starts a
`navigation` transaction for every screen change:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/App.tsx -->
```tsx
// Navigation: Products, Product and Cart in a native stack, around the shared cart.
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
          // Sentry starts a `navigation` transaction for every screen change from here on.
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

### 6e. Log what happens

Each screen now logs what the user did, in a line that reads on its own in Loki, and the Debug
buttons report to Sentry.

Replace `app/src/screens/ProductsScreen.tsx`. **Call broken API** runs inside `tap()`, so its
500 is an `http.client` span with status 500, which the bridge turns into a failed request;
**Handled error** calls `Sentry.captureException`; **Throw error** is left to Sentry's global
handler:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/screens/ProductsScreen.tsx -->
```tsx
// Products: the list from GET /api/products, and the Debug section.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { callBrokenApi, getProducts, tap, type Product } from "../api";
import type { ScreenProps } from "../navigation";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function ProductsScreen({ navigation }: ScreenProps<"Products">) {
  const [products, setProducts] = useState<Product[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getProducts()
      .then((list) => {
        setProducts(list);
        Sentry.logger.info(Sentry.logger.fmt`loaded ${list.length} products`);
      })
      .catch((e: Error) => setMessage(e.message));
  }, []);

  // A failed request is not an exception here: the bridge sees the http.client span with status
  // 500 and marks the session errored with a failed request.
  const brokenApi = () =>
    tap("tap Call broken API", async () => {
      try {
        await callBrokenApi();
      } catch (e) {
        Sentry.logger.warn(Sentry.logger.fmt`GET /api/fail failed: ${(e as Error).message}`);
        setMessage((e as Error).message);
      }
    });

  // Caught by the app and reported: the session becomes errored.
  const handledError = () => {
    try {
      throw new Error("Coupon code TINY10 is not valid");
    } catch (e) {
      Sentry.captureException(e);
      Sentry.logger.error(Sentry.logger.fmt`coupon check failed: ${(e as Error).message}`);
      setMessage(`Reported: ${(e as Error).message}`);
    }
  };

  // Not caught: React Native's global handler gets it, Sentry reports it as fatal and the
  // session ends crashed.
  const throwError = () => {
    throw new Error("Button exploded");
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {products.map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          accessibilityLabel={p.name}
          style={styles.row}
          onPress={() => navigation.navigate("Product", { product: p })}
        >
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.muted}>${p.price}</Text>
        </Pressable>
      ))}
      <Button title="Cart" onPress={() => navigation.navigate("Cart")} />

      <Text style={styles.section}>Debug</Text>
      <Button title="Call broken API" onPress={brokenApi} />
      <Button title="Handled error" onPress={handledError} />
      <Button title="Throw error" onPress={throwError} />
      <Text style={styles.muted}>{message}</Text>
    </ScrollView>
  );
}
```

Replace `app/src/screens/ProductScreen.tsx`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/screens/ProductScreen.tsx -->
```tsx
// Product: one product and "Add to cart".
import { Text, View } from "react-native";
import { useCart } from "../cart";
import type { ScreenProps } from "../navigation";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function ProductScreen({ route, navigation }: ScreenProps<"Product">) {
  const { product } = route.params;
  const cart = useCart();

  const add = () => {
    cart.add(product);
    Sentry.logger.info(Sentry.logger.fmt`added ${product.name} to the cart (${cart.items.length + 1} items)`);
    navigation.goBack();
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button title="Add to cart" onPress={add} />
    </View>
  );
}
```

Replace `app/src/screens/CartScreen.tsx`. **Checkout** is the tap whose trace reaches the API's
manual spans:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile/result/app/src/screens/CartScreen.tsx -->
```tsx
// Cart: the items and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { checkout, tap } from "../api";
import { useCart } from "../cart";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [message, setMessage] = useState("");
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  // One trace: this transaction, its http.client span, the API's POST /api/checkout span and
  // the API's manual spans checkout, validate cart and charge card.
  const onCheckout = () =>
    tap("tap Checkout", async () => {
      const order = await checkout(cart.items.map((p) => p.id));
      Sentry.logger.info(Sentry.logger.fmt`order ${order.orderId} placed: ${cart.items.length} items, $${total}`);
      setMessage(`Order #${order.orderId} placed`);
      cart.clear();
    });

  return (
    <View style={styles.screen}>
      {cart.items.map((p, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.muted}>${p.price}</Text>
        </View>
      ))}
      <Text style={styles.text}>Total: ${total}</Text>
      <Button title="Checkout" onPress={onCheckout} disabled={!cart.items.length} />
      <Text style={styles.muted}>{message}</Text>
    </View>
  );
}
```

### 6f. Rebuild

Sentry adds native code, so the app is built again (about 3 minutes; the pods are cached).
From `app/`:

```bash
npx expo run:ios
```

Expo prints `[@sentry/react-native/expo] Missing config for organization, project`: those
name the sentry.io project for uploads, which this app turns off, so leave them unset.

Bridge on 14320 (step 4c)? Create `app/.env` with
`EXPO_PUBLIC_SENTRY_DSN=http://publickey0000000000000000000000@localhost:14320/1` first.

## Step 7. See the full picture

Three short sessions, one per state. Sentry ends a session when the app has been in the
background for 30 seconds, and sends it when the app comes back.

1. **A healthy session.** In the simulator, tap **Coffee**, **Add to cart**, **Tea**, **Add to
   cart**, **Cart**, **Checkout**, then the back button. Press Cmd+Shift+H to send the app to the
   background, wait 30 seconds, and open **Tiny Shop** again from the home screen.
2. **An errored session.** On Products, under **Debug**, tap **Call broken API** and **Handled
   error**. Background the app again for 30 seconds and open it again.
3. **A crashed session.** Tap **Throw error**. The red screen is the JS fatal; Sentry has already
   sent it and ended the session as crashed. Tap **Dismiss**.

Wait up to a minute.

**More apps -> ouo11y RUM -> Sessions**:

the three `tiny-shop-mobile` sessions, newest first: `crashed` (1 crash), `errored` (1 error,
1 failed request) and `healthy`, each with its duration and traces, and the device's id as the
user. Above them, an `active` one: in a Debug build the app keeps running after the red screen,
and Sentry starts a new session. Open the crashed one:

- the header: `crashed`, `ended · crash`, the device (`iPhone19,2`, iOS 27), the release
  (`1.0.0 (build 1)`), the environment `local`, and the vitals Sentry measures without being
  asked (cold start, slow and frozen frames, JS stalls; M3 is about those);
- the timeline, in order: session start, the `Products` screen, the app start, `Request 200
  GET http://localhost:5001/api/products`, your logs, every tap by its label (`Coffee`,
  `Add to cart`, `Checkout`), every screen, and at the end `Fatal error Error: Button exploded`
  with **Show stack trace**, which points at `ProductsScreen.tsx` line 48;
- **Traces**: one per tap that called the API (`tap Checkout`, `tap Call broken API`) and one
  per screen, each with **Open in Explore**;
- **Logs**: the `Sentry.logger` lines of this session.

In the errored session, the timeline has `Failed request 500 GET http://localhost:5001/api/fail`
and `Error: Coupon code TINY10 is not valid` with its stack.

**Explore -> Tempo -> TraceQL**:

```
{ resource.service.name = "tiny-shop-mobile-api" && name = "charge card" }
```

Open the newest trace. One trace id, from the tap to the API's manual spans:

```
tap Checkout                  tiny-shop-mobile       ui.action transaction (tap() in api.ts)
└─ POST                       tiny-shop-mobile       http.client: POST http://localhost:5001/api/checkout
   └─ POST /api/checkout      tiny-shop-mobile-api   HTTP server span
      ├─ middleware - jsonParser
      └─ request handler - /api/checkout
         └─ checkout
            ├─ validate cart
            └─ charge card
```

No span points at a missing parent. The `tap Call broken API` trace has the same shape, with the
API's `GET /api/fail` span in error.

**Explore -> Loki**:

```
{service_name="tiny-shop-mobile"}
```

One line per thing that happened, newest first. Your `Sentry.logger` lines read as you wrote them
(`event_name` `log`):

```
order 31737 placed: 2 items, $9
added Cake to the cart (2 items)
added Tea to the cart (1 items)
loaded 3 products
GET /api/fail failed: /api/fail answered 500
coupon check failed: Coupon code TINY10 is not valid
```

Next to them, the records the bridge writes for ouo11y RUM: `session.start` and `session.end`,
`navigation`, `ui.tap` (`Checkout`), `http.request` (`POST http://localhost:5001/api/checkout`),
`http.request.failed`, `exception` (`Error: Button exploded`, with `exception.stacktrace` in its
metadata), and Sentry's mobile vitals (`ouo.app.start`, `app.jank`, `ouo.stall`). To see only yours:
`{service_name="tiny-shop-mobile", event_name="log"}`. `console` lines are `console.*` output, which
`enableLogs` also sends.

## Step 8. What is next

What you built covers sessions, errors, traces and logs. The next mobile quickstarts add, on the
same app:

| Quickstart | Adds |
|---|---|
| [M2, tiny-shop-mobile-replay](../index.md) | Sentry's mobile Session Replay (`replaysSessionSampleRate`), through the same bridge: a video replay of the session in ouo11y RUM |
| [M3, tiny-shop-mobile-signals](../index.md) | app start, time to initial display, slow and frozen frames, release and environment, a native crash reported on the next launch (Release build) |
| [M4, tiny-shop-mobile-sentry](../index.md) | `upstream` set to a real Sentry: every envelope also goes to your Sentry project, and the same session shows in both |
| [M5, tiny-shop-mobile-ouo](../index.md) | no Sentry: the ouo React Native SDK, `@ouo11y/react-native`, straight to the collector |

## Step 9. Clean up

Stop the API and Metro with Ctrl+C. Stop the stack, keeping its data (in the stack's tab, from
`stack/`):

```bash
docker compose down
```

or delete its data too:

```bash
docker compose down -v
```

The app stays on the simulator until you remove it:

```bash
xcrun simctl uninstall booted dev.ouo.tinyshop.m1
```

## When something does not work

| You see | Cause and fix |
|---|---|
| `Bind for 0.0.0.0:4320 failed: port is already allocated` | another stack has the port: step 4c, move this one with `stack/.env` |
| `rum-api` or `otel-collector` keeps restarting after a pull | a newer `latest` that wants a different config: `docker compose logs rum-api` (or `otel-collector`) names the key; pin the tested version named in its compose file |
| `denied` when pulling `ghcr.io/ouo11y/...` | not logged in to ghcr.io, or no read access yet: step 4b |
| The app stops right after launch, `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` in the Xcode log | the UIScene plugin is missing from `app.json` (step 3a); run `npx expo run:ios` again after adding it |
| The products do not load (`Network request failed`) | the API is not running, or not on the port in `EXPO_PUBLIC_API_URL` |
| The build fails in "Upload Debug Symbols to Sentry" or asks for `SENTRY_AUTH_TOKEN` | `disableAutoUpload: true` is missing from the Sentry plugin in `app.json` (step 6b); run `npx expo prebuild --clean`, then `npx expo run:ios` |
| Nothing from the app in Grafana | the DSN in the bundle is wrong: check `EXPO_PUBLIC_SENTRY_DSN` and its port, stop Metro and run `npx expo run:ios` again (Metro reads `.env` when it starts). the bridge answers `403 unknown project or public key` when the key or project id is not in its `projects` table (step 4d shows that answer) |
| The API's spans are a trace of their own | `propagateTraceparent` or `tracePropagationTargets` is missing or does not match the API URL, or `tracesSampleRate` is below 1 |
| The API's span points at a parent that is not in the trace | a request outside any transaction: wrap the tap in `tap()` (step 6d) |
| No `Sentry.logger` lines in Loki | `enableLogs: true` is missing; Sentry also flushes logs about 5 s after the last one |
| A session stays `active` | Sentry ends a session after 30 seconds in the background and sends the end when the app comes back: Cmd+Shift+H, wait 30 seconds, open the app again |
| The session's cold start reads about 25 s | a Debug build downloads its JS from Metro at launch; a Release build measures the real start (M3) |
| Nothing in Tempo yet | wait up to a minute: new traces reach search later than trace-by-id |
