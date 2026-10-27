// Two small building blocks so the screens stay short.
import { Pressable, StyleSheet, Text } from "react-native";

export function Button({ title, onPress, kind = "primary" }: { title: string; onPress: () => void; kind?: "primary" | "debug" }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.button, kind === "debug" && styles.debug]}>
      <Text style={styles.label}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fff" },
  row: { padding: 14, borderRadius: 8, backgroundColor: "#f2f2f2", flexDirection: "row", justifyContent: "space-between" },
  title: { fontSize: 22, fontWeight: "600" },
  text: { fontSize: 16 },
  muted: { fontSize: 14, color: "#666" },
  button: { padding: 14, borderRadius: 8, backgroundColor: "#2f6fed", alignItems: "center" },
  debug: { backgroundColor: "#8a8a8a" },
  label: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
