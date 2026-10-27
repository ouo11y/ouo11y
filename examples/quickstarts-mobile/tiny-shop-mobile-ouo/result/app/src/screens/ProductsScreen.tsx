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
