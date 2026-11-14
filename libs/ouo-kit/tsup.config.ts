import { defineConfig } from 'tsup';

// One ESM entry and its types. React and rrweb-player (with its stylesheet import) stay
// external: the app's bundler resolves them, so the app shares one React.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  external: ['react', 'rrweb-player', /^rrweb-player\//],
});
