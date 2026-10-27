// A button and the shared styles.
import { Pressable, StyleSheet, Text } from "react-native";

// `label` also becomes `sentry-label`, the name Sentry gives the tap breadcrumb. Sentry reads it
// only when text masking is off: with masking on, a label could be personal data.
export function Button({ label, onPress, kind = "primary" }: { label: string; onPress: () => void; kind?: "primary" | "debug" }) {
  return (
    <Pressable
      sentry-label={label}
      onPress={onPress}
      style={({ pressed }) => [styles.button, kind === "debug" && styles.debug, pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fafafa" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, backgroundColor: "white", borderRadius: 8 },
  image: { width: 48, height: 48, borderRadius: 8 },
  name: { fontSize: 17, fontWeight: "600" },
  price: { fontSize: 15, color: "#555" },
  section: { fontSize: 13, fontWeight: "700", color: "#888", textTransform: "uppercase", marginTop: 12 },
  note: { fontSize: 14, color: "#333" },
  button: { backgroundColor: "#4b3fcc", padding: 14, borderRadius: 8, alignItems: "center" },
  debug: { backgroundColor: "#a33" },
  pressed: { opacity: 0.6 },
  buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
});
