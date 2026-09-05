# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions up to and including 0.2.0 predate this file and were reconstructed from the commit
history, so they summarise the visible behaviour rather than every change.

## [Unreleased]

### Added

- `entries()` on `SharedWorkerStorage`, returning every key/value pair in the shared store, so
  the storage can drive TanStack's per-query persister (`experimental_createQueryPersister`).
- `timeoutMs` on `createSharedWorkerPersister`, which previously could not configure the
  request timeout that `createSharedWorkerStorage` accepts.
- `workerUrl` on both `createSharedWorkerStorage` and `createSharedWorkerPersister`, for builds
  that cannot copy `cache.worker.js` out of `node_modules` and host the asset themselves.
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

### Changed

- `@tanstack/query-async-storage-persister` and `@tanstack/query-persist-client-core` are now
  peer dependencies. The published types import from them instead of inlining private copies,
  so a consuming project must have both installed.
- A failed transport is now sticky: once a message to the worker cannot be sent, later requests
  settle immediately instead of each waiting out the full timeout.
- Requests issued after `dispose()` settle immediately — writes reject, reads resolve empty —
  rather than hanging until the timeout.
- An unusable `SharedWorker` constructor (one that throws, as in an opaque-origin document) now
  falls back to the same no-op storage used when the API is missing entirely.
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
- A warning when a message to the worker cannot be posted.

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
