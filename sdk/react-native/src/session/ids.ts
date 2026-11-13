/**
 * A random 128-bit id written as 32 lowercase hex characters, a UUID v4 without its dashes
 * (`session.id` syntax, SES-1; Muninn rejects any other form, docs/specs/muninn.md). Uses `crypto.randomUUID` / `crypto.getRandomValues` when the runtime has them
 * (Expo installs them; bare React Native needs `react-native-get-random-values`) and
 * falls back to Math.random, which is fine for session ids.
 */
export function uuidv4(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && typeof c.randomUUID === "function") {
    try {
      return c.randomUUID().replace(/-/g, "");
    } catch {
      // some polyfills expose the function but throw; fall through
    }
  }
  const bytes = new Uint8Array(16);
  let filled = false;
  if (c && typeof c.getRandomValues === "function") {
    try {
      c.getRandomValues(bytes);
      filled = true;
    } catch {
      filled = false;
    }
  }
  if (!filled) for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex;
}
