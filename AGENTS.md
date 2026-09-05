<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Layout

The package publishes two entries, and the split between them runs through the whole source
tree. The table is in that order: the tab side first, the worker side after, and the protocol
they meet on in between. `src/worker/connection.ts` and `src/worker/store.ts` run inside the
worker process; `src/worker/protocol.ts` is types only and is imported by both sides.

| File                                    | Role                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                          | The public surface. Every export is named individually, so widening it is a deliberate edit.                                      |
| `src/create-shared-worker-persister.ts` | One-call wrapper: builds the storage and hands it to TanStack's async-storage persister.                                          |
| `src/shared-worker-storage.ts`          | The client half. Constructs the worker, correlates requests to responses by `id`, owns timeouts, disposal and the no-op fallback. |
| `src/worker/protocol.ts`                | The wire contract both halves import. No runtime code.                                                                            |
| `src/cache.worker.ts`                   | The worker entry. Holds the one `CacheStore` and hands each connecting port to `handleConnect`.                                   |
| `src/worker/connection.ts`              | Validates incoming messages and answers them on a port. Transport-shaped but free of worker globals.                              |
| `src/worker/store.ts`                   | The cache: a `Map<string, string>` and the operations over it. No transport, no globals.                                          |
| `src/test-utils.ts`                     | Fakes shared by the test suites. Not a packaged entry.                                                                            |

User-facing behaviour — what the options mean, what consumers have to do — lives in
`README.md`; this file covers only what you need to change the code.

## Invariants

- **The worker URL expression stays literally `new URL("./cache.worker.js", import.meta.url)`.**
  Bundlers recognise that exact pattern and copy the sibling asset into their output. Hoisting
  it into a variable, joining the path, or computing the specifier defeats that static analysis
  and the worker silently fails to load in consumers' builds.
- **`src/cache.worker.ts` stays a `pack.entry` and stays listed in `sideEffects`.** It is the
  asset the URL above resolves to. Dropping the entry stops it being emitted; dropping the
  `sideEffects` entry lets a bundler tree-shake a file whose whole purpose is its side effects.
- **One store per worker process.** `cache.worker.ts` constructs a single `CacheStore` and every
  connection shares it; that, plus the browser terminating the worker when the last tab closes,
  is the entire lifetime model. There is no persistence to disk and no cleanup to write.
- **`CacheStore` and `handleConnect` never touch worker globals.** They take their port as an
  argument, which is what lets the Node suite drive them directly. Reaching for `self` or
  `postMessage` inside `src/worker/` moves logic into the one file that can only run in a real
  worker.
- **Neither side trusts a message's static type.** A SharedWorker is addressable by
  `(scriptURL, name)` from any same-origin script, so both halves check `kind` and every field
  they read before acting. A new operation needs its validation extended alongside it.
- **Reads never reject.** A read the worker can't answer resolves empty, because
  `persistQueryClient` answers a failed restore by clearing the entry — for every tab. Writes
  are free to reject.

## Validating changes

`vp check` (also `npm run check`, and `npm run check:fix` to apply fixes) formats, lints and
type checks in one pass. CI runs it via `vp run check`, so formatting drift and lint or type
errors fail the build.

The `build` script keeps its own `tsc` step in front of `vp pack`. `vp pack` emits
declarations without checking them, so without that step a local `npm run build` would
happily produce a package from code that does not type check. CI therefore type checks twice,
once in `check` and once in `build`; the second pass costs little and keeps `npm run build`
trustworthy on its own.

`npm run check:package` inspects what will actually be published: `publint` for manifest and
file-layout mistakes, `attw` for entry points whose types and runtime code disagree. Both work
off a real `npm pack` tarball, so run `build` first. `attw` runs under its `esm-only` profile
because the package ships ESM only and expects a bundler, so its CommonJS and Node 10
resolution complaints are reported but do not fail the run. CI runs this after `build`.

## Tests

`vp test` runs two suites. The Node suite is the bulk of it: it drives the client and the
worker through fake ports, which is where behaviour like timeouts, disposal and malformed
messages can be provoked directly.

The fake port is `createFakePort` in `src/test-utils.ts`. It satisfies the same `PortAdapter`
interface a real `MessagePort` does, and answers each request out of a real `CacheStore` on a
microtask, echoing the request `id` back exactly as the worker would. Pass it as the `port`
option and the whole client is exercised with no worker in sight; hand it a store you built
yourself to start from a known cache, or write a port of your own to provoke what a working
one never does — a response that never arrives, a duplicate `id`, a reply that isn't a
response at all.

The browser suite (`src/**/*.browser.test.ts`) runs in headless Chromium through Vitest's
Playwright provider and covers only what a fake port cannot show — one worker process behind
two connections, and the `(scriptURL, name)` pair that decides which tabs share a store. It
loads the package from `dist/`, so the packaging contract is covered too: `npm run build`
first, or the suite fails saying so. Install the browser once with `npm run playwright:install`.

## Upgrading Vite+

`package.json` aliases `vite` to Vite+'s own fork of it:

```json
"overrides": { "vite": "npm:@voidzero-dev/vite-plus-core@<version>" }
```

The alias exists so that a single copy of the core is installed. Dependabot can bump
`devDependencies.vite-plus`, but it cannot touch `overrides`, so a Vite+ upgrade is only
complete once all three of these agree:

1. `devDependencies.vite-plus`,
2. the version in `overrides.vite`, and
3. the `node_modules/vite` entry in `package-lock.json`.

Prefer `vp migrate`, which re-pins `vite-plus` and the alias together. Otherwise edit the
override by hand, then run `vp install` (not `--frozen-lockfile`) and commit the refreshed
`package-lock.json`. `npm run check:toolchain` verifies all three and runs in CI.

## Releasing

Publishing is done by CI, from a tag. Nothing is published from a developer machine, so the
tarball on npm is always the one GitHub Actions built from a tagged commit, and it carries an
npm provenance attestation pointing back at that commit and workflow run.

To cut a release:

1. Move the `Unreleased` entries in `CHANGELOG.md` under a new version heading with today's
   date, and start a fresh `Unreleased` section.
2. Bump `version` in `package.json` (`npm version <major|minor|patch> --no-git-tag-version`
   keeps the lockfile in step).
3. Commit both, then tag the commit `v<version>` and push the commit and the tag.

The tag triggers `.github/workflows/release.yml`, which refuses to go on if the tag and
`package.json` disagree, then runs the same gates as CI (`check:toolchain`, `check`, `build`,
`check:package`, `test`) before `npm publish --provenance --access public`. Authentication is
npm trusted publishing over the job's OIDC token — there is no npm token in repository
secrets, and the package must be configured for trusted publishing against this repository and
workflow on npmjs.com for the publish step to be authorised.

Releases before this workflow existed were published by hand and were never tagged, so
`v0.2.0` and earlier have no tag to compare against.
