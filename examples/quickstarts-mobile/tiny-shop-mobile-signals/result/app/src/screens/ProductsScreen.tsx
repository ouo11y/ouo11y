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
