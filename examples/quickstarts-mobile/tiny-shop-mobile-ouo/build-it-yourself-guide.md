# Build Tiny Shop Mobile with the ouo React Native SDK, no Sentry

This guide is for teams that want ouo on a React Native app without Sentry: the app sends
everything with `@ouo11y/react-native`, straight to the ouo collector. You end with sessions
(healthy, errored, crashed), one trace from a tap to the API's manual spans with the session id on
every span, a handled error, a JS crash and a native crash, app start and screen timings, log lines
in Loki, taps on the session's timeline, and a replay with masking.

You build, one step at a time, with no scripts:

1. a plain Express API and a plain Expo app (three screens), with no telemetry at all;
2. the ouo stack (the ouo collector, Tempo, Loki, Mimir, rum-api, Grafana), one folder per service;
3. the backend traced with the OpenTelemetry Node SDK (the same as in the web
   [Tiny Shop](../../quickstarts/tiny-shop/build-it-yourself-guide.md));
4. the app instrumented with `@ouo11y/react-native`, first in a Debug build, then in a Release
   build for the native crash and the replay.

At the end your files are the same as [`result/`](result): compare with them when you are stuck.
Plan on about 60 minutes, a third of it waiting for the first iOS builds. When you are done,
[sdk-state.md](sdk-state.md) says what this SDK gives you next to the Sentry path, and what it does not yet.

```
tiny-shop-mobile-ouo/
├── stack/      the ouo stack, one folder per service
├── backend/    Express API, OpenTelemetry traces
└── app/        Expo app (React Native), @ouo11y/react-native
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`tiny-shop-mobile-ouo/`, wherever you create it, and each command says which of its folders it runs
in. When a step says "replace the file", select everything in it and paste the new content over it.

## What ouo needs from a mobile app

The SDK does all of this for you; this table is what it sends, so you know what to look for.

| What | How | Where you see it |
|---|---|---|
| **Where** | OTLP/HTTP to the collector (`:4318/v1/traces`, `:4318/v1/logs`) and replay frames to `:4319/v1/replay/chunks`, every request with `Authorization: Basic base64("<project id>:<project token>")` | step 6 |
| **Who** | resource attributes `service.name`, `service.version`, `deployment.environment.name`, `ouo.platform = "mobile"`, `os.*`, `device.*` | step 7 |
| **Which session** | `session.id` and `user.id` on every span and log record, and in the `baggage` header of requests to your API | step 7b |
| **What happened** | OTLP log records named `session.start`, `session.end`, `exception`, `http.request.failed`, `navigation`, `ui.tap`, `app.lifecycle`, `http.request`, the vitals `ouo.app.start`, `ouo.screen.display`, `app.jank`, `ouo.stall`, and `log` for `rum.log.*` | step 7 |
| **Native crash** | written to disk at crash time by a signal handler, sent as a fatal `exception` on the next launch | step 8 |
| **Replay** | screenshots of the app (JPEG, masked on the device) in gzip chunks | step 8 |

A session with a fatal `exception` (`ouo.exception.fatal = true`) is `crashed`; one with a
non-fatal exception or an `http.request.failed` is `errored`; otherwise it is `healthy`.

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

Docker Desktop must be running. This prints the server details, not "Cannot connect":

```bash
docker info
```

Xcode (the full app, not only the command line tools) with an iOS Simulator runtime, and CocoaPods:

```bash
xcodebuild -version
```

```bash
xcrun simctl list runtimes
```

```bash
pod --version
```

This guide was tested with Xcode 27.0, the iOS 27.0 simulator (iPhone 18 Pro) and CocoaPods 1.17.
No phone and no Apple developer account are needed: everything runs on the simulator.

VS Code's `code` command. If it is not found, open VS Code, press Cmd+Shift+P and run
**Shell Command: Install 'code' command in PATH**.

```bash
code --version
```

## Step 1. Create the folders and open VS Code

From the folder where you keep your projects:

```bash
mkdir -p tiny-shop-mobile-ouo/backend tiny-shop-mobile-ouo/stack
```

```bash
cd tiny-shop-mobile-ouo
```

```bash
code .
```

In VS Code, open a terminal with Ctrl+\`. You will use three terminal tabs (the `+` button):
one for the backend, one for the app, one for the stack. Each new tab opens in
`tiny-shop-mobile-ouo/`.

## Step 2. A simple API, no telemetry yet

In the first terminal tab, from `tiny-shop-mobile-ouo/`:

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

A native app is not a web page: it sends no CORS preflight, so the API needs no `cors()`.

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

### 3a. Create it

In the second terminal tab, from `tiny-shop-mobile-ouo/` (this creates `app/`). The `@sdk-57`
picks Expo SDK 57, the version this guide was tested with; without it you get the newest one:

```bash
npx create-expo-app@latest app --template blank-typescript@sdk-57
```

```bash
cd app
```

The template also writes `AGENTS.md` and `.claude/` (hints for coding agents) and starts a git
repository; `result/` leaves them out, and nothing here uses them.

Install the navigation packages. `npx expo install` picks the versions that match Expo 57, so
use it instead of `npm install` for anything with native code:

```bash
npx expo install @react-navigation/native @react-navigation/native-stack react-native-screens react-native-safe-area-context
```

### 3b. iOS 27 needs the scene life cycle

On iOS 27 an app without a scene delegate is stopped at launch, and Expo 57's template does not
add one yet. One Expo config plugin adds it when the iOS project is generated. Create
`app/plugins/withUIScene.js`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/plugins/withUIScene.js -->
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

Replace `app/app.json`. Next to the plugin, it names the app and gives it a bundle id, which
`expo run:ios` needs:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/app.json -->
```json
{
  "expo": {
    "name": "Tiny Shop",
    "slug": "tiny-shop-mobile-ouo",
    "version": "1.0.0",
    "orientation": "portrait",
    "icon": "./assets/icon.png",
    "userInterfaceStyle": "light",
    "ios": {
      "supportsTablet": true,
      "bundleIdentifier": "dev.ouo.tinyshop.m5"
    },
    "android": {
      "package": "dev.ouo.tinyshop.m5",
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

Three screens: **Products** (the list from the API), **Product** (one product, "Add to cart") and
**Cart** ("Checkout"). Each file is short; create them in `app/src/`.

`app/src/routes.ts`, the screens and what each receives:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/src/routes.ts -->
```ts
import type { Product } from "./api";

// The three screens and what each receives.
export type Routes = {
  Products: undefined;
  Product: { product: Product };
  Cart: undefined;
};
```

`app/src/ui.tsx`, a button and the styles:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/src/ui.tsx -->
```tsx
// A few shared styles and a button. `testID` names the button for tests and for ouo's tap
// events (ouo never reads the button's text).
import { Pressable, StyleSheet, Text } from "react-native";

export function Button({ title, testID, onPress, danger }: { title: string; testID: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable testID={testID} onPress={onPress} style={[styles.button, danger && styles.danger]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fff" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 14, borderBottomWidth: 1, borderColor: "#eee" },
  title: { fontSize: 22, fontWeight: "600" },
  text: { fontSize: 17 },
  dim: { fontSize: 15, color: "#666" },
  section: { marginTop: 24, fontSize: 13, color: "#666", textTransform: "uppercase" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 17 },
  button: { backgroundColor: "#2563eb", padding: 14, borderRadius: 8, alignItems: "center" },
  danger: { backgroundColor: "#b91c1c" },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
```

`app/src/cart.tsx`, the cart in memory:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/src/cart.tsx -->
```tsx
// The cart, kept in memory and shared by the three screens.
import { createContext, useContext, useState, type ReactNode } from "react";
import type { CartLine, Product } from "./api";

type Cart = { lines: CartLine[]; add: (p: Product) => void; clear: () => void };

const CartContext = createContext<Cart | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const add = (p: Product) =>
    setLines((ls) =>
      ls.some((l) => l.id === p.id) ? ls.map((l) => (l.id === p.id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { ...p, qty: 1 }]
    );
  return <CartContext.Provider value={{ lines, add, clear: () => setLines([]) }}>{children}</CartContext.Provider>;
}

export function useCart(): Cart {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart outside CartProvider");
  return cart;
}
```

`app/src/api.ts`, the calls to the API (step 6 replaces it):

```ts
export type Product = { id: number; name: string; price: number };
export type CartLine = Product & { qty: number };

export const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} ${res.status}: ${body.error ?? res.statusText}`);
  return body as T;
}

export const getProducts = () => call<Product[]>("/api/products");

export const checkout = (lines: CartLine[]) =>
  call<{ orderId: number }>("/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: lines.map((l) => ({ id: l.id, qty: l.qty })) }),
  });
```

From the iOS Simulator, `localhost` is your Mac. `EXPO_PUBLIC_*` variables are read when the
JavaScript bundle is built, so an API on another port is `EXPO_PUBLIC_API_URL=http://localhost:5002`
in front of the `npx expo` command.

`app/src/screens/ProductsScreen.tsx` (step 6 adds a Debug section):

```tsx
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { getProducts, type Product } from "../api";
import type { Routes } from "../routes";
import { Button, styles } from "../ui";

export function ProductsScreen({ navigation }: NativeStackScreenProps<Routes, "Products">) {
  const [products, setProducts] = useState<Product[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getProducts().then(setProducts, (e: Error) => setMessage(e.message));
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {products.map((p) => (
        <Pressable key={p.id} testID={`product-${p.id}`} style={styles.row} onPress={() => navigation.navigate("Product", { product: p })}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.dim}>${p.price}</Text>
        </Pressable>
      ))}
      <Button title="Cart" testID="open-cart" onPress={() => navigation.navigate("Cart")} />
      {message ? <Text style={styles.dim}>{message}</Text> : null}
    </ScrollView>
  );
}
```

`app/src/screens/ProductScreen.tsx`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/src/screens/ProductScreen.tsx -->
```tsx
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Text, View } from "react-native";
import { useCart } from "../cart";
import type { Routes } from "../routes";
import { Button, styles } from "../ui";

export function ProductScreen({ navigation, route }: NativeStackScreenProps<Routes, "Product">) {
  const { product } = route.params;
  const cart = useCart();
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{product.name}</Text>
      <Text style={styles.text}>${product.price}</Text>
      <Button
        title="Add to cart"
        testID="add-to-cart"
        onPress={() => {
          cart.add(product);
          navigation.navigate("Cart");
        }}
      />
    </View>
  );
}
```

`app/src/screens/CartScreen.tsx`. The promo code field is there for the replay (step 8): what a
user types must never show in it.

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/src/screens/CartScreen.tsx -->
```tsx
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { checkout } from "../api";
import { useCart } from "../cart";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [promo, setPromo] = useState("");
  const [message, setMessage] = useState("");
  const total = cart.lines.reduce((sum, l) => sum + l.price * l.qty, 0);

  const onCheckout = () =>
    checkout(cart.lines).then(
      (order) => {
        cart.clear();
        setMessage(`Order ${order.orderId} placed`);
      },
      (e: Error) => setMessage(e.message)
    );

  return (
    <View style={styles.screen}>
      {cart.lines.map((l) => (
        <View key={l.id} style={styles.row}>
          <Text style={styles.text}>
            {l.qty} × {l.name}
          </Text>
          <Text style={styles.dim}>${l.price * l.qty}</Text>
        </View>
      ))}
      <Text style={styles.title}>Total ${total}</Text>
      {/* What a user types here never reaches a replay: inputs stay masked. */}
      <TextInput testID="promo-code" style={styles.input} placeholder="Promo code" value={promo} onChangeText={setPromo} />
      <Button title="Checkout" testID="checkout" onPress={onCheckout} />
      {message ? <Text style={styles.dim}>{message}</Text> : null}
    </View>
  );
}
```

Replace `app/App.tsx` with the navigation (step 6 wraps it):

```tsx
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import type { Routes } from "./src/routes";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

const Stack = createNativeStackNavigator<Routes>();

export default function App() {
  return (
    <>
      <CartProvider>
        <NavigationContainer>
          <Stack.Navigator>
            <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
            <Stack.Screen name="Product" component={ProductScreen} options={({ route }) => ({ title: route.params.product.name })} />
            <Stack.Screen name="Cart" component={CartScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </CartProvider>
      <StatusBar style="auto" />
    </>
  );
}
```

### 3d. Run it on the simulator

From `app/`. The first run generates `ios/`, installs the pods and builds the app (10 to 15
minutes), then installs it on a simulator, opens it and starts Metro, the JavaScript server, on
port 8081:

```bash
npx expo run:ios
```

Pick an iPhone when it asks. The app shows Coffee, Tea and Cake. Tap one, **Add to cart**, then
**Checkout**: "Order … placed". Leave Metro running; press `r` in its terminal to reload the
JavaScript after an edit. `expo run:ios` also rewrote the `ios` and `android` scripts in
`package.json`: that is expected.

## Step 4. The stack, one service at a time

### 4a. Create the files

Six services, one folder each. Each folder holds that service's compose file and its config, and
each file starts with what the service is for, who sends it data and its ports. Open a block, copy
all of it, and paste it into the file named in its title (VS Code creates the folders when you
save a new file as `stack/10-collector/compose.yaml`).

`compose.yaml` only lists the service folders:

<details>
<summary><code>stack/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/compose.yaml -->
```yaml
# The ouo stack for tiny-shop-mobile-ouo: one folder per service, each with its compose file and
# its config. This file only lists them. Start everything from this folder: `docker compose up -d`.
# Grafana http://localhost:3000 (admin / testing567), OTLP http://localhost:4318, replay :4319.
# Ports taken? Export OUO_GRAFANA_PORT, OUO_OTLP_HTTP_PORT, OUO_REPLAY_PORT before `up`.
include:
  - 10-collector/compose.yaml   # ingest: the only thing the app and the API talk to
  - 20-tempo/compose.yaml       # traces
  - 30-loki/compose.yaml        # logs and the app's events
  - 40-mimir/compose.yaml       # metrics (none from this shop yet; the collector accepts /v1/metrics)
  - 50-rum-api/compose.yaml     # sessions and replay for the Grafana plugin
  - 60-grafana/compose.yaml     # the UI: datasources and the ouo11y RUM app
```

</details>

**The ouo collector is the only thing the app and the API talk to.** It checks the project
credential on every request and sends each signal to its store. Unlike the web quickstarts, it
needs no CORS settings: a native app has no web origin.

<details>
<summary><code>stack/10-collector/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/10-collector/compose.yaml -->
```yaml
# ouo-collector: the only ingest. The app and the Node API send OTLP here; it checks the
# project credential and forwards traces to Tempo, logs to Loki, metrics to Mimir and replay
# chunks to rum-api. Ports: 4318 OTLP/HTTP, 4319 replay (both public), 13133 health (loopback).
services:
  otel-collector:
    # `latest` follows each release. Tested with 0.4.0: pin `collector:0.4.0` or
    # `collector@sha256:ca0d001dc58153671fc501cbe280a69f86dc3e681a1b4621e827dedadb7727f2` to stay on it.
    image: ghcr.io/ouo11y/collector:latest
    command: ["--config=/etc/otelcol/config.yaml"]
    ports:
      - "${OUO_OTLP_HTTP_PORT:-4318}:4318"
      - "${OUO_REPLAY_PORT:-4319}:4319"
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/10-collector/config.yaml -->
```yaml
# ouo-collector pipelines, a trimmed copy of the full stack's config (no Sentry bridge, no
# rate limits). Receivers: OTLP/HTTP on 4318 and replay chunks on 4319, both behind the
# project credential in projects.htpasswd. Exporters: Tempo, Loki, Mimir and rum-api.

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
        # No cors block: a native app has no origin and sends no preflight.
  ouoreplay:
    endpoint: 0.0.0.0:4319
    include_metadata: true
    max_request_body_size: 8388608
    auth:
      authenticator: basicauth/server

processors:
  # Stamp the authenticated project id on every resource (and drop any value the client sent).
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
  ouoreplay:
    endpoint: http://rum-api:8080
    ingest_token: ${env:OUO_INGEST_TOKEN}

service:
  extensions: [health_check, basicauth/server]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [resource/project, batch]
      exporters: [otlp_grpc/tempo]
    logs:
      receivers: [otlp]
      processors: [resource/project, transform/events, batch]
      exporters: [otlp_http/loki]
    metrics:
      receivers: [otlp]
      processors: [resource/project, batch]
      exporters: [otlp_http/mimir]
    logs/replay:
      receivers: [ouoreplay]
      exporters: [ouoreplay]
```

</details>

<details>
<summary><code>stack/10-collector/projects.htpasswd</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/10-collector/projects.htpasswd -->
```
# Projects allowed to send data: one line per project, project id and SHA hash of its token.
# Read by the collector's basicauth extension. The `demo` token (pt_dev_demo_0000000000000000)
# is public: local use only. Make a line with htpasswd -nbs PROJECT TOKEN. No colon in comments.
demo:{SHA}IUpHBAUPHvXoJmvv4inmF4cN96I=
```

</details>

**Tempo stores the traces**, the app's spans and the API's in the same trace.

<details>
<summary><code>stack/20-tempo/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/20-tempo/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/20-tempo/config.yaml -->
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

**Loki stores the app's events and log lines**; rum-api builds the sessions from them.

<details>
<summary><code>stack/30-loki/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/30-loki/compose.yaml -->
```yaml
# Loki: stores logs. The collector sends it the app's events and logs over OTLP
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/30-loki/config.yaml -->
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

**Mimir stores metrics.** Nothing in this shop sends metrics yet; the collector is ready for them.

<details>
<summary><code>stack/40-mimir/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/40-mimir/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/40-mimir/config.yaml -->
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

**rum-api turns the events into sessions** (healthy, errored, crashed) and stores the replays.

<details>
<summary><code>stack/50-rum-api/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/50-rum-api/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/50-rum-api/config.yaml -->
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

**Grafana is the UI**, with the ouo11y RUM app.

<details>
<summary><code>stack/60-grafana/compose.yaml</code> (click to open)</summary>

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/60-grafana/compose.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/60-grafana/provisioning/datasources/datasources.yaml -->
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

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/stack/60-grafana/provisioning/plugins/ouo11y-rum-app.yaml -->
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

**Image versions.** The ouo images use `latest`, which follows each release. The comments in the
compose files say which version this guide was tested with and its digest: pin
`ghcr.io/ouo11y/rum-api:0.5.0`, or the `@sha256:...` digest, to keep a stack on one version. The
configs in this guide are written for the tested versions; a much newer rum-api may refuse a
config key it no longer knows, and the error in `docker compose logs rum-api` names it.

### 4b. Log in to ghcr.io

The ouo images are private for now. You need read access to the `ouo11y` packages and a
**classic** GitHub token with only the `read:packages` scope. Put the token in your shell
(`export GHCR_TOKEN=...`), never in a file, then:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <your-github-user> --password-stdin
```

### 4c. Check the ports

The stack publishes 3000 (Grafana) and the collector's 4318 (OTLP) and 4319 (replay) to your
network, and 3100, 3200, 9009 and 13133 on loopback only. This prints nothing when they are all free:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3000|3100|3200|4318|4319|9009|13133) '
```

If something is listed, do not stop it: move this stack instead. From `stack/`:

```bash
code .env
```

and set the ports that are taken, for example:

```
OUO_GRAFANA_PORT=13000
OUO_OTLP_HTTP_PORT=14318
OUO_REPLAY_PORT=14319
```

Compose reads `.env` on its own. The others are `OUO_LOKI_PORT`, `OUO_TEMPO_PORT`,
`OUO_MIMIR_PORT` and `OUO_COLLECTOR_HEALTH_PORT` (the `${OUO_..._PORT:-...}` lines in the
compose files). Remember the new collector ports: steps 5 and 6 tell you where they go.

### 4d. Start it

In the third terminal tab, from `tiny-shop-mobile-ouo/`:

```bash
cd stack
```

```bash
docker compose up -d
```

```bash
docker compose ps
```

Six services are `Up`. Open http://localhost:3000 and log in with **admin / testing567** (the
development password of every ouo quickstart; it is public, so keep this stack on your machine).
**More apps -> ouo11y RUM** is there and still empty.

## Step 5. Instrument the backend

The backend is the same as in the web Tiny Shop: the OpenTelemetry Node SDK has never needed an
ouo package. Stop the API with Ctrl+C in its terminal tab (still in `backend/`), then:

```bash
npm install @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/exporter-trace-otlp-http @opentelemetry/instrumentation-http @opentelemetry/instrumentation-express @opentelemetry/baggage-span-processor @opentelemetry/resources @opentelemetry/semantic-conventions
```

| Package | What it does here |
|---|---|
| `@opentelemetry/api` | what `server.js` calls to make its own spans (`trace.getTracer`) |
| `@opentelemetry/sdk-node` | starts tracing in Node: providers, the W3C `traceparent` and `baggage` propagators |
| `@opentelemetry/sdk-trace` | `BatchSpanProcessor`, which sends spans in batches |
| `@opentelemetry/exporter-trace-otlp-http` | sends them to the collector over OTLP/HTTP |
| `@opentelemetry/instrumentation-http`, `instrumentation-express` | a server span for every request, named after the Express route |
| `@opentelemetry/baggage-span-processor` | copies the app's `baggage` (`session.id`, `user.id`) onto every backend span |
| `@opentelemetry/resources`, `semantic-conventions` | the resource: `service.name` and `service.version` |

Create `backend/instrumentation.js`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/backend/instrumentation.js -->
```js
// OpenTelemetry SDK init. Loaded before the app with `node --require ./instrumentation.js`
// so the http and express instrumentations can patch those modules before server.js loads them.
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
const { BaggageSpanProcessor, ALLOW_ALL_BAGGAGE_KEYS } = require("@opentelemetry/baggage-span-processor");
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
    [ATTR_SERVICE_NAME]: "tiny-shop-mobile-api",
    [ATTR_SERVICE_VERSION]: "1.0.0",
    "deployment.environment.name": "local",
  }),
  spanProcessors: [
    // The app sends `baggage: session.id=...,user.id=...,ouo.platform=mobile`; copy it onto every span so
    // backend spans can be searched by the RUM session.
    new BaggageSpanProcessor(ALLOW_ALL_BAGGAGE_KEYS),
    // OTel JS 3.0: options object, `{ exporter }` (2.x took the exporter itself).
    new BatchSpanProcessor({ exporter }),
  ],
  instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
});

sdk.start();
console.log(`[otel] tracing to ${endpoint}/v1/traces`);

const shutdown = () => sdk.shutdown().finally(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

Replace `backend/server.js` with:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/backend/server.js -->
```js
// The API. HTTP server spans come from the auto-instrumentation; the spans below are manual.
const express = require("express");
const { trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("tiny-shop-mobile-api");
const app = express();
// A native app sends no CORS preflight, so no cors() here: `traceparent` and `baggage` reach
// the handlers as they are.
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

It prints `[otel] tracing to http://localhost:4318/v1/traces`. Collector on 14318 (step 4c)?
Stop it and start it with `OUO_OTLP_ENDPOINT=http://localhost:14318 npm start` instead. The API on
another port: `API_PORT=5002 npm start`.

## Step 6. Instrument the app with `@ouo11y/react-native`

### 6a. Install the SDK

Stop Metro with Ctrl+C in the app's terminal tab (still in `app/`), then:

```bash
npx expo install @ouo11y/react-native @react-native-async-storage/async-storage expo-constants expo-device
```

| Package | What it does here |
|---|---|
| `@ouo11y/react-native` | the ouo SDK: sessions, errors, JS and native crashes, a span for every request with `traceparent` and `baggage`, `rum.startSpan` / `rum.withSpan`, `rum.log.*`, taps, app lifecycle, vitals, replay. OpenTelemetry is bundled inside it. Its iOS half (an Expo module) is what records crashes, app start, frames and replay |
| `@react-native-async-storage/async-storage` | where the SDK keeps the session between launches, so a relaunch knows how the last session ended |
| `expo-constants` | reads the app version from `app.json` for `service.version` |
| `expo-device` | the device model; the SDK reads it on its own when the package is installed |

Use `npx expo install`, not `npm install`, for the storage package: npm would install
async-storage 3.x, and Expo 57 is tested with 2.2.0.

<details>
<summary>Which package is which? (click to open)</summary>

| Package | Status | What it is |
|---|---|---|
| `@ouo11y/react-native` | current, 0.2.1 | ouo's SDK for React Native and Expo apps. This guide. |
| `@ouo11y/browser` | current | ouo's SDK for web pages. Not for React Native: it needs a DOM. |
| `@sentry/react-native` | Sentry's SDK | The other way to send a React Native app to ouo: keep Sentry, point its DSN at the ouo collector's Sentry bridge ([the other mobile quickstarts](../index.md)). Do not run both SDKs into ouo at once: every session would arrive twice. |
| `@opentelemetry/*` | not needed | The SDK bundles the OpenTelemetry packages it uses; you install none. |
| `@ouo11y/react-native@0.0.0-stage` | do not use | A staging upload from before the first release. |

</details>

### 6b. Start the SDK before the app

The SDK has to start before the first screen renders, so its error handler and its `fetch`
wrapper are in place for everything the app does. Create `app/src/rum.ts`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/src/rum.ts -->
```ts
// ouo RUM, set up before the first render (index.ts imports this file first), so the error
// handlers and the fetch wrapper exist before the app does anything.
import { initRUM } from "@ouo11y/react-native";
import Constants from "expo-constants";

// The ouo collector's OTLP/HTTP port. From the iOS Simulator, localhost is your Mac.
// Replay frames go to its replay port: the SDK derives 4319 from 4318, and only from 4318, so
// when you move the collector's ports set both variables.
const endpoint = process.env.EXPO_PUBLIC_OUO_ENDPOINT ?? "http://localhost:4318";
const replayEndpoint = process.env.EXPO_PUBLIC_OUO_REPLAY_ENDPOINT;
export const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:5001";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const rum = initRUM({
  endpoint,
  replayEndpoint,
  // The quickstart's `demo` project. The token only allows writing telemetry: it is public by
  // nature, like every RUM key, and ships in the app bundle.
  projectId: "demo",
  projectToken: "pt_dev_demo_0000000000000000",
  service: { name: "tiny-shop-mobile", version: Constants.expoConfig?.version ?? "0.0.0", environment: "local" },
  // Requests to the API get `traceparent` and `baggage` (session.id, user.id): the API joins the trace.
  tracing: { propagateTo: [new RegExp(`^${escape(apiUrl)}`)] },
  // Native replay (Release builds; a no-op in Expo Go). Everything is masked by default;
  // this shop shows labels so the replay is readable, and keeps inputs and images masked.
  replay: { enabled: true, maskText: false },
  debug: __DEV__,
});
```

- `endpoint` is the collector's OTLP port. The SDK sends the replay to the same host on 4319, but
  derives that port only from 4318: with any other port it posts replay frames to the OTLP port,
  where they are lost without an error. Moved the collector (step 4c)? Set both, in front of
  every `npx expo` command:
  `EXPO_PUBLIC_OUO_ENDPOINT=http://localhost:14318 EXPO_PUBLIC_OUO_REPLAY_ENDPOINT=http://localhost:14319`.
- `projectId` and `projectToken` are the HTTP Basic credential the collector checks.
- `tracing.propagateTo` lists the URLs that get `traceparent` and `baggage`: only your API.
- `replay.maskText: false` shows labels in the replay; text inputs, images and web views stay
  masked. Leave it out and every text is a black box (the default, as Sentry's).

Replace `app/index.ts`, so `rum.ts` runs first:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/index.ts -->
```ts
// ouo first: its global error handler and fetch wrapper must exist before the app loads.
import "./src/rum";
import { registerRootComponent } from "expo";

import App from "./App";

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
```

Replace `app/App.tsx`. `RUMProvider` turns every touch into a `ui.tap` event; the navigation
listener turns every screen change into a `navigation` event and a screen display time:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/App.tsx -->
```tsx
import { RUMProvider, navigationStateListener } from "@ouo11y/react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { CartProvider } from "./src/cart";
import type { Routes } from "./src/routes";
import { rum } from "./src/rum";
import { CartScreen } from "./src/screens/CartScreen";
import { ProductScreen } from "./src/screens/ProductScreen";
import { ProductsScreen } from "./src/screens/ProductsScreen";

const Stack = createNativeStackNavigator<Routes>();

// RUMProvider turns every touch into a `ui.tap` event and session activity; the navigation
// listener turns every screen change into a `navigation` event and a TTID measurement.
export default function App() {
  return (
    <RUMProvider rum={rum}>
      <CartProvider>
        <NavigationContainer onReady={() => rum.trackNavigation("/Products")} onStateChange={navigationStateListener(rum)}>
          <Stack.Navigator>
            <Stack.Screen name="Products" component={ProductsScreen} options={{ title: "Tiny Shop" }} />
            <Stack.Screen name="Product" component={ProductScreen} options={({ route }) => ({ title: route.params.product.name })} />
            <Stack.Screen name="Cart" component={CartScreen} />
          </Stack.Navigator>
        </NavigationContainer>
      </CartProvider>
      <StatusBar style="auto" />
    </RUMProvider>
  );
}
```

### 6c. One trace for the checkout, and log lines

Every `fetch` is already a span, and the API joins its trace. To see the whole checkout as one
trace, from the tap to the API's `charge card`, wrap it in an app span. Replace `app/src/api.ts`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/src/api.ts -->
```ts
// Calls to the Tiny Shop API. The ouo SDK wraps fetch: every call is an `HTTP <METHOD>` span
// that sends `traceparent` and `baggage` to the API, and a 5xx is an `http.request.failed` event.
import { apiUrl, rum } from "./rum";

export type Product = { id: number; name: string; price: number };
export type CartLine = Product & { qty: number };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiUrl}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} ${res.status}: ${body.error ?? res.statusText}`);
  return body as T;
}

export const getProducts = () => call<Product[]>("/api/products");

export const callBrokenApi = () => call<never>("/api/fail");

// One app span around the checkout: the POST below is its child, so the API's spans join the
// same trace. React Native has no async context: after the first `await`, pass the span on.
export function checkout(lines: CartLine[]) {
  return rum.withSpan("place order", async (span) => {
    span.setAttribute("app.cart.items", lines.length);
    rum.log.info(`checkout started with ${lines.length} items`, { "app.cart.items": lines.length });
    const order = await call<{ orderId: number }>("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: lines.map((l) => ({ id: l.id, qty: l.qty })) }),
    });
    const receipt = rum.startSpan("save receipt", { parent: span });
    receipt.setAttribute("app.order.id", order.orderId);
    receipt.end();
    rum.log.info(`order ${order.orderId} placed`, { "app.order.id": order.orderId }, { span });
    return order;
  });
}
```

- `rum.withSpan("place order", fn)` starts a span, makes it the active one while `fn` runs, and ends
  it when the promise settles. The `POST` starts before the first `await`, so it is the span's
  child.
- React Native has no async context: after the `await`, nothing is active any more. `save
  receipt` gets its parent explicitly (`{ parent: span }`), and so does the second log line
  (`{ span }`).
- `rum.log.info(message, attributes)` is a log line in Loki, with the session and the trace id.

### 6d. The Debug buttons

Four ways for things to go wrong. Three need nothing new; **Native crash** needs a few lines of
native code, because a JavaScript app cannot crash natively on purpose (Sentry has
`Sentry.nativeCrash()` for this; the ouo SDK has no equivalent). An Expo local module does it.
Create the three files in `app/modules/tiny-crash/`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/modules/tiny-crash/expo-module.config.json -->
```json
{
  "platforms": ["apple"],
  "apple": {
    "modules": ["TinyCrashModule"]
  }
}
```

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/modules/tiny-crash/ios/TinyCrashModule.swift -->
```swift
import ExpoModulesCore

// One function, `crash()`: a write through a bad pointer, the classic native crash
// (EXC_BAD_ACCESS, SIGSEGV). ouo's signal handler writes a report; the next launch sends it.
public class TinyCrashModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TinyCrash")

    Function("crash") {
      let pointer = UnsafeMutablePointer<Int>(bitPattern: 0x8)!
      pointer.pointee = 42
    }
  }
}
```

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/modules/tiny-crash/ios/TinyCrash.podspec -->
```ruby
# Pod for the app's own TinyCrash module (modules/tiny-crash), autolinked by Expo.
Pod::Spec.new do |s|
  s.name           = 'TinyCrash'
  s.version        = '1.0.0'
  s.summary        = 'Crashes the app on purpose, to test native crash reporting'
  s.author         = 'Tiny Shop'
  s.homepage       = 'https://github.com/ouo11y/ouo11y'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
```

and its JavaScript side, `app/modules/tiny-crash/index.ts`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/modules/tiny-crash/index.ts -->
```ts
import { requireNativeModule } from "expo";

// The native module in ios/TinyCrashModule.swift. Not in Expo Go: it needs a build of this app.
const TinyCrash = requireNativeModule<{ crash(): void }>("TinyCrash");

export const crash = () => TinyCrash.crash();
```

Expo links every module under `app/modules/` on its own. Replace
`app/src/screens/ProductsScreen.tsx`:

<!-- embed: examples/quickstarts-mobile/tiny-shop-mobile-ouo/result/app/src/screens/ProductsScreen.tsx -->
```tsx
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { crash } from "../../modules/tiny-crash";
import { callBrokenApi, getProducts, type Product } from "../api";
import { rum } from "../rum";
import type { Routes } from "../routes";
import { Button, styles } from "../ui";

export function ProductsScreen({ navigation }: NativeStackScreenProps<Routes, "Products">) {
  const [products, setProducts] = useState<Product[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    getProducts().then(setProducts, (e: Error) => setMessage(e.message));
  }, []);

  const handledError = () => {
    try {
      JSON.parse("{ not json");
    } catch (e) {
      // Reported, the app goes on: the session becomes `errored`, not `crashed`.
      rum.captureError(e, { "app.screen.name": "Products" });
      setMessage("Handled error reported");
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {products.map((p) => (
        <Pressable key={p.id} testID={`product-${p.id}`} style={styles.row} onPress={() => navigation.navigate("Product", { product: p })}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.dim}>${p.price}</Text>
        </Pressable>
      ))}
      <Button title="Cart" testID="open-cart" onPress={() => navigation.navigate("Cart")} />

      <Text style={styles.section}>Debug</Text>
      <Button title="Call broken API" testID="call-broken-api" danger onPress={() => callBrokenApi().catch((e: Error) => setMessage(e.message))} />
      <Button title="Handled error" testID="handled-error" danger onPress={handledError} />
      <Button
        title="Throw error"
        testID="throw-error"
        danger
        onPress={() => {
          throw new Error("Throw error button: the shop crashed on purpose");
        }}
      />
      <Button title="Native crash" testID="native-crash" danger onPress={crash} />
      {message ? <Text style={styles.dim}>{message}</Text> : null}
    </ScrollView>
  );
}
```

| Button | What the SDK sends | The session |
|---|---|---|
| Call broken API | the `GET` span with status 500 and an `http.request.failed` event | errored |
| Handled error | `rum.captureError`: an `exception`, `ouo.exception.handled = true` | errored |
| Throw error | the global error handler: an `exception`, `ouo.exception.fatal = true` | crashed |
| Native crash | nothing at crash time; on the next launch a fatal `exception` with the native stack | crashed |

### 6e. Build it again

The SDK and the crash module have native code. `expo run:ios` does not always notice a new local
module, so regenerate the iOS project and its pods first (from `app/`):

```bash
npx expo prebuild --platform ios
```

then rebuild (a few minutes; Metro starts again):

```bash
npx expo run:ios
```

The Metro terminal prints `[ouo]` lines (`debug: __DEV__`): the session id, then exports.

## Step 7. See it in Grafana

In the app: tap **Coffee**, **Add to cart**, then in the cart **Checkout**. Go back to Products and
tap **Call broken API**, then **Handled error**. Then send the app to the background (Cmd+Shift+H
on the simulator) and wait a few seconds: the SDK exports on the way out.

### 7a. The session

**More apps -> ouo11y RUM -> Sessions.** The newest `tiny-shop-mobile` session is `errored`, with
1 error and 1 failed request. Open it: the timeline has the taps (`product-1`, `add-to-cart`,
`checkout`, ...: the SDK names a tap by its `testID` or accessibility label, never by its text),
the screen changes, every request, the log lines, the error with its stack, and the app going to
the background.

### 7b. One trace from the tap to the API

**Explore -> Tempo -> TraceQL:**

```
{ resource.service.name = "tiny-shop-mobile-api" && name = "charge card" }
```

Open the trace:

```
tiny-shop-mobile      place order                       (rum.withSpan)
├─ tiny-shop-mobile   HTTP POST                         (the SDK's fetch span)
│  └─ tiny-shop-mobile-api  POST /api/checkout          (HTTP server span)
│     ├─ middleware - jsonParser
│     └─ request handler - /api/checkout                (Express spans)
│        └─ checkout
│           ├─ validate cart
│           └─ charge card
└─ tiny-shop-mobile   save receipt                      (rum.startSpan, parent passed after the await)
every span: session.id, user.id                         (the SDK's attributes in the app, baggage in the API)
```

### 7c. Log lines and events

**Explore -> Loki:**

```
{service_name="tiny-shop-mobile"} | event_name="log"
```

`checkout started with 1 items`, `order … placed`. Without the `event_name` filter you see every
event the app sent: `session.start`, `navigation`, `ui.tap`, `http.request`,
`http.request.failed`, `exception`, `app.lifecycle`, and the vitals.

### 7d. App start and screen times

`ouo.app.start` (cold start, from the process start to the first screen), `ouo.screen.display`
(time to initial display, per screen) and `app.jank` (slow and frozen frames per screen) are in
the same Loki stream:

```
{service_name="tiny-shop-mobile", event_name=~"ouo.app.start|ouo.screen.display|app.jank"}
```

A Debug build is slower than a Release build: Metro serves unminified JavaScript. Read these
numbers on a Release build (step 8).

### 7e. A JS crash

Bring the app back, tap **Throw error**. In a Debug build React Native shows a red screen; that is
expected. Dismiss it, reload with `r` in Metro. The session is now `crashed`: its last events are
the fatal `exception` and `session.end` with reason `crash`.

## Step 8. Release build: native crash and replay

The replay and the native crash work in the Debug build too, but a Debug build is not the app your
users run: its JavaScript comes from Metro, unminified, so its timings are slower and its stacks
point at Metro's bundle. Build the Release configuration (the JavaScript is bundled into the app;
no Metro). Stop Metro with Ctrl+C, then from `app/`:

```bash
npx expo run:ios --configuration Release
```

`EXPO_PUBLIC_*` values are baked in at this build: rebuild after changing one.

### 8a. Replay

Tap through the shop again: a product, **Add to cart**, type a code in **Promo code**,
**Checkout**. Then send the app to the background and wait 10 seconds.

Open the new session in ouo11y RUM: the **Replay** panel plays the screens (a frame when the
screen changes, at most one a second, and one at each touch), with the taps drawn on top. The
labels are readable (`maskText: false`); the promo code field is a black box, and so are the
back-button arrows (images). Remove `maskText: false` from `rum.ts`, rebuild, and every text is
masked too.

**Known bug (0.2.1):** a frame taken at the moment of a touch can show the text field unmasked,
for example the tap on **Back** right after typing. Do not record real users' input fields with
this version until it is fixed; [sdk-state.md](sdk-state.md) has the details.

### 8b. Native crash

Open the app, tap **Native crash**. The app closes at once: that is the crash. Nothing could be
sent then; the SDK's signal handler wrote a report to the app's disk. Open the app again from the
simulator's home screen. On this launch the SDK sends the report:

- the crashed session is `crashed`, ended at the crash time;
- its last error is the native `exception`, `EXC_BAD_ACCESS` / `SIGSEGV`, with the crashed
  thread's frames in Apple crash-report form (addresses: symbolicate them with `atos` and the
  app's dSYM, `sdk/ios/README.md` in the ouo repository says how);
- the new session starts with `session.previous_id` pointing at the crashed one.

## Step 9. What you have, and what you do not

You have the ouo SDK's whole surface on iOS. [sdk-state.md](sdk-state.md) compares it, row by row,
with what the Sentry path (the other mobile quickstarts) gives the same app, and lists what is
still open: Android, offline buffering, compressed OTLP, the replay's size on the wire and its
main-thread cost on a real phone, and source maps.

## Step 10. Clean up

Stop the API and Metro with Ctrl+C. Stop the stack, keeping its data (in the stack's tab, from
`stack/`):

```bash
docker compose down
```

or delete its data too:

```bash
docker compose down -v
```

The app stays on the simulator; delete it with a long press on its icon, or erase that simulator
from Xcode's **Window -> Devices and Simulators**.

## When something does not work

| You see | Cause and fix |
|---|---|
| `Bind for 0.0.0.0:4318 failed: port is already allocated` | another stack has the port: step 4c, move this one with `stack/.env` |
| `rum-api` keeps restarting after a pull | a newer `latest` that wants a different config: `docker compose logs rum-api` names the key; pin the tested version (step 4a, "Image versions") |
| `denied` when pulling `ghcr.io/ouo11y/...` | not logged in to ghcr.io, or no read access yet: step 4b |
| The app opens and closes at once, before any screen, on iOS 27 | no scene delegate: `plugins/withUIScene.js` missing from `app.json`, or `ios/` was generated before you added it (`npx expo prebuild --clean`, then `npx expo run:ios`) |
| `create-expo-app` made an Expo 58 app | the template needs `@sdk-57` (step 3a) |
| `Cannot find native module 'TinyCrash'` | the module was added after the pods were installed, or the app runs in Expo Go: `npx expo prebuild --platform ios`, then `npx expo run:ios` |
| `401` in the `[ouo]` lines of Metro | the project credential in `rum.ts` does not match `projects.htpasswd` |
| `Network request failed` for `localhost:4318` | the stack is not up, or on other ports: `EXPO_PUBLIC_OUO_ENDPOINT` (step 6b) |
| The backend trace starts at `POST /api/checkout`, without the app's spans | `tracing.propagateTo` does not match the API URL (`EXPO_PUBLIC_API_URL`) |
| Backend spans have no `session.id` | `BaggageSpanProcessor` is missing in `instrumentation.js` |
| `save receipt` is a separate trace | its `parent` was not passed: after an `await` nothing is active |
| No replay, no error | the collector is not on 4318/4319 and `EXPO_PUBLIC_OUO_REPLAY_ENDPOINT` is not set: the SDK sent the frames to the OTLP port (step 6b) |
| A replay that stops early | the app went to the background before the last chunk was sent: wait 10 s in the background |
| No native crash after relaunch | the app was launched from Xcode with the debugger attached (it catches the signal first), or the crash happened before `initRUM` ran |
| Nothing in Tempo yet | wait up to a minute: new traces reach search later than trace-by-id |
