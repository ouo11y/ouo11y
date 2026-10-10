import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
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
  const [promo, setPromo] = useState("");

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
      <Text style={styles.text}>Promo code</Text>
      {/* testID "ouo-mask" forces the replay recorder to redact this view (text inputs are masked
          anyway; the identifier is how any view, e.g. a card preview, would opt in). */}
      <TextInput
        testID="ouo-mask"
        value={promo}
        onChangeText={setPromo}
        placeholder="SAVE10"
        autoCapitalize="characters"
        style={styles.input}
      />
      {error ? <ErrorBox message={error} /> : null}
      <View>
        <Button title="Pay" onPress={pay} disabled={busy} />
      </View>
    </Screen>
  );
}
