import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = "http://127.0.0.1:7272";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5179,
    proxy: { "/api": { target: api }, "/ws": { target: api, ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800 },
  test: { include: ["core/**/*.test.ts", "src/**/*.test.ts"], environment: "node" },
});
