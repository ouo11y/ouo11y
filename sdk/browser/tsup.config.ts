import { defineConfig, type Options } from "tsup";

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
  minify: true,
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
  },
  {
    ...common,
    entry: { react: "src/react/index.ts" },
    splitting: false,
    clean: false,
    // esbuild's tree shaking only: tsup's rollup pass drops module directives such as the banner.
    treeshake: false,
    // React (a peer dependency) and the SDK itself stay external, so the entry shares the app's
    // React and the one `initRUM` instance.
    external: ["react", "@ouo11y/browser"],
    noExternal: [/^(?!react$|react\/|@ouo11y\/browser$).*/],
    // A client module for React Server Components (Next.js App Router): an error boundary is a
    // class component and the route hook uses effects, so both run on the client.
    banner: { js: '"use client";' },
  },
]);
