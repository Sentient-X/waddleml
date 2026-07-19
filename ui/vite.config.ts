import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5179,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8400",
      // The launch form talks to train serve, a separate backend.
      "/train-api": {
        target: "http://localhost:8500",
        rewrite: (p) => p.replace(/^\/train-api/, ""),
      },
    },
  },
});
