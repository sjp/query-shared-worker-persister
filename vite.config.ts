import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "./dist",
    lib: {
      formats: ["es"],
      entry: "./src/index.ts",
    },
  },
  worker: {
    format: "es",
  },
});
