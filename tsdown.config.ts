import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", "cache.worker": "src/worker/cache.worker.ts" },
  platform: "browser",
  format: ["esm"],
  dts: true,
  banner: { dts: '/// <reference lib="esnext.disposable" />' },
  outputOptions: { comments: { legal: true, annotation: true, jsdoc: false } },
  sourcemap: true,
});
