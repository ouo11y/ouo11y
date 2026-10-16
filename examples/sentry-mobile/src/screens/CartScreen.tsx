import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { type Cart, formatPrice, getCart } from "../api";
import type { ScreenProps } from "../navigation";
import { Button, StatusLine, styles } from "../ui";

export function CartScreen({ navigation }: ScreenProps<"Cart">) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCart()
      .then(setCart)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <View style={styles.screen}>
      <StatusLine />
      {error && <Text style={styles.dim}>{error}</Text>}
      {cart?.items.map((i) => (
        <View key={i.productId} style={styles.row}>
          <Text style={styles.text}>
            {i.qty} × {i.name}
          </Text>
          <Text style={styles.dim}>{formatPrice(i.subtotal)}</Text>
        </View>
      ))}
      {cart && <Text style={[styles.text, { marginTop: 8 }]}>Total {formatPrice(cart.total)}</Text>}
      <Button title="Back to products" tone="muted" onPress={() => navigation.popToTop()} />
    </View>
  );
}
