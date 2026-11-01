import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { formatPrice, getProducts, type Product } from "../api";
import type { ScreenProps } from "../navigation";
import { ActionButton, Button, StatusLine, styles } from "../ui";

export function HomeScreen({ navigation }: ScreenProps<"Home">) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProducts()
      .then((p) => setProducts(p.slice(0, 3)))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ paddingBottom: 48 }}>
      <StatusLine />
      <Text style={styles.section}>Products</Text>
      {error && <Text style={styles.dim}>{error}</Text>}
      {!products && !error && <Text style={styles.dim}>loading…</Text>}
      {products?.map((p) => (
        <Pressable key={p.id} testID={`product-${p.id}`} style={styles.row} onPress={() => navigation.navigate("Product", { id: p.id })}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.dim}>{formatPrice(p.price)}</Text>
        </Pressable>
      ))}
      <Button title="Open cart" tone="muted" onPress={() => navigation.navigate("Cart")} />

      <Text style={styles.section}>Shop flows (traces + logs)</Text>
      <ActionButton name="browse-catalog" />
      <ActionButton name="search" />
      <ActionButton name="checkout" />
      <ActionButton name="checkout-fail" />

      <Text style={styles.section}>Network</Text>
      <ActionButton name="fetch-ok" />
      <ActionButton name="fetch-500" />
      <ActionButton name="fetch-slow" />
      <ActionButton name="xhr-cart" />

      <Text style={styles.section}>Errors</Text>
      <ActionButton name="handled-error" />
      <ActionButton name="unhandled-rejection" />
      <ActionButton name="message" />
      <ActionButton name="feedback" />
      <View style={{ height: 8 }} />
      <ActionButton name="js-fatal" tone="danger" />
      <ActionButton name="native-crash" tone="danger" />
      <ActionButton name="flush" tone="muted" />
    </ScrollView>
  );
}
