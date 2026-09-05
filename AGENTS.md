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
they meet on in between. Everything under `src/worker/` runs inside the worker process, apart
from `src/worker/protocol.ts`, which is imported by both sides and holds nothing but the
message shapes and their version.

| File                                    | Role                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                          | The public surface. Every export is named individually, so widening it is a deliberate edit.                                      |
| `src/create-shared-worker-persister.ts` | One-call wrapper: builds the storage and hands it to TanStack's async-storage persister.                                          |
| `src/shared-worker-storage.ts`          | The client half. Constructs the worker, correlates requests to responses by `id`, owns timeouts, disposal and the no-op fallback. |
| `src/worker/protocol.ts`                | The wire contract both halves import: the message shapes, and the version they are stamped with.                                  |
| `src/worker/cache.worker.ts`            | The worker entry. Holds the one `CacheStore` and hands each connecting port to `handleConnect`.                                   |
| `src/worker/connection.ts`              | Validates incoming messages and answers them on a port. Transport-shaped but free of worker globals.                              |
| `src/worker/store.ts`                   | The cache: a `Map<string, string>` and the operations over it. No transport, no globals.                                          |
| `src/worker/describe-value.ts`          | Names an arbitrary value for a message or log without throwing on one JSON can't take.                                            |
| `src/test-utils.ts`                     | Fakes shared by the test suites. Not a packaged entry.                                                                            |

User-facing behaviour — what the options mean, what consumers have to do — lives in
`README.md`; this file covers only what you need to change the code.

## Invariants

- **The worker URL expression stays literally `new URL("./cache.worker.js", import.meta.url)`.**
  Bundlers recognise that exact pattern and copy the sibling asset into their output. Hoisting
  it into a variable, joining the path, or computing the specifier defeats that static analysis
  and the worker silently fails to load in consumers' builds.
- **`src/worker/cache.worker.ts` stays a `pack.entry` and stays listed in `sideEffects`.** It
  is the asset the URL above resolves to. Dropping the entry stops it being emitted; dropping
  the `sideEffects` entry lets a bundler tree-shake a file whose whole purpose is its side
  effects. The entry is named `cache.worker` in `pack.entry` because the name, not the source
  path, is what the output file is called; listed by path it would land in `dist/worker/`.
- **`dist/cache.worker.js` imports nothing.** That one file is all a consumer's bundler copies
  out of the package, so anything left beside it does not travel with it. `vp pack` builds both
  entries together, and a module they both import may be emitted as a shared chunk the two of
  them load — whether it is depends on what survives tree-shaking, so it is not something a
  rule of thumb can settle. That is why the worker side keeps its own copy of what it would
  otherwise share with the client half — the log prefix in `src/worker/connection.ts` — instead
  of importing it. `npm run check:package` proves it, by reading the emitted worker and failing
  on any reference to another module; nothing has to be inspected by hand.
- **One store per worker process.** `cache.worker.ts` constructs a single `CacheStore` and every
  connection shares it; that, plus the browser terminating the worker when the last tab closes,
  is the entire lifetime model. There is no persistence to disk and no cleanup to write.
- **`CacheStore` and `handleConnect` never touch worker globals.** They take their port as an
  argument, which is what lets the Node suite drive them directly. Reaching for `self` or
  `postMessage` inside `src/worker/` moves logic into the one file that can only run in a real
  worker.
- **The whole worker half lives in `src/worker/`, and page globals are out of scope there.**
  `src/worker/tsconfig.json` narrows `lib` to the worker's own globals, so `document`, `window`
  and the rest of the DOM are type errors in that directory rather than run-time failures in a
  browser. Moving a worker file out of it puts it back under the root config and gives it the
  DOM again. The tab-side half is checked with the DOM libs and gets no such guard in reverse.
- **Neither side trusts a message's static type.** A SharedWorker is addressable by
  `(scriptURL, name)` from any same-origin script, so both halves check `kind` and every field
  they read before acting. A new operation needs its validation extended alongside it.
- **Reads never reject.** A read the worker can't answer resolves empty, because
  `persistQueryClient` answers a failed restore by clearing the entry — for every tab. Writes
  are free to reject.
- **The worker keeps answering older clients.** A running `SharedWorker` is whichever build
  the first tab to connect loaded, so the two halves are routinely from different releases and
  either one may be the older. Every message carries `PROTOCOL_VERSION`; the worker never
  refuses a request over it, since it may well be the old side and would be turning away the
  tabs it should still serve, and the client compares versions on the response instead. Bump
  the version only for a change that would make one side misread the other, and keep serving
  the shapes an older client sends for as long as that is reasonable — an operation added on
  the worker side alone needs no bump, because an old worker already answers one it doesn't
  know with an error and an old client never sends it.

## Validating changes

`vp check` (also `npm run check`, and `npm run check:fix` to apply fixes) formats, lints and
type checks in one pass. CI runs it via `vp run check`, so formatting drift and lint or type
errors fail the build.

The `build` script keeps its own `tsc` steps in front of `vp pack`. `vp pack` emits
declarations without checking them, so without them a local `npm run build` would happily
produce a package from code that does not type check. CI therefore type checks twice, once in
`check` and once in `build`; the second pass costs little and keeps `npm run build` trustworthy
on its own.

There are two `tsc` invocations because there are two configs. `vp check` type checks each file
under the nearest `tsconfig.json`, so it picks up `src/worker/tsconfig.json` for the worker half
by itself; plain `tsc` reads only the config it is given, which is why `build` names the worker
project as well. Adding another config under `src/` means adding another `tsc -p` alongside it.

`npm run check:package` inspects what will actually be published, in three steps.
`scripts/check-worker-bundle.mjs` reads `dist/cache.worker.js` and fails on a static or dynamic
`import`, a re-export or a `require`, naming the line, which is what holds the "the worker
imports nothing" invariant up. It comes first because it is the cheap one and the one whose
failure a change to the worker's imports is most likely to cause. Then `publint` for manifest
and file-layout mistakes, and `attw` for entry points whose types and runtime code disagree.
All three read build output — the last two off a real `npm pack` tarball — so run `build` first. `attw` runs under its `esm-only` profile
because the package ships ESM only and expects a bundler, so its CommonJS and Node 10
resolution complaints are reported but do not fail the run. CI runs this after `build`.

`npm run check:types-consumer` type checks `scripts/check-types-consumer/consumer.ts`, a
stand-in consumer that imports `dist/` under the narrow `lib` a typical app has and with
`skipLibCheck: false`. It is what proves the `esnext.disposable` reference `vp pack` banners
onto the declarations is doing its job: drop the banner and this fails, while everything else
still passes. Because it reads `dist/`, it only means anything after `build`, which is where
CI runs it.

That import is also why `lint.ignorePatterns` in `vite.config.ts` keeps
`scripts/check-types-consumer` out of `vp check`. `vp check` type checks each file under its
nearest `tsconfig.json`, so it would otherwise check this one too — before `build` has run, in
CI and on a fresh clone alike, and fail on a `dist/` that is not there yet. Formatting still
covers the directory, because `fmt` reads no types. The file is checked once, by its own
script, at the point in the run where `dist/` exists.

## Node versions

Four places name a Node version, and they have to move together:

1. `engines.node` in `package.json`, the floor this repository claims to build and test on,
2. the `node-version` matrix in `.github/workflows/ci.yml`, whose lowest entry is what that
   claim is actually tested against,
3. `node-version` in `.github/workflows/release.yml`, the version the published tarball is
   built on, which must be within the range, and
4. the Node feature version in `.devcontainer/devcontainer.json`, what a contributor gets.

The floor is `>=24` because 24 is the oldest version CI runs `check`, `build`, `check:package`
and `test` on. Lowering `engines` without adding that version to the matrix would be a claim
with nothing behind it; raising the matrix minimum without raising `engines` leaves the floor
untested. The published code runs in the browser, so this range only decides who can work on
the repository and what `npm install` warns about.

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

Every other helper more than one suite needs lives beside it, and nowhere else: the other fake
ports (`createErrorPort`, `createDeadPort`, `createRecordingPort`), the `fakeSharedWorker`
stand-in for the constructor, the `withSharedWorker`, `withDocument` and `withLocation`
environment switches, `recorder` for collecting `onError` reports, `rejectionFrom` for the error
a call rejected with, and `withConsoleSpies`, which silences both console channels around a test
and hands back the spies. The browser suite imports from there too, which is why `rejectionFrom`
takes the class to check against: in that suite it is the built bundle's
`SharedWorkerStorageError` rather than the one the sources export.

The client's Node tests are split by concern, one file to each, so a `describe` block can be
found by its file name:

| File                                               | Covers                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/shared-worker-storage.test.ts`                | Round trips over a port, correlating responses to requests, disposal, protocol versioning. |
| `src/shared-worker-storage.options.test.ts`        | `timeoutMs`, `workerUrl`, and what is handed to the `SharedWorker` constructor.            |
| `src/shared-worker-storage.worker-failure.test.ts` | No `SharedWorker` at all, a worker that never loads, a port that refuses the message.      |
| `src/shared-worker-storage.diagnostics.test.ts`    | Reads that resolve empty, `onError` reports, console output, a reporter that throws.       |
| `src/shared-worker-storage.per-query.test.ts`      | `entriesPrefix`, and TanStack's per-query persister over the storage.                      |

New cases go in the file whose concern they match. All of them are picked up by the Node
project's `src/**/*.test.ts` glob, so adding another needs no configuration.

The browser suite (`src/**/*.browser.test.ts`) runs in headless Chromium through Vitest's
Playwright provider and covers only what a fake port cannot show — one worker process behind
two connections, the `(scriptURL, name)` pair that decides which tabs share a store, what the
browser does with a worker script that doesn't load, a worker that terminates itself once a tab
has connected, and a worker reached through `workerUrl`. That termination case is why
`vite.config.ts` launches the browser with `--enable-blink-features=MessagePortCloseEvent`:
Chromium implements the port's `close` event, the only signal that a running worker has gone,
behind that flag rather than shipping it on. The client needs no flag — a browser that never
fires the event leaves those requests to their timeout, as they always did — but without it the
event cannot be provoked here at all, so the test asserts the event exists before relying on
it.
It loads the package from `dist/`, so the packaging contract is covered too: `npm run build`
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
   date, and start a fresh `Unreleased` section. The file is listed in `files`, so it ships in
   the tarball and the entries written here are what a consumer reads from `node_modules`.
2. Bump `version` in `package.json` (`npm version <major|minor|patch> --no-git-tag-version`
   keeps the lockfile in step).
3. Commit both, then tag the commit `v<version>` and push the commit and the tag.

The tag triggers `.github/workflows/release.yml`, which refuses to go on if the tag and
`package.json` disagree, then runs the same gates as CI (`check:toolchain`, `check`, `build`,
`check:package`, `test`) before `npm publish --provenance --access public`. Authentication is
npm trusted publishing over the job's OIDC token — there is no npm token in repository
secrets, and the package must be configured for trusted publishing against this repository and
workflow on npmjs.com for the publish step to be authorised.

The dist-tag the publish uses is derived from the version, so a prerelease never becomes what
`npm install` hands out. A plain `X.Y.Z` publishes under `latest`; a version with a prerelease
identifier — `0.3.0-beta.1`, `1.0.0-rc.0` — publishes under that identifier (`beta`, `rc`),
falling back to `next` for an identifier npm would not take as a tag, such as the bare numeric
one in `1.0.0-1`. Tagging a prerelease is therefore safe, and consumers reach it with
`npm install <package>@beta` or by version.

Releases before this workflow existed were published by hand and were never tagged, so
`v0.2.0` and earlier have no tag to compare against.
