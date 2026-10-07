import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { checkout, type PaymentMethod } from "../api";
import type { ScreenProps } from "../navigation";
import { Button, ErrorBox, Screen, styles } from "../ui";

const METHODS: Array<{ id: PaymentMethod; label: string }> = [
  { id: "card", label: "card (succeeds)" },
  { id: "broken-card", label: "broken-card (backend answers 500)" },
];

export function CheckoutScreen({ navigation }: ScreenProps<"Checkout">) {
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pay = async () => {
    setBusy(true);
    setError(null);
    try {
      const order = await checkout(method);
      navigation.replace("Order", { order });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Text style={styles.title}>Payment method</Text>
      {METHODS.map((m) => (
        <Pressable key={m.id} testID={`method-${m.id}`} onPress={() => setMethod(m.id)} style={styles.row}>
          <Text style={styles.text}>{m.label}</Text>
          <Text style={styles.dim}>{method === m.id ? "selected" : ""}</Text>
        </Pressable>
      ))}
      {error ? <ErrorBox message={error} /> : null}
      <View>
        <Button title="Pay" onPress={pay} disabled={busy} />
      </View>
    </Screen>
  );
}
