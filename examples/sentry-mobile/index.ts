// Launch order (ROLLOUT.md): decide the rollout mode first, then initialise the SDKs that mode
// uses, Sentry before ouo, and only then render. Nothing monitors the app before the decision:
// with a decision stored by the previous launch that is one file read; only the very first
// launch waits for the flag (at most flagTimeoutMs).
import { registerRootComponent } from "expo";
import { createElement, useEffect, useState, type ComponentType } from "react";
import App from "./App";
import { setMode } from "./src/monitoring";
import { initOuo } from "./src/ouo";
import { decideLaunch, usesOuo, usesSentry, type Launch } from "./src/rollout";
import { initSentry, Sentry } from "./src/sentry";
import { setStatus } from "./src/status";

let Root: ComponentType = App;

function start(launch: Launch): void {
  setMode(launch.mode);
  if (usesSentry(launch.mode)) initSentry(launch.mode);
  if (usesOuo(launch.mode)) initOuo(launch.mode);
  if (usesSentry(launch.mode)) Root = Sentry.wrap(App);
  setStatus(`rum mode ${launch.mode} (${launch.source}), device ${launch.deviceId.slice(0, 8)}`);
  void launch.next.then((next) => next && next !== launch.mode && setStatus(`rum mode ${next} from the next launch`));
}

const decided = decideLaunch();
let ready: Promise<void> | undefined;
if (decided instanceof Promise) ready = decided.then(start);
else start(decided);

// registerRootComponent must run synchronously at bundle load; on a first launch the root
// renders nothing until the mode is known (`start` runs before this component's `then`).
function Bootstrap() {
  const [isReady, setReady] = useState(ready === undefined);
  useEffect(() => {
    if (!isReady) void ready?.then(() => setReady(true));
  }, [isReady]);
  return isReady ? createElement(Root) : null;
}

registerRootComponent(Bootstrap);
