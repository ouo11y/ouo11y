// Cart: the items and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { checkout, tap } from "../api";
import { useCart } from "../cart";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [message, setMessage] = useState("");
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  // One trace: this transaction, its http.client span, the API's POST /api/checkout span and
  // the API's manual spans checkout, validate cart and charge card.
  const onCheckout = () =>
    tap("tap Checkout", async () => {
      const order = await checkout(cart.items.map((p) => p.id));
      Sentry.logger.info(Sentry.logger.fmt`order ${order.orderId} placed: ${cart.items.length} items, $${total}`);
      setMessage(`Order #${order.orderId} placed`);
      cart.clear();
    });

  return (
    <View style={styles.screen}>
      {cart.items.map((p, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.muted}>${p.price}</Text>
        </View>
      ))}
      <Text style={styles.text}>Total: ${total}</Text>
      <Button title="Checkout" onPress={onCheckout} disabled={!cart.items.length} />
      <Text style={styles.muted}>{message}</Text>
    </View>
  );
}
