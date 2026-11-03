import { readFile } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";

/**
 * Build-time patch of the bundled rrweb recorder (`@rrweb/record` 2.2.0, the latest; the fix,
 * rrweb-io/rrweb#1964, is not released): its snapshot loads and observes an
 * iframe's document even when the iframe is blocked. rrweb's prototype check always fails on
 * Safari (it requires `ShadowRoot.prototype.getSelection` and lists Element methods as
 * accessors), so on Safari rrweb keeps two hidden helper iframes in the page; at every checkout
 * the snapshot attached a new set of observers to them, released only on stop (+2 observers,
 * +2 listeners every 5 min in the soak). Blocked iframes (rrweb's helpers are, see
 * `ALWAYS_BLOCKED` in src/replay/recorder.ts) now keep their content out of the recording, which
 * is also what blocking means for privacy. Fails the build if the patched code changes.
 */
const RRWEB_BLOCKED_IFRAME = {
  find: 'if (serializedNode.type === NodeType.Element && serializedNode.tagName === "iframe") {',
  replace: 'if (recordChild && serializedNode.type === NodeType.Element && serializedNode.tagName === "iframe") {',
};
const patchRrweb = {
  name: "ouo-rrweb-blocked-iframes",
  setup(build: { onLoad(o: { filter: RegExp }, cb: (a: { path: string }) => Promise<{ contents: string; loader: "js" }>): void }) {
    build.onLoad({ filter: /[\\/]@rrweb[\\/]record[\\/]dist[\\/]record\.js$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const count = source.split(RRWEB_BLOCKED_IFRAME.find).length - 1;
      if (count !== 1) throw new Error(`rrweb patch: expected 1 occurrence in ${path}, found ${count}; review tsup.config.ts`);
      console.log("ouo: rrweb patched (blocked iframes)", path);
      return { contents: source.replace(RRWEB_BLOCKED_IFRAME.find, RRWEB_BLOCKED_IFRAME.replace), loader: "js" };
    });
  },
};

/**
 * Syntax floor of the published bundle: ES2022 as these engines ship it (class fields, private
 * methods, static blocks, `??=`). Older engines would fail to parse the app bundle that includes
 * the SDK, so CI checks the output with es-check (`npm run compat:check`). The supported
 * browsers, a narrower set, are in README.md ("Compatibility and safety").
 */
export const BROWSER_TARGET = ["es2022", "chrome94", "edge94", "firefox93", "safari16.4", "ios16.4"];

const common: Options = {
  format: ["esm"],
  platform: "browser",
  target: BROWSER_TARGET,
  dts: true,
  sourcemap: true,
  treeshake: true,
  // terser, not esbuild's minifier: about 5 % smaller gzip (41.7 against 44.0 KB for the core
  // entry), which pays for the page-safety guards within the size budget.
  minify: "terser",
  // `sourceMap` makes tsup chain terser's map onto esbuild's; without it the published .map is the
  // pre-terser one and maps nothing on the minified line.
  terserOptions: { module: true, compress: { passes: 2 }, sourceMap: true },
  outDir: "dist",
};

// Two builds with the same output layout as one: dist/index.js plus its lazily loaded rrweb
// chunk, and dist/react.js. They share no code (the React entry imports the SDK by its package
// name), so splitting them only lets the React entry carry its own banner.
export default defineConfig([
  {
    ...common,
    entry: { index: "src/index.ts" },
    splitting: true,
    clean: true,
    // Everything is bundled so the consumer gets one entry plus a lazily loaded rrweb chunk.
    noExternal: [/.*/],
    esbuildPlugins: [patchRrweb],
  },
  {
    ...common,
    entry: { react: "src/react/index.ts" },
    splitting: false,
    clean: false,
    // esbuild's tree shaking and minifier only: tsup's rollup pass and terser drop module
    // directives such as the banner.
    treeshake: false,
    minify: true,
    // React (a peer dependency) and the SDK itself stay external, so the entry shares the app's
    // React and the one `initRUM` instance.
    external: ["react", "@ouo11y/browser"],
    noExternal: [/^(?!react$|react\/|@ouo11y\/browser$).*/],
    // A client module for React Server Components (Next.js App Router): an error boundary is a
    // class component and the route hook uses effects, so both run on the client.
    banner: { js: '"use client";' },
  },
]);
