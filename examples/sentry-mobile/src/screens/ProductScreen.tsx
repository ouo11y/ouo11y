import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { addToCart, formatPrice, getProduct, type Product } from "../api";
import type { ScreenProps } from "../navigation";
import { setStatus } from "../status";
import { Button, StatusLine, styles } from "../ui";

export function ProductScreen({ route, navigation }: ScreenProps<"Product">) {
  const { id } = route.params;
  const [product, setProduct] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProduct(id)
      .then(setProduct)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  return (
    <View style={styles.screen}>
      <StatusLine />
      {error && <Text style={styles.dim}>{error}</Text>}
      {product ? (
        <>
          <Text style={styles.title}>{product.name}</Text>
          <Text style={styles.text}>{formatPrice(product.price)}</Text>
          <Button
            title="Add to cart"
            onPress={() =>
              addToCart(product.id)
                .then((c) => setStatus(`cart: ${c.items.length} lines`))
                .catch((e: Error) => setStatus(`add to cart: ${e.message}`))
            }
          />
          <Button title="Go to cart" tone="muted" onPress={() => navigation.navigate("Cart")} />
        </>
      ) : (
        !error && <Text style={styles.dim}>loading…</Text>
      )}
    </View>
  );
}
