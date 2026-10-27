// Two small building blocks the screens share.
import { Pressable, StyleSheet, Text } from "react-native";

export function Button({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fff" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12 },
  title: { fontSize: 22, fontWeight: "600" },
  text: { fontSize: 17 },
  muted: { fontSize: 15, color: "#666" },
  section: { marginTop: 24, fontSize: 13, fontWeight: "600", color: "#666", textTransform: "uppercase" },
  button: { backgroundColor: "#1f6feb", borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
