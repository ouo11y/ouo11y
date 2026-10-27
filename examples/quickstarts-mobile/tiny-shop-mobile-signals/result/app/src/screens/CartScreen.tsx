import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Alert, Button, StyleSheet, Text, View } from "react-native";
import { action, api, formatPrice } from "../api";
import { useCart } from "../cart";
import { Sentry } from "../sentry";

export function CartScreen() {
  const navigation = useNavigation();
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  const checkout = () => {
    setBusy(true);
    const items = cart.items.map((p) => p.id);
    // POST /api/checkout in its own trace: the API's checkout -> validate cart, charge card
    // spans are children of this tap's http.client span.
    action("Checkout", () => api<{ orderId: number }>("/api/checkout", { method: "POST", json: { items } }))
      .then((order) => {
        Sentry.logger.info(Sentry.logger.fmt`Order ${order.orderId} placed: ${items.length} items, ${formatPrice(total)}`);
        cart.clear();
        navigation.goBack();
      })
      .catch((err: Error) => {
        Sentry.logger.error(Sentry.logger.fmt`Checkout failed: ${err.message}`);
        Alert.alert("Checkout failed", err.message);
      })
      .finally(() => setBusy(false));
  };

  return (
    <View style={styles.page}>
      {cart.items.length === 0 ? <Text>Your cart is empty.</Text> : null}
      {cart.items.map((p, i) => (
        <Text key={i}>
          {p.name} {formatPrice(p.price)}
        </Text>
      ))}
      <Text style={styles.total}>Total {formatPrice(total)}</Text>
      <Button title={busy ? "Placing order…" : "Checkout"} onPress={checkout} disabled={busy || cart.items.length === 0} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 8 },
  total: { fontSize: 20, fontWeight: "700", marginVertical: 12 },
});
