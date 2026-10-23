import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { getProducts, formatPrice, type Product } from "../api";
import type { ScreenProps } from "../navigation";
import { Button, ErrorBox, Loading, Screen, styles } from "../ui";

export function ProductsScreen({ navigation }: ScreenProps<"Products">) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    getProducts()
      .then(setProducts)
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  if (error) {
    return (
      <Screen>
        <ErrorBox message={error} />
        <Button title="Retry" onPress={load} />
        <Button title="Chaos" tone="danger" onPress={() => navigation.navigate("Chaos")} />
      </Screen>
    );
  }
  if (!products) return <Loading />;
  return (
    <Screen>
      <FlatList
        data={products}
        keyExtractor={(p) => p.id}
        renderItem={({ item }) => (
          <Pressable testID={`product-${item.id}`} onPress={() => navigation.navigate("Product", { id: item.id })} style={styles.row}>
            <Text style={styles.text}>{item.name}</Text>
            <Text style={styles.dim}>{formatPrice(item.price)}</Text>
          </Pressable>
        )}
      />
      <View>
        <Button title="Cart" onPress={() => navigation.navigate("Cart")} />
        <Button title="Chaos" tone="danger" onPress={() => navigation.navigate("Chaos")} />
      </View>
    </Screen>
  );
}
