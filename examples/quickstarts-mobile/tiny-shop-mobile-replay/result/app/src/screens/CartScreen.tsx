// Cart: the lines, where it ships, and "Checkout" (POST /api/checkout).
import { useState } from "react";
import { Text, View } from "react-native";
import { checkout, formatPrice } from "../api";
import { useCart } from "../cart";
import { Sentry } from "../sentry";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [status, setStatus] = useState("");

  const pay = () => {
    const total = cart.total;
    checkout(cart.lines.map((l) => ({ id: l.product.id, qty: l.qty })))
      .then((order) => {
        Sentry.logger.info(`checkout order ${order.orderId} ${formatPrice(total)}`, { "order.id": order.orderId });
        cart.clear();
        setStatus(`Order #${order.orderId} placed`);
      })
      .catch((e: Error) => setStatus(`Checkout failed: ${e.message}`));
  };

  return (
    <View style={styles.screen}>
      {cart.lines.map((l) => (
        <Text key={l.product.id} style={styles.note}>
          {l.qty} x {l.product.name} {formatPrice(l.qty * l.product.price)}
        </Text>
      ))}
      <Sentry.Unmask>
        <Text style={styles.name}>Total {formatPrice(cart.total)}</Text>
      </Sentry.Unmask>
      <Text style={styles.section}>Ship to</Text>
      {/* Mask: hidden in every replay, even when masking is off. */}
      <Sentry.Mask>
        <Text style={styles.note}>Jane Doe, 12 Sample Street, Springfield</Text>
        <Text style={styles.note}>Card ending 4242</Text>
      </Sentry.Mask>
      <Button label="Checkout" onPress={pay} />
      {status ? <Text style={styles.note}>{status}</Text> : null}
    </View>
  );
}
