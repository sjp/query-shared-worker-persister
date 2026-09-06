# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions up to and including 0.2.0 predate this file and were reconstructed from the commit
history, so they summarise the visible behaviour rather than every change.

## [Unreleased]

### Added

- `PROTOCOL_VERSION`, the wire protocol version this build speaks, so a `port` implementation
  that answers requests itself can stamp its responses with it. The client reads a response
  carrying no version as version 1, which is what a build made before the field existed spoke,
  so an unversioned reply works today and stops working the moment the protocol moves past 1; a
  port that forwards to a real worker still passes the field through as it found it.
- `experimental_createSharedWorkerQueryPersister`, a one-call setup for per-query persistence:
  it builds the shared-worker storage and wraps it in TanStack's
  `experimental_createQueryPersister`, and returns that persister with `storage`, `mode`,
  `dispose()` and `[Symbol.dispose]()` attached. It derives the storage's `entriesPrefix` from
  the persister's `prefix` — that prefix plus the `-` TanStack joins keys with, defaulting with
  it — so the two can no longer drift apart, which they did silently: a filter matching nothing
  is a valid listing, so `restoreQueries` restored nothing and `persisterGc` collected nothing
  without an error anywhere. It carries the same `experimental_` prefix as the TanStack function
  it wraps, whose shape may change in a minor release.
- `entries()` on `SharedWorkerStorage`, returning every key/value pair in the shared store, so
  the storage can drive TanStack's per-query persister (`experimental_createQueryPersister`).
- `entriesPrefix` on `createSharedWorkerStorage`, which narrows `entries()` to the keys starting
  with it. TanStack's per-query persister reads the whole store on `restoreQueries`, on each
  garbage-collection pass and on `removeQueries`, then keeps only the keys under its own
  `prefix`; setting this to that prefix keeps every other tab's and every other app's entries
  from being copied across the port only to be discarded. Older workers, which ignore the field,
  still produce the same result: the reply is filtered on arrival as well.
- `timeoutMs` on `createSharedWorkerPersister`, which previously could not configure the
  request timeout that `createSharedWorkerStorage` accepts.
- `workerUrl` on both `createSharedWorkerStorage` and `createSharedWorkerPersister`, for builds
  that cannot copy `cache.worker.js` out of `node_modules` and host the asset themselves. It
  must be on the page's own origin — a cross-origin worker script cannot be loaded, and a store
  is shared per origin in any case — so one that resolves elsewhere throws a `TypeError` when
  the storage or persister is created, and a URL the browser itself refuses is reported naming
  that URL rather than the environment.
- `onError` on both `createSharedWorkerStorage` and `createSharedWorkerPersister`, which takes
  the warnings and errors that previously only went to the console — the no-op fallback, a
  worker that failed, a read that resolved empty — so an application can log or report them
  itself, or silence them. It is diagnostic only: a throw from the handler is caught and
  written to the console alongside the error it was given, and never changes how the call that
  reported settles.
- `SharedWorkerStorageError`, the error every failure is now raised and reported as, carrying a
  `code` of `"unsupported"`, `"transport"`, `"timeout"`, `"protocol"` or `"disposed"` so
  callers can branch on the cause without matching on message text.
- `mode` on `SharedWorkerStorage` and on the persister returned by
  `createSharedWorkerPersister`, `"shared-worker"` or `"noop"`, so degrading to the no-op
  fallback is something code can see rather than only a console warning.
- `port` on `createSharedWorkerPersister`, the same test seam `createSharedWorkerStorage` takes,
  so an application that builds its persister through this function can be driven against an
  in-process store in tests without assembling the storage and persister by hand.
- `PortAdapter` is exported, so the object the `port` option accepts can now be named. The
  protocol types it is written in terms of (`StorageRequest`, `StorageResponse`,
  `StorageResult`, `StorageEntries`) are exported by name rather than wholesale.
- A protocol version on every message between a tab and the worker. A `SharedWorker` runs the
  script the first tab to connect loaded and lives until the last one closes, so a tab on a new
  build can find itself talking to a worker an older build started; the version is what makes
  that legible. A response naming a version this build doesn't speak now fails its request as a
  `"protocol"` error naming both versions — leaving reads to resolve empty — instead of being
  decoded on the chance that it fits. A response carrying no version is read as version 1, so a
  worker built before the field existed still answers, and the worker never turns a request
  away over its version, since it may be the older side of the pair. `README.md` covers what
  this means for a `workerUrl` held stable across deployments, under "Which tabs share a
  worker".
- `./package.json` is exported, so tooling that reads a dependency's manifest through the
  export map can reach it.
- A `default` condition on the package entry, so resolvers whose condition set omits `import`
  still find `dist/index.js`.
- `[Symbol.dispose]()` on `SharedWorkerStorage`, aliasing `dispose()`, so a storage can be scoped
  with a `using` declaration.
- `dispose()` and `[Symbol.dispose]()` on the persister returned by `createSharedWorkerPersister`,
  which previously hid the storage it created and could only be torn down through `signal`. Its
  type is exported as `SharedWorkerPersister`.
- `keywords`, `bugs` and `engines` in the manifest.
- `CHANGELOG.md` ships in the published package, so what changed between versions can be
  read from `node_modules` or a registry file viewer without leaving for the repository.

### Changed

- An error naming a value from a malformed message now quotes at most the first 64 characters of
  a string and gives its length instead of repeating the whole thing. Any same-origin script can
  open the worker, so a message whose `op` or `kind` was megabytes long was answered with a reply
  just as large and logged as one unreadable line, on a process every tab depends on. Shorter
  values are unchanged.
- `@tanstack/query-async-storage-persister` and `@tanstack/query-persist-client-core` are now
  peer dependencies. The published types import from them instead of inlining private copies,
  so a consuming project must have both installed.
- Both TanStack peer ranges are now `^5.80.5`. The `@tanstack/query-persist-client-core` floor
  was `^5.56.2`, which predates the per-query persister this package documents:
  `AsyncStorage.entries` arrived in 5.76.1 and `restoreQueries` in 5.80.5, so a project at the
  declared minimum could not use the `entries()` example at all. The two packages ship in
  lockstep from one repository, so `@tanstack/query-async-storage-persister` moves from
  `^5.100.14` to the same floor rather than keeping a higher one it never needed.
- A worker that goes away after it started — terminated by the browser under memory pressure,
  crashed, killed from devtools, or closing itself — is now noticed instead of being posted to
  in silence. The port reports the closed connection, and it is treated as terminal in the same
  way a worker that never started is: reported once as a `"transport"` error, with every later
  write rejecting and every later read resolving empty. Previously nothing marked the transport
  dead, so every request for the rest of the tab's life waited out the full `timeoutMs` first.
  The signal is the port's `close` event, which not every browser fires yet; where it is
  missing, those requests still fall to their timeout as they did before. Nothing reconnects: a
  caller who wants persistence back builds a new storage or persister, which starts a new worker
  with an empty store.
- A worker that fails to load or start is now terminal: the failure is reported once, the port
  is closed, and every request made afterwards settles immediately with that error — writes
  rejecting, reads resolving empty — instead of each one being posted into the void and waiting
  out the full timeout.
- Requests issued after `dispose()` settle immediately — writes reject, reads resolve empty —
  rather than hanging until the timeout.
- A read that resolved empty only because the storage was disposed is now reported once per
  storage rather than on every call. The first report still says that a released storage is
  being read from; repeating it added nothing, and a per-query persister reading on every query
  mount could fill the console with the same line.
- An unusable `SharedWorker` constructor (one that throws, as in an opaque-origin document) now
  falls back to the same no-op storage used when the API is missing entirely.
- The `"unsupported"` fallback is now reported only where a document exists. A server or edge
  runtime evaluating the module that builds the persister still gets the no-op storage and
  `mode: "noop"`, but nothing is written to the console and `onError` is not called: a server
  never had a `SharedWorker` to lose. A browser that lacks the API — Chrome on Android, some
  webviews — still reports the warning, as does a browser-simulating test environment.
- Both sides of the port validate incoming messages, so a malformed or unknown message is
  answered with an error instead of resolving as `undefined`.
- Every optional option on `createSharedWorkerStorage` and `createSharedWorkerPersister` now
  accepts an explicit `undefined`, so projects built with `exactOptionalPropertyTypes` can pass
  an option they computed conditionally.
- `timeoutMs` is validated when the storage or persister is created, and a value no timer can
  honour — `0`, a negative number, `NaN`, or a finite value above `2147483647` — now throws a
  `RangeError` naming the option and its range. Each of those was previously passed straight to
  `setTimeout`, which fires on them immediately, so every request failed on the next tick and
  the cache looked permanently cold rather than misconfigured.
- `namespace` is validated when the storage or persister is created, and an empty string now
  throws a `TypeError` naming the option. The empty name is the default worker's, so a storage
  created with one joined the very store the option is passed to stay out of — visible only as
  a cache that works while holding another app's entries, rather than as a misconfiguration.
- `timeoutMs: Infinity` means no timeout: the request waits for the worker's answer indefinitely
  and is otherwise settled only by a transport failure or by disposal. It previously overflowed
  the timer's 32-bit delay and timed every request out at once.
- A message from the worker that could not be deserialized is now reported and otherwise left
  alone. It previously also rejected every request in flight, so concurrent writes failed and
  concurrent reads resolved empty for a fault that was not theirs, and each of those reads
  reported the same bad message a second time. The port stays open either way; only the one
  request whose answer was lost is now affected, and it settles at its own timeout.
- A `signal` that has already aborted is now honoured before anything is built: no `SharedWorker`
  is constructed, an injected `port` is left untouched, and nothing is reported about the
  environment. The storage handed back is the one an immediate `dispose()` would have left —
  writes reject with `disposed`, reads resolve empty — and `mode` still names the transport it
  would have used. It previously connected a worker, installed the port handlers and started the
  port, only to tear all of that down again.
- The supported Node range is now `>=24`, raised from `>=20`. It only governs who can build and
  test this repository — the published code runs in the browser — and 24 is the oldest version
  the toolchain and the test suites are actually run on. Node 20 reached end of life in April 2026.
- The published JavaScript no longer carries the JSDoc from the source, and ships source maps
  instead. The documentation is unchanged in the declaration files, which is where an editor
  reads it from; in the runtime files it was more than half the bytes. It cost `cache.worker.js`
  most, because bundlers copy that file out of the package and serve it as published, so its
  comments were fetched on every cold load. `dist/index.js` falls from 24.1 kB to 11.0 kB and
  `dist/cache.worker.js` from 9.8 kB to 4.2 kB, and `dist/index.js.map` and
  `dist/cache.worker.js.map` now lead a stack trace in either file back to the TypeScript it
  came from. The `/* @__PURE__ */` annotations a consumer's bundler tree-shakes by are kept.

### Fixed

- A cache read the worker could not answer resolves as empty rather than as `null`, so a
  timeout in one tab no longer makes TanStack treat the shared store as empty and overwrite it.
- The published declarations reference the `esnext.disposable` lib, so the `[Symbol.dispose]()`
  members no longer fail to compile in projects whose `lib` stops at `ES2022`..`ES2024` and that
  check dependency types with `skipLibCheck: false`.
- A port that refuses to send a request — a real `MessagePort` throws for a value it cannot
  clone — now fails that one request as a `SharedWorkerStorageError` with a `code` of
  `"transport"` and the refusal as its `cause`, and leaves nothing behind. It previously
  rejected with the raw error and kept both the timeout timer and the request's bookkeeping
  entry, so a request that never left the tab was settled a second time at its deadline.
- The worker answers a malformed message whose `kind` or `op` is a `bigint`, a cyclic object or
  any other value that cannot be serialized to JSON. Describing such a value previously threw
  out of the port's message handler, so the worker logged an uncaught exception and the sender
  — which may be any same-origin script addressing the same worker — got no reply at all and
  waited out its full timeout. Handling a message now also contains an unexpected failure of
  any kind: it is logged and, when the message carried a usable `id`, answered as an error.
- `dispose()` takes this package's handler back off the `SharedWorker` object, so a worker
  script that fails to load after the storage was disposed no longer logs or reports a
  `"transport"` error for a storage the caller has already let go of, and no longer keeps that
  storage reachable from the pending failure event. A component that creates a persister and
  unmounts immediately — a double-mount under React StrictMode, or a route that redirects — saw
  that report whenever the worker asset was missing.

## [0.2.0] - 2026-06-03

### Added

- `isSharedWorkerSupported()`, an up-front check for the `SharedWorker` API.
- `namespace`, which changes the worker's name so that apps shipping the same worker asset can
  keep separate stores.
- `signal`, which disposes the storage when the given `AbortSignal` aborts. This is the only way
  to bound the lifetime of storage created through `createSharedWorkerPersister`, which does not
  expose `dispose()`.
- A no-op storage fallback, with a warning, when `SharedWorker` is unavailable. Older and mobile
  browsers no longer crash on startup.
- An error is logged, and every request in flight is rejected, when the worker fails to start or
  sends a message that cannot be deserialized.

### Changed

- `dispose()` closes the underlying `MessagePort` as well as detaching its handler.
- The worker asset is declared as a side effect so bundlers keep it.
- The build moved to Vite+ (`vp pack`/tsdown).

## [0.1.1] - 2026-06-02

### Changed

- Rewritten without [Comlink](https://github.com/GoogleChromeLabs/comlink): the client and the
  worker now exchange plain request/response messages over the port. This replaced the
  `createSharedStorage`/`createSharedWorker` exports with `createSharedWorkerStorage`, and
  removed the runtime dependency along with the proxy-related failures it caused.
- Packaging fixes so that the published bundle and its worker asset resolve in a consuming app.

No 0.1.0 was released.

## [0.0.1-alpha4] - 2024-09-20

### Fixed

- Feature-detect `SharedWorker` in a way that survives server-side rendering, so the package can
  be imported from a Next.js app.

## [0.0.1-alpha3] - 2024-09-15

### Fixed

- Corrected the repository URL in the package metadata.

## [0.0.1-alpha2] - 2024-09-15

### Fixed

- Export the public types, and correct the build configuration used to produce them.

## [0.0.1-alpha1] - 2024-09-15

### Added

- First published release: a TanStack Query persister backed by a `SharedWorker`, so tabs and
  windows on one origin share a query cache.
