#!/usr/bin/env node
// Drives 30 shopper sessions through Tiny Shop on the iOS Simulator, then prints how many
// sessions reach each step of the funnel, counted by hand from the journeys below. The funnel
// in Grafana must say the same.
//
//   node generate.mjs [--device <simulator name or udid>] [--seed <n>]
//
// One session per journey: the app is started again with the journey as launch arguments (a cold
// start always starts a new session), walks its steps through the app's own navigation and cart
// code (src/journey.ts), and sends what it recorded. Needs the app built and installed
// on the simulator (`npx expo run:ios --configuration Release`) and the stack and the API up.
// No dependencies: it only runs `xcrun simctl`.

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DEVICE = arg("--device", "booted");
const SEED = Number(arg("--seed", 7));
const BUNDLE = "dev.ouo.tinyshop.m6";

// The funnel to build in Grafana, in order.
const FUNNEL = ["page:/Products", "page:/Product", "event:add_to_cart", "page:/Cart", "event:order_paid"];

// Who shops how, and how many sessions of each. The app opens on Products.
const JOURNEYS = [
  { name: "bounce", sessions: 4, steps: [] }, // looks at the list, leaves
  { name: "cart first", sessions: 2, steps: ["cart", "back"] }, // the cart before any product: out of order
  { name: "browse", sessions: 7, steps: ["product-1", "back", "product-3"] },
  { name: "add, leave", sessions: 4, steps: ["product-2", "add"] },
  { name: "abandon the cart", sessions: 5, steps: ["product-1", "add", "cart"] },
  { name: "buy", sessions: 6, steps: ["product-3", "add", "cart", "pay"] },
  { name: "wander, buy", sessions: 2, steps: ["product-1", "back", "product-2", "add", "back", "product-2", "add", "cart", "pay"] },
];

// What each step records, as funnel steps: screens are `navigation` events with `url.path`.
function recorded(steps) {
  const out = ["page:/Products"];
  const screens = ["/Products"];
  for (const s of steps) {
    if (s.startsWith("product-")) screens.push("/Product");
    else if (s === "cart") screens.push("/Cart");
    else if (s === "back") screens.pop();
    else if (s === "add") out.push("event:add_to_cart");
    else if (s === "pay") out.push("event:order_paid");
    if (s.startsWith("product-") || s === "cart" || s === "back") out.push(`page:${screens.at(-1)}`);
  }
  return out;
}

// How deep a session gets: each step must come after the previous one (strict order).
function depth(events) {
  let n = 0;
  for (const e of events) if (e === FUNNEL[n]) n++;
  return n;
}

// A small seeded generator, so every run walks the same order at the same paces.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = random(SEED);
const sessions = JOURNEYS.flatMap((j) => Array.from({ length: j.sessions }, () => j));
for (let i = sessions.length - 1; i > 0; i--) {
  const k = Math.floor(rnd() * (i + 1));
  [sessions[i], sessions[k]] = [sessions[k], sessions[i]];
}

const simctl = (...a) => execFileSync("xcrun", ["simctl", ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const started = new Date();
for (const [i, j] of sessions.entries()) {
  const pace = 600 + Math.floor(rnd() * 1200); // ms between two steps
  const steps = j.steps.join(",") || "stay";
  simctl("launch", "--terminate-running-process", DEVICE, BUNDLE, "-journey", steps, "-pace", String(pace));
  console.log(`session ${String(i + 1).padStart(2)}/${sessions.length}  ${j.name.padEnd(16)} pace ${pace} ms`);
  // The app starts, walks the steps one per pace, waits one more and sends.
  await sleep(4000 + pace * (j.steps.length + 1));
}
// The last session ends on the next launch; stop the app so it does not run on.
simctl("terminate", DEVICE, BUNDLE);

const reached = FUNNEL.map((_, n) => sessions.filter((j) => depth(recorded(j.steps)) > n).length);
console.log(`\n${sessions.length} sessions from ${started.toISOString()} to ${new Date().toISOString()}`);
console.log("expected funnel (sessions per step):");
FUNNEL.forEach((step, n) => console.log(`  ${n + 1}. ${step.padEnd(20)} ${reached[n]}`));
