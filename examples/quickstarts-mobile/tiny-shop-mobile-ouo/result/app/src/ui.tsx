// A few shared styles and a button. `testID` names the button for tests and for ouo's tap
// events (ouo never reads the button's text).
import { Pressable, StyleSheet, Text } from "react-native";

export function Button({ title, testID, onPress, danger }: { title: string; testID: string; onPress: () => void; danger?: boolean }) {
  return (
    <Pressable testID={testID} onPress={onPress} style={[styles.button, danger && styles.danger]}>
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16, gap: 12, backgroundColor: "#fff" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 14, borderBottomWidth: 1, borderColor: "#eee" },
  title: { fontSize: 22, fontWeight: "600" },
  text: { fontSize: 17 },
  dim: { fontSize: 15, color: "#666" },
  section: { marginTop: 24, fontSize: 13, color: "#666", textTransform: "uppercase" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 17 },
  button: { backgroundColor: "#2563eb", padding: 14, borderRadius: 8, alignItems: "center" },
  danger: { backgroundColor: "#b91c1c" },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
