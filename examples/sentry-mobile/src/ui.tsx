import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { actions, type ActionName, runAction } from "./actions";
import { getStatus, subscribe } from "./status";

export function Button({ title, onPress, tone = "primary", testID }: { title: string; onPress: () => void; tone?: "primary" | "danger" | "muted"; testID?: string }) {
  return (
    <Pressable
      testID={testID ?? `btn-${title}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.button, styles[tone], pressed && styles.pressed]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export function ActionButton({ name, tone }: { name: ActionName; tone?: "primary" | "danger" | "muted" }) {
  return <Button testID={`action-${name}`} title={actions[name].title} tone={tone} onPress={() => runAction(name)} />;
}

/** Last action result; useful in the replay to see what the journey did. */
export function StatusLine() {
  const [status, setStatus] = useState(getStatus());
  useEffect(() => subscribe(setStatus), []);
  return (
    <View style={styles.statusBox}>
      <Text style={styles.mono} testID="status-line">
        {status}
      </Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, backgroundColor: "#fff" },
  button: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, marginVertical: 4, alignItems: "center" },
  primary: { backgroundColor: "#7c3aed" },
  danger: { backgroundColor: "#dc2626" },
  muted: { backgroundColor: "#6b7280" },
  pressed: { opacity: 0.7 },
  buttonText: { color: "#fff", fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#e5e7eb" },
  title: { fontSize: 18, fontWeight: "600", marginBottom: 8 },
  section: { fontSize: 13, fontWeight: "700", color: "#6b7280", marginTop: 12, marginBottom: 4, textTransform: "uppercase" },
  text: { fontSize: 16 },
  dim: { color: "#6b7280" },
  mono: { fontFamily: "Courier", fontSize: 12, color: "#374151" },
  statusBox: { backgroundColor: "#f3f4f6", borderRadius: 6, padding: 8, marginBottom: 8 },
});
