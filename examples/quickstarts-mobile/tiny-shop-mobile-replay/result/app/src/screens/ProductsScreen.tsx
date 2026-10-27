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
