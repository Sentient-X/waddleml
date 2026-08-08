import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `__dirname` only exists under Vite's bundle config loader, and that loader cannot
// read this file's `@sx/ui` import (the package ships raw TypeScript, so Node is handed
// a .ts). The runner loader reads the import fine but evaluates as ESM — hence the
// standard ESM spelling, which is correct under both.
const here = path.dirname(fileURLToPath(import.meta.url));

import { PLATFORM_SURFACES } from "@sx/ui/platform.gen";
import { sxObservability } from "@sx/observability/vite";

// Port and API proxy come from the platform registry (sx_platform → platform.gen.ts).
const surface = PLATFORM_SURFACES.find((s) => s.id === "autonomy-training");
if (!surface) throw new Error("autonomy-training missing from @sx/ui platform.gen");

export default defineConfig({
  plugins: [sxObservability({ service: "waddle-ui" }), react()],
  resolve: {
    alias: { "@": path.resolve(here, "./src") },
  },
  server: {
    port: surface.devPort,
    strictPort: true,
    proxy: {
      "/api": surface.apiDevUrl,
    },
  },
});
