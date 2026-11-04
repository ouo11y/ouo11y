import type { Attrs } from "../types";
import { normalizeLocation } from "./stack";

/**
 * `ouo.exception.debug_ids` (ADR-0011 section 6): JSON `{ location: debug id }` for the bundles
 * the (normalised) stack names, the same attribute and shape as `@ouo11y/browser`. The debug id
 * comes from the registration snippet that `withOuoDebugIds` (`@ouo11y/sourcemaps/metro`) or
 * `ouo-sourcemaps inject` put into the bundle before hermesc: it sets
 * `globalThis.__ouoDebugIds[<file of its own first frame>] = id`. The file is a raw Hermes path
 * (`index.android.bundle`, `/data/user/0/<app>/files/<ota>/index.android.bundle`,
 * `.../App.app/main.jsbundle`), so it is normalised like the stack (`app:///index.android.bundle`),
 * which is also the key rum-api looks up. One bundle runs per JS runtime, so every OTA bundle
 * reports its own id under the same location, and rum-api finds its own map.
 *
 * Sentry's Metro plugin registers `_sentryDebugIds[<stack>] = id` instead; it is read when no ouo
 * id is registered, so an app moving from Sentry keeps readable stacks with its existing build.
 */
export function debugIdAttribute(stacktrace: string): Attrs {
  try {
    const g = globalThis as { __ouoDebugIds?: Record<string, unknown>; _sentryDebugIds?: Record<string, unknown> };
    const out: Record<string, string> = {};
    const add = (file: string | undefined, id: unknown): void => {
      if (!file || typeof id !== "string" || !UUID.test(id)) return;
      const loc = normalizeLocation(file);
      if (loc && stacktrace.includes(`${loc}:`)) out[loc] = id.toLowerCase();
    };
    const ouo = g.__ouoDebugIds;
    if (ouo && typeof ouo === "object") for (const file of Object.keys(ouo)) add(file, ouo[file]);
    const sentry = g._sentryDebugIds;
    if (Object.keys(out).length === 0 && sentry && typeof sentry === "object") {
      for (const stack of Object.keys(sentry)) add(firstFile(stack), sentry[stack]);
    }
    return Object.keys(out).length > 0 ? { "ouo.exception.debug_ids": JSON.stringify(out) } : {};
  } catch {
    return {};
  }
}

const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
// The file of a stack's first frame: Hermes / V8 `(address at file:1:2)`, JSC `fn@file:1:2`.
const FIRST_FILE = /\((?:address at )?([^()]+?):\d+:\d+\)|@([^\s@()]+?):\d+:\d+|at ([^\s()]+?):\d+:\d+/;

function firstFile(stack: string): string | undefined {
  const m = FIRST_FILE.exec(stack);
  return m ? m[1] ?? m[2] ?? m[3] : undefined;
}
