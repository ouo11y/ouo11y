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
