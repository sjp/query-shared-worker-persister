import { defineConfig } from "vite-plus";
import dts from "unplugin-dts/vite";

export default defineConfig({
  fmt: {
    lineWidth: 100,
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
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
