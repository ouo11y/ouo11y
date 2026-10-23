import { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

export function Button({ title, onPress, tone = "primary", disabled }: { title: string; onPress: () => void; tone?: "primary" | "danger" | "muted"; disabled?: boolean }) {
  return (
    <Pressable
      testID={`btn-${title}`}
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, styles[tone], pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  return <View style={styles.screen}>{children}</View>;
}

export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator />
    </View>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  button: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, marginVertical: 6, alignItems: "center" },
  primary: { backgroundColor: "#2563eb" },
  danger: { backgroundColor: "#dc2626" },
  muted: { backgroundColor: "#6b7280" },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  buttonText: { color: "#fff", fontWeight: "600" },
  errorBox: { backgroundColor: "#fee2e2", padding: 12, borderRadius: 8, marginVertical: 8 },
  errorText: { color: "#991b1b" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#e5e7eb" },
  title: { fontSize: 18, fontWeight: "600" },
  text: { fontSize: 16 },
  dim: { color: "#6b7280" },
  input: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, marginBottom: 12 },
  mono: { fontFamily: "Courier", fontSize: 12, color: "#374151" },
});
