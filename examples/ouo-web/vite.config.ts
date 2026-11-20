import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// VITE_RUM_STUB=1 maps @ouo11y/browser to a local console-logging stub so the
// storefront builds and runs before (or without) the real SDK package.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "VITE_") };
  const useStub = env.VITE_RUM_STUB === "1";
  return {
    plugins: [react()],
    server: { port: 5173, host: "localhost" },
    // Minified with source maps that the bundle does not reference ("hidden"): scripts/run.sh
    // injects debug ids, uploads the maps to Muninn and deletes them before serving (ADR-0026).
    build: { sourcemap: "hidden" },
    preview: { port: 4173 },
    resolve: {
      alias: useStub
        ? {
            "@ouo11y/browser/react": fileURLToPath(new URL("./src/rum-react-stub.ts", import.meta.url)),
            "@ouo11y/browser": fileURLToPath(new URL("./src/rum-stub.ts", import.meta.url)),
          }
        : {},
    },
    define: {
      __OUO_RUM_STUB__: JSON.stringify(useStub),
    },
  };
});
