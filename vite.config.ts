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
  // Entries are named rather than listed by path because the name is what decides
  // the output filename: the worker source lives in `src/worker/` with the rest of
  // the worker half, and a bare path list would mirror that into `dist/worker/`.
  // Tests aren't entries, so no `*.test.d.ts` ends up in `dist`.
  pack: {
    entry: { index: "src/index.ts", "cache.worker": "src/worker/cache.worker.ts" },
    platform: "browser",
    format: ["esm"],
    // Both entries get declarations, even though the worker has no public
    // surface and its `dist/cache.worker.d.ts` is therefore an empty module.
    // The file still has to exist: the `./cache.worker.js` export has no
    // `types` condition, so TypeScript types it by the declaration sitting
    // beside the JavaScript file, and dropping it leaves that export untyped.
    // Narrowing this to the one entry with a surface (`dts: { entry }`) is
    // what makes it disappear, so don't.
    dts: true,
    // The public types name `Symbol.dispose`, which only exists in the
    // `esnext.disposable` lib. Consumers targeting `ES2022`..`ES2024` don't have
    // it, and with `skipLibCheck: false` our declarations would fail to compile
    // for them. The reference pulls the lib in from the declaration file itself,
    // so nobody has to widen their own `lib` to use this package.
    banner: { dts: '/// <reference lib="esnext.disposable" />' },
    // The JSDoc in the source is public documentation, but the declarations are
    // where a consumer's editor reads it from, so keeping it in the JavaScript
    // as well only pads the files. It costs the worker most: consumers' bundlers
    // copy `cache.worker.js` out of the package and serve it as emitted, so its
    // comments are fetched on every cold load, where `index.js` at least goes
    // through the consumer's minifier. `annotation` has to stay on — the
    // `/* @__PURE__ */` markers rolldown emits are what let a consumer's bundler
    // drop the module-level `Set` in the worker and the like — and `legal` keeps
    // any licence header a dependency asks to carry.
    outputOptions: { comments: { legal: true, annotation: true, jsdoc: false } },
    // Without the comments the emitted JavaScript is further still from the
    // TypeScript it came from, so ship the maps that lead a stack trace back.
    // `files` already covers all of `dist`, so they need no manifest change.
    sourcemap: true,
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
            provider: playwright({
              // A port whose worker has gone away reports it with a `close`
              // event, which the client turns into a terminal transport
              // failure. Chromium implements the event behind this flag rather
              // than shipping it on by default, so the suite asks for it to
              // cover that path against a real worker; the flag becomes a no-op
              // once it ships, and the client needs no flag either way — a
              // browser that never fires the event simply leaves those requests
              // to their timeout, as they were before.
              launchOptions: { args: ["--enable-blink-features=MessagePortCloseEvent"] },
            }),
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
