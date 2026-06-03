import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    lineWidth: 100,
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  // Library packaging is handled by `vp pack` (tsdown). The worker is listed as
  // its own entry so it is emitted as a sibling `dist/cache.worker.js`, which the
  // `new URL("./cache.worker.js", import.meta.url)` reference in the bundle then
  // resolves at runtime (see `connectSharedWorker` in shared-worker-storage.ts).
  // Tests aren't entries, so no `*.test.d.ts` ends up in `dist`.
  pack: {
    entry: ["src/index.ts", "src/cache.worker.ts"],
    platform: "browser",
    format: ["esm"],
    dts: true,
  },
});
