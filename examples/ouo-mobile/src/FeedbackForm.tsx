import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { rum } from "./rum";
import { Button, styles } from "./ui";

/**
 * The app's own feedback form (the SDK has the primitive, not a widget): `rum.feedback` sends a
 * `feedback` event with the last 20 steps and asks the replay for a masked frame of this screen.
 */
export function FeedbackForm() {
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [sent, setSent] = useState<string | undefined>();
  const send = () => {
    const id = rum.feedback({ message, contact, screenshot: true });
    if (!id) return;
    setSent(id);
    setMessage("");
  };
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={styles.title}>Report a problem</Text>
      <TextInput testID="feedback-message" value={message} onChangeText={setMessage} placeholder="What went wrong?" multiline style={styles.input} />
      <TextInput testID="feedback-contact" value={contact} onChangeText={setContact} placeholder="Email (optional)" autoCapitalize="none" keyboardType="email-address" style={styles.input} />
      <Button title="Send feedback" onPress={send} disabled={!message.trim()} />
      {sent ? <Text testID="feedback-sent" style={styles.dim}>Thanks, sent ({sent.slice(0, 8)})</Text> : null}
    </View>
  );
}
