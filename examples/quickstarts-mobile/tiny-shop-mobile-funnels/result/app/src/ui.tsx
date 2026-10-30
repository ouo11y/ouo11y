// A few shared styles and a button. `testID` names the button and `role` says what it is: ouo's
// tap events read both (`ouo.ui.target`, `ouo.ui.view_type`) and never the button's text.
import { Pressable, StyleSheet, Text } from "react-native";

export function Button({ title, testID, onPress }: { title: string; testID: string; onPress: () => void }) {
  return (
    <Pressable testID={testID} role="button" onPress={onPress} style={styles.button}>
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
  button: { backgroundColor: "#2563eb", padding: 14, borderRadius: 8, alignItems: "center" },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
