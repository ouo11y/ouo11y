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
    <ScrollView testID="product-list" contentContainerStyle={styles.screen}>
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
