import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:7681",
      "/ws": { target: "ws://localhost:7681", ws: true },
    },
  },
});
