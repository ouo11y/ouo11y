// Cart: what was added, and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { action, checkout } from "../api";
import { useCart } from "../cart";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [message, setMessage] = useState("");
  const total = cart.items.reduce((sum, p) => sum + p.price, 0);

  const onCheckout = () =>
    action("checkout", async () => {
      const order = await checkout(cart.items);
      Sentry.logger.info(`order ${order.orderId} placed: ${cart.items.length} items, $${total}`, { "order.id": order.orderId, "order.total": total });
      cart.clear();
      setMessage(`Order ${order.orderId} placed`);
    }).catch((e: Error) => setMessage(e.message));

  return (
    <View style={styles.screen}>
      {cart.items.map((p, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.text}>{p.name}</Text>
          <Text style={styles.text}>${p.price}</Text>
        </View>
      ))}
      <Text style={styles.text}>Total ${total}</Text>
      <Button title="Checkout" onPress={onCheckout} />
      {message ? <Text style={styles.muted}>{message}</Text> : null}
    </View>
  );
}
