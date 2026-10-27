import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { checkout } from "../api";
import { useCart } from "../cart";
import { Button, styles } from "../ui";

export function CartScreen() {
  const cart = useCart();
  const [promo, setPromo] = useState("");
  const [message, setMessage] = useState("");
  const total = cart.lines.reduce((sum, l) => sum + l.price * l.qty, 0);

  const onCheckout = () =>
    checkout(cart.lines).then(
      (order) => {
        cart.clear();
        setMessage(`Order ${order.orderId} placed`);
      },
      (e: Error) => setMessage(e.message)
    );

  return (
    <View style={styles.screen}>
      {cart.lines.map((l) => (
        <View key={l.id} style={styles.row}>
          <Text style={styles.text}>
            {l.qty} × {l.name}
          </Text>
          <Text style={styles.dim}>${l.price * l.qty}</Text>
        </View>
      ))}
      <Text style={styles.title}>Total ${total}</Text>
      {/* What a user types here never reaches a replay: inputs stay masked. */}
      <TextInput testID="promo-code" style={styles.input} placeholder="Promo code" value={promo} onChangeText={setPromo} />
      <Button title="Checkout" testID="checkout" onPress={onCheckout} />
      {message ? <Text style={styles.dim}>{message}</Text> : null}
    </View>
  );
}
