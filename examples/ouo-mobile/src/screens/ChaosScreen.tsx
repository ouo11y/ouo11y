import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { chaos } from "../../modules/ouo-chaos";
import { getProducts } from "../api";
import { rum, shortId } from "../rum";
import { Button, styles } from "../ui";

/** Every button maps to one row of the session spec / ADR-0004 classification. */
export function ChaosScreen() {
  const [log, setLog] = useState<string[]>([]);
  const note = (line: string) => setLog((l) => [`${new Date().toISOString().slice(11, 19)} ${line}`, ...l].slice(0, 12));

  const slow = async () => {
    note("slow request (delay=2000)...");
    const t = Date.now();
    await getProducts({ delay: 2000 });
    note(`slow request done in ${Date.now() - t} ms`);
  };
  const fail500 = async () => {
    try {
      await getProducts({ fail: "500" });
    } catch (err) {
      note(`500 -> http.request.failed (${(err as Error).message})`);
    }
  };
  const handled = () => {
    try {
      throw new Error("Handled error from the Chaos screen");
    } catch (err) {
      rum.captureError(err, { screen: "Chaos" });
      note("captureError -> exception fatal=false handled=true");
    }
  };
  const rejection = () => {
    void Promise.reject(new Error("Unhandled rejection from the Chaos screen"));
    note("unhandled rejection -> exception fatal=false handled=false");
  };
  const fatal = () => {
    note("fatal error in 100 ms -> exception fatal=true, crash marker");
    // Thrown from a timer callback so it reaches ErrorUtils' global handler with isFatal=true.
    setTimeout(() => {
      throw new Error("Fatal error from the Chaos screen (setTimeout)");
    }, 100);
  };
  const consoleError = () => {
    console.error("console.error from the Chaos screen", { cart: "empty" });
    note("console.error -> exception fatal=false handled=true");
  };
  const hang = async () => {
    note("main thread blocked for 3 s -> one hang exception (not fatal) when it is over");
    await chaos?.blockMainThread(3000);
  };
  const outOfMemory = () => {
    note("memory warning, then killed -> termination (memory) on the next launch");
    chaos?.simulateOutOfMemory();
  };
  const custom = () => {
    rum.addEvent("chaos.custom", { "chaos.kind": "button", "chaos.count": log.length });
    note("custom event chaos.custom");
  };
  const setUser = () => {
    const id = `user-${Math.floor(Math.random() * 1000)}`;
    rum.setUser({ id });
    note(`setUser ${id}`);
  };
  const flush = async () => {
    await rum.flush();
    note("flushed");
  };
  const replayToggle = () => {
    if (rum.replay.isRecording()) {
      rum.replay.pause();
    } else {
      rum.replay.resume();
    }
    note(`replay ${rum.replay.isRecording() ? "recording" : "paused (or unavailable: needs the dev client)"}`);
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.mono}>session {shortId(rum.session.id())} user {rum.session.userId().slice(0, 12)}</Text>
      <Button title="Slow request (2 s)" onPress={() => void slow()} />
      <Button title="500 from the backend" tone="danger" onPress={() => void fail500()} />
      <Button title="Handled error" onPress={handled} />
      <Button title="Unhandled promise rejection" onPress={rejection} />
      <Button title="Fatal error (crash)" tone="danger" onPress={fatal} />
      <Button title="console.error" onPress={consoleError} />
      {chaos ? <Button title="Hang the main thread (3 s)" tone="danger" onPress={() => void hang()} /> : null}
      {chaos ? <Button title="Out-of-memory kill" tone="danger" onPress={outOfMemory} /> : null}
      <Button title="Custom event" tone="muted" onPress={custom} />
      <Button title="Set user" tone="muted" onPress={setUser} />
      <Button title="Flush" tone="muted" onPress={() => void flush()} />
      <Button title={`Replay pause/resume (${rum.replay.isRecording() ? "recording" : "off"})`} tone="muted" onPress={replayToggle} />
      {log.map((line, i) => (
        <Text key={i} style={styles.mono}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}
