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
