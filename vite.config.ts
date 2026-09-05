import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    lineWidth: 100,
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    // `scripts/check-types-consumer` imports `dist/`, which does not exist until
    // `build` has run, so type checking it here would make `vp check` depend on a
    // build artifact and fail on a fresh clone. It has its own tsconfig and its own
    // script, `check:types-consumer`, which CI runs after `build`; that is where it
    // is checked. Formatting still covers it, because `fmt` reads no types.
    ignorePatterns: ["scripts/check-types-consumer/**"],
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
    // The public types name `Symbol.dispose`, which only exists in the
    // `esnext.disposable` lib. Consumers targeting `ES2022`..`ES2024` don't have
    // it, and with `skipLibCheck: false` our declarations would fail to compile
    // for them. The reference pulls the lib in from the declaration file itself,
    // so nobody has to widen their own `lib` to use this package.
    banner: { dts: '/// <reference lib="esnext.disposable" />' },
  },
  // Two suites, because they answer different questions. The Node suite drives
  // the code through fake ports and covers the logic exhaustively; the browser
  // suite runs a handful of cases against a genuine SharedWorker in Chromium,
  // where the things a fake can't fake — one process shared by two ports, the
  // `(scriptURL, name)` identity, a closed port — are real.
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "src/**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            // Nothing here renders, so a screenshot of a failure would only ever
            // be a blank page written into the source tree.
            screenshotFailures: false,
            // Chromium alone: Chrome is the primary target, and the suite is
            // checking our own worker plumbing rather than per-engine SharedWorker
            // behaviour. Safari has no SharedWorker at all, which is the case the
            // no-op fallback covers in the Node suite.
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
