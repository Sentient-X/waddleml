import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { PLATFORM_SURFACES } from "@sx/ui/platform.gen";

// Port and API proxy come from the platform registry (sx_platform → platform.gen.ts).
const surface = PLATFORM_SURFACES.find((s) => s.id === "autonomy-training");
if (!surface) throw new Error("autonomy-training missing from @sx/ui platform.gen");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: surface.devPort,
    strictPort: true,
    proxy: {
      "/api": surface.apiDevUrl,
    },
  },
});
