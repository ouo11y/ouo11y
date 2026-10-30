import { useCallback, useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { getCart, formatPrice, type Cart } from "../api";
import { FeedbackForm } from "../FeedbackForm";
import type { ScreenProps } from "../navigation";
import { Button, ErrorBox, Loading, Screen, styles } from "../ui";

export function CartScreen({ navigation }: ScreenProps<"Cart">) {
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    getCart()
      .then(setCart)
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(() => navigation.addListener("focus", load), [navigation, load]);

  if (error) return <Screen><ErrorBox message={error} /></Screen>;
  if (!cart) return <Loading />;
  return (
    <Screen>
      <FlatList
        data={cart.items}
        keyExtractor={(i) => i.productId}
        ListEmptyComponent={<Text style={styles.dim}>Your cart is empty.</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.text}>
              {item.qty} x {item.name}
            </Text>
            <Text style={styles.dim}>{formatPrice(item.subtotal)}</Text>
          </View>
        )}
      />
      <Text style={styles.title}>Total {formatPrice(cart.total)}</Text>
      <Button title="Checkout" onPress={() => navigation.navigate("Checkout")} disabled={cart.itemCount === 0} />
      <Button title="Continue shopping" tone="muted" onPress={() => navigation.navigate("Products")} />
      <FeedbackForm />
    </Screen>
  );
}
