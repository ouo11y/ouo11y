// Server-side import check of the built bundle (checklist N42), the second half of
// `npm run compat:check` after es-check: both entries import in plain Node (no window, no
// document) and initRUM there is inert, which is what server rendering (Next.js, Remix) does.
if (typeof globalThis.window !== "undefined" || typeof globalThis.document !== "undefined") throw new Error("expected a Node global scope");
const core = await import("../dist/index.js");
await import("../dist/react.js");
const rum = core.initRUM({ endpoint: "http://localhost:4318", projectId: "p", projectToken: "t", service: { name: "ssr", version: "1", environment: "ci" } });
if (rum.session.id() !== "" || core.getRUM() !== undefined) throw new Error("initRUM is not inert on the server");
await rum.flush();
await rum.shutdown();
console.log("ok: entries import in Node and initRUM is inert there");
