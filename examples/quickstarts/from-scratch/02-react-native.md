# 02. Build a React Native app and watch it in ouo

The third guide of the [from-scratch series](README.md). You build Tiny Shop for iOS with Expo,
with no telemetry, then add `@ouo11y/react-native` and find its sessions, screens, custom events,
the crash and the screenshot replay in the stack of [guide 00](00-stack.md). Plan on about 30
minutes, most of it the native builds.

```
ouo-from-scratch/
├── stack/      guide 00, running
├── web/        guide 01: its dev server serves the product list
└── mobile/     this guide: Expo, TypeScript, @ouo11y/react-native
    ├── app.json      app name and iOS bundle id
    ├── index.ts      imports src/rum.ts first
    ├── src/rum.ts    the SDK, started once
    └── App.tsx       the shop
```

Every command goes in its own block: run them one by one, in order. Paths are relative to
`ouo-from-scratch/`. When a step says "replace the file", select everything in it and paste the
new content over it.

## Step 0. Check your tools

Node 24 or newer:

```bash
node -v
```

Xcode with an iOS Simulator runtime, and CocoaPods. Each prints a version:

```bash
xcodebuild -version
```

```bash
pod --version
```

CocoaPods fails on non-UTF-8 locales with `Unicode Normalization not appropriate for
ASCII-8BIT`. Set the locale in the terminal you build from:

```bash
export LANG=en_US.UTF-8
```

The stack of guide 00 is up, and the web app of guide 01 runs (`npm run dev` in `web/`): the
phone app reads its `products.json`.

Telemetry would run in Expo Go, but replay is native code, so this guide makes a development
build: your own app, built by Xcode and installed on the Simulator.

## Step 1. Create the app

From `ouo-from-scratch/`:

```bash
npx create-expo-app@latest mobile --template blank-typescript
```

```bash
cd mobile
```

**Name the app and give it a bundle id**, which Xcode needs. Replace `mobile/app.json`:

<!-- embed: examples/quickstarts/from-scratch/result/mobile/app.json -->
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
      "supportsTablet": true,
      "bundleIdentifier": "com.example.tinyshop"
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
    }
  }
}
```

## Step 2. A plain shop, no telemetry yet

Two screens, Products and Cart, kept in state, and the same checkout bug as the web app. The
products come from the web app's dev server: the iOS Simulator reaches your Mac as `localhost`.
Replace `mobile/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Button, FlatList, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";

type Product = { id: number; name: string; price: number };

// The product list is the web app's file (guide 01): run `npm run dev` in web/ first.
const PRODUCTS_URL = process.env.EXPO_PUBLIC_PRODUCTS_URL ?? "http://localhost:5173/products.json";

export default function App() {
  const [screen, setScreen] = useState<"Products" | "Cart">("Products");
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Product[]>([]);

  useEffect(() => {
    fetch(PRODUCTS_URL).then((r) => r.json()).then(setProducts).catch(() => setProducts([]));
  }, []);

  const go = (to: "Products" | "Cart") => setScreen(to);

  const add = (p: Product) => setCart([...cart, p]);
  const checkout = () => {
    // A bug on purpose: a product has no `total`, so this throws a TypeError.
    const total = (cart[0] as any).total.toFixed(2);
    alert(`Paid ${total} €`);
  };

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Tiny Shop</Text>
      <View style={styles.row}>
        <Button title="Products" onPress={() => go("Products")} />
        <Button title={`Cart (${cart.length})`} onPress={() => go("Cart")} />
      </View>
      {screen === "Products" ? (
        <FlatList
          data={products}
          keyExtractor={(p) => String(p.id)}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.item}>{item.name}, {item.price} €</Text>
              <Button title="Add to cart" onPress={() => add(item)} />
            </View>
          )}
        />
      ) : (
        <View style={styles.cart}>
          {cart.map((p, i) => <Text key={i} style={styles.item}>{p.name}</Text>)}
          <Button title="Checkout" onPress={checkout} disabled={cart.length === 0} />
        </View>
      )}
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff", paddingTop: 60 },
  title: { fontSize: 28, fontWeight: "600", margin: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
  item: { fontSize: 18, paddingVertical: 8 },
  cart: { paddingHorizontal: 16, alignItems: "flex-start" },
});
```

Build it and open it on the Simulator. The first build writes `ios/`, installs the pods and runs
Xcode: 5 to 15 minutes. Then Metro (the JavaScript bundler) keeps running in this terminal:

```bash
npx expo run:ios
```

The app shows Coffee, Tea and Cake. Add two, open the cart, tap **Checkout**: a red error screen
in development, a crash in a release build, and nobody but you knows. Dismiss it, and stop Metro
with Ctrl+C.

## Step 3. Install the SDK

From `mobile/`:

```bash
npx expo install @ouo11y/react-native@0.4.0 @react-native-async-storage/async-storage
```

| Package | What it does in this app |
|---|---|
| `@ouo11y/react-native` | The ouo mobile SDK: sessions, screens, `fetch` spans with W3C trace context, JavaScript errors and native crashes, app start, slow frames and stalls, custom events, and screenshot replay through its Expo native module; all sent as OTLP to the collector. The OpenTelemetry packages are bundled inside |
| `@react-native-async-storage/async-storage` | Where the SDK keeps the session and the requests not sent yet, so nothing is lost when the collector or the network is down |

## Step 4. Start the SDK before the app

**`initRUM` once, before the root component is registered**, so the global error handler and the
`fetch` wrapper exist before the first render. `replay.mode: "pixel/frames"` records masked
screenshots; `maskText: false` keeps labels readable, while text inputs, images and web views stay
masked. Create `mobile/src/rum.ts`:

<!-- embed: examples/quickstarts/from-scratch/result/mobile/src/rum.ts -->
```ts
// ouo RUM for React Native: sessions, taps, screens, errors, crashes, vitals, fetch spans and
// screenshot replay, sent as OTLP to the collector of guide 00.
import { initRUM } from "@ouo11y/react-native";

export const rum = initRUM({
  // The iOS Simulator reaches your Mac as localhost. A phone needs your Mac's LAN address.
  endpoint: process.env.EXPO_PUBLIC_OUO_ENDPOINT ?? "http://localhost:4318",
  projectId: "demo",                             // a line of stack/10-collector/projects.htpasswd
  projectToken: "pt_dev_demo_0000000000000000",  // public: it can only write into project demo
  service: { name: "tiny-shop-mobile", version: "1.0.0", environment: "local" },
  replay: { enabled: true, mode: "pixel/frames", maskText: false }, // needs a development build
  debug: __DEV__,
});
```

**Import it first.** Replace `mobile/index.ts`:

<!-- embed: examples/quickstarts/from-scratch/result/mobile/index.ts -->
```ts
import "./src/rum"; // first: the error handler and the fetch wrapper exist before the first render
import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
```

**Four additions to the shop.** Replace `mobile/App.tsx`. What changed from step 2:

- `<RUMProvider rum={rum}>` around the app: every touch counts as activity, which keeps the
  session alive (it ends after 30 minutes without any).
- `rum.trackNavigation("/Products")` and `"/Cart"`: a screen change. With React Navigation you
  would pass `navigationStateListener(rum)` to `onStateChange` instead.
- `rum.recordEvent("add_to_cart", ...)`: the same custom event as the web app, so one funnel
  covers both.
- **Sign in as alice** calls `rum.setUser("alice")`.

<!-- embed: examples/quickstarts/from-scratch/result/mobile/App.tsx -->
```tsx
import { useEffect, useState } from "react";
import { Button, FlatList, StyleSheet, Text, View } from "react-native";
import { RUMProvider } from "@ouo11y/react-native";
import { StatusBar } from "expo-status-bar";
import { rum } from "./src/rum";

type Product = { id: number; name: string; price: number };

// The product list is the web app's file (guide 01): run `npm run dev` in web/ first.
const PRODUCTS_URL = process.env.EXPO_PUBLIC_PRODUCTS_URL ?? "http://localhost:5173/products.json";

export default function App() {
  const [screen, setScreen] = useState<"Products" | "Cart">("Products");
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Product[]>([]);

  useEffect(() => {
    fetch(PRODUCTS_URL).then((r) => r.json()).then(setProducts).catch(() => setProducts([]));
  }, []);

  const go = (to: "Products" | "Cart") => {
    setScreen(to);
    rum.trackNavigation(`/${to}`); // a screen change: navigation event, new replay view
  };
  useEffect(() => rum.trackNavigation("/Products"), []);

  const add = (p: Product) => {
    setCart([...cart, p]);
    rum.recordEvent("add_to_cart", { "product.name": p.name, "product.price": p.price });
  };
  const checkout = () => {
    // A bug on purpose: a product has no `total`, so this throws a TypeError.
    const total = (cart[0] as any).total.toFixed(2);
    alert(`Paid ${total} €`);
  };

  return (
    <RUMProvider rum={rum}>
      <View style={styles.page}>
        <Text style={styles.title}>Tiny Shop</Text>
        <View style={styles.row}>
          <Button title="Products" onPress={() => go("Products")} />
          <Button title={`Cart (${cart.length})`} onPress={() => go("Cart")} />
          <Button title="Sign in as alice" onPress={() => rum.setUser("alice")} />
        </View>
        {screen === "Products" ? (
          <FlatList
            data={products}
            keyExtractor={(p) => String(p.id)}
            renderItem={({ item }) => (
              <View style={styles.row}>
                <Text style={styles.item}>{item.name}, {item.price} €</Text>
                <Button title="Add to cart" onPress={() => add(item)} />
              </View>
            )}
          />
        ) : (
          <View style={styles.cart}>
            {cart.map((p, i) => <Text key={i} style={styles.item}>{p.name}</Text>)}
            <Button title="Checkout" onPress={checkout} disabled={cart.length === 0} />
          </View>
        )}
        <StatusBar style="auto" />
      </View>
    </RUMProvider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#fff", paddingTop: 60 },
  title: { fontSize: 28, fontWeight: "600", margin: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16 },
  item: { fontSize: 18, paddingVertical: 8 },
  cart: { paddingHorizontal: 16, alignItems: "flex-start" },
});
```

## Step 5. Build again, and make a session

The SDK has native code (replay, crash capture), so build again; Expo installs its pods first:

```bash
npx expo run:ios
```

The Metro log shows the SDK starting:
`[ouo] @ouo11y/react-native@0.4.0 initialised {"endpoint": "http://localhost:4318", ...}` and
`[ouo] replay: started (whole session)`. Copy the session id from
`[ouo] session started <32 hex characters>`.

In the app: **Sign in as alice**, **Add to cart** twice, **Cart**, **Checkout**. Metro logs
`[ouo] event add_to_cart`, then `[ouo] fatal error, writing crash marker and flushing TypeError`.
Dismiss the red screen.

## Step 6. Find it in Grafana

Open http://localhost:3000, **Explore**, **Loki**, **Code**:

```logql
{service_name="tiny-shop-mobile"}
```

Every line is one event, with `ouo_platform = mobile` as a label. Your session only:

```logql
{ouo_project_id="demo"} | session_id="<your session id>"
```

| `event_name` | When |
|---|---|
| `session.start` | The app started a session |
| `navigation` | `trackNavigation`, with `url_path` (`/Products`, `/Cart`) |
| `ouo.app.start`, `ouo.screen.display` | App start time, and time to the first frame of a screen |
| `app.jank`, `ouo.stall` | Slow frames; the main thread blocked |
| `http.request` | The `fetch` of `products.json`, with method, URL and status |
| `add_to_cart` | Your `recordEvent`, with `ouo_event_custom = true` |
| `exception` | The checkout bug: `exception_message`, the stack, `ouo_exception_fatal`, and the last events before it |
| `ouo.replay.chunk` | A reference to each replay chunk; the frames are in Muninn |

Two names differ from the web SDK (`navigation` and `browser.navigation`, `user_id` and
`enduser_id`): the web SDK 0.4 follows the new client SDK spec and the mobile SDK does not yet. A
reader of both, like `ouo-go` in guide 03, accepts both.

**Replay, in Muninn**, from any folder:

```bash
curl -s -H 'Authorization: Bearer mrt_dev_0000000000000000' localhost:3400/api/v1/projects/demo/sessions/<your session id>/replays
```

You see one replay, format `ouo-frames/3`: JPEG frames and tile patches, masked on the device.

## Clean up

Stop Metro with Ctrl+C, and the Simulator with **Simulator > Device > Shut Down**. Keep the stack
and the web app running for [03. A Grafana plugin](03-plugin.md).

## On a phone

A phone cannot reach your Mac as `localhost`. Find your Mac's LAN address (**System Settings >
Wi-Fi > Details**), then build with the collector and the product list on that address:

```bash
EXPO_PUBLIC_OUO_ENDPOINT=http://<your Mac's address>:4318 EXPO_PUBLIC_PRODUCTS_URL=http://<your Mac's address>:5173/products.json npx expo run:ios --device
```

The web dev server must listen on the network too: `npm run dev -- --host` in `web/`. Running on
a phone needs an Apple developer account selected in Xcode for signing.

## When something does not work

| What you see | Why | Fix |
|---|---|---|
| `pod install` fails with `Unicode Normalization not appropriate for ASCII-8BIT` | CocoaPods needs a UTF-8 locale | `export LANG=en_US.UTF-8`, then `npx expo run:ios` again |
| `The sandbox is not in sync with the Podfile.lock` | A `pod install` failed earlier | Same: fix the locale and build again |
| The product list is empty | The web dev server of guide 01 is not running | `npm run dev` in `web/` |
| No `[ouo] ... initialised` line | `index.ts` does not import `./src/rum` first | Step 4 |
| Telemetry arrives but no replay, and no `[ouo] replay: started` line | The app runs in Expo Go, which has no native module of ours | `npx expo run:ios`, then open **Tiny Shop**, not Expo Go |
| Nothing reaches Loki from a phone | The app still posts to `localhost` | "On a phone" above |
| The first taps after a launch do nothing | The bundle is still loading (`Bundling 30%...` at the top) | Wait for the app to finish loading |
