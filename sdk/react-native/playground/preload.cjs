/**
 * Node stand-ins for the React Native globals and modules the bundle needs, so the
 * built SDK (dist/index.js) can run a session against the real collector when no iOS
 * Simulator is available. Usage: node --require ./playground/preload.cjs playground/scenario.cjs
 *
 * Storage is a JSON file (OUO_STORAGE_FILE) so separate processes behave like app launches.
 */
const Module = require("node:module");
const fs = require("node:fs");

const storageFile = process.env.OUO_STORAGE_FILE || "/tmp/ouo-rn-playground-storage.json";
function readAll() {
  try {
    return JSON.parse(fs.readFileSync(storageFile, "utf8"));
  } catch {
    return {};
  }
}
function writeAll(obj) {
  fs.writeFileSync(storageFile, JSON.stringify(obj));
}
const AsyncStorage = {
  getItem: async (k) => readAll()[k] ?? null,
  setItem: async (k, v) => writeAll({ ...readAll(), [k]: v }),
  removeItem: async (k) => {
    const all = readAll();
    delete all[k];
    writeAll(all);
  },
};

const appStateHandlers = new Set();
const AppState = {
  currentState: "active",
  addEventListener: (_t, h) => {
    appStateHandlers.add(h);
    return { remove: () => appStateHandlers.delete(h) };
  },
  __emit(next) {
    AppState.currentState = next;
    for (const h of appStateHandlers) h(next);
  },
};
const Platform = { OS: "ios", Version: "18.0", constants: { osVersion: "18.0", systemName: "iOS", interfaceIdiom: "phone" } };
const reactNative = { AppState, Platform, View: () => null };

// React Native's global error hook.
let globalHandler = (e, isFatal) => {
  console.log(`[default ErrorUtils handler] isFatal=${isFatal}: ${e && e.message}`);
  if (typeof globalThis.__onDefaultErrorHandler === "function") globalThis.__onDefaultErrorHandler(e, isFatal);
};
globalThis.ErrorUtils = {
  getGlobalHandler: () => globalHandler,
  setGlobalHandler: (h) => {
    globalHandler = h;
  },
};
// Hermes promise rejection tracker.
globalThis.HermesInternal = {
  hasPromise: () => true,
  enablePromiseRejectionTracker: ({ onUnhandled }) => {
    process.on("unhandledRejection", (reason) => onUnhandled(0, reason));
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "react-native") return reactNative;
  if (request === "@react-native-async-storage/async-storage") return { default: AsyncStorage, __esModule: true };
  return originalLoad.call(this, request, parent, isMain);
};
