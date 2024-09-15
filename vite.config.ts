import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  base: "./",
  build: {
    outDir: "./dist",
    lib: {
      formats: ["es"],
      entry: "./src/index.ts",
    },
  },
  plugins: [dts()],
  worker: {
    format: "es",
  },
});
