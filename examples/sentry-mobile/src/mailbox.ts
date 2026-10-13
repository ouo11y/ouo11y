// Prompt-free command channel for scripts/journey.sh.
//
// On iOS 27 `xcrun simctl openurl` shows an "Open in sentry-demo?" system alert for every custom
// scheme URL, which an unattended script cannot dismiss. The journey therefore writes the same
// deep-link path (e.g. `action/handled-error`) into Documents/journey-command in the app's data
// container (`xcrun simctl get_app_container booted dev.ouo.sentrydemo data`), and the app polls
// that file while in the foreground. No network traffic, so nothing extra in the Sentry data.
import { File, Paths } from "expo-file-system";
import { handleUrl } from "./deeplinks";

const POLL_MS = 400;

export function startMailbox(): () => void {
  const file = new File(Paths.document, "journey-command");
  const timer = setInterval(() => {
    try {
      if (!file.exists) return;
      const cmd = file.textSync().trim();
      file.delete();
      for (const line of cmd.split("\n")) {
        if (line.trim()) handleUrl(`sentrydemo://${line.trim().replace(/^sentrydemo:\/\//, "")}`);
      }
    } catch {
      // half-written file: try again on the next tick
    }
  }, POLL_MS);
  return () => clearInterval(timer);
}
