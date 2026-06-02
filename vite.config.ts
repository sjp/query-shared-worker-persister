import { defineConfig } from "vite";
import dts from "unplugin-dts/vite";

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
