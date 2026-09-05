# @sjpnz/query-shared-worker-persister

Quickly improve performance in your web application by sharing a query cache across multiple tabs and windows.

## Introduction

This package allows [Tanstack Query](https://tanstack.com/query/latest) state to be persisted using a [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker). When a new tab or window is opened, its query cache can be populated with queries from another window.

### Features

- Share a query cache between tabs and windows
- Reduce redundant network calls
- Simple configuration and setup
- Easy performance wins

A common use case is for access tokens. There is rarely a need for fetching a separate token for each new window. A shared query cache via `SharedWorker` will greatly improve application startup as a result.

### Demo

A simple demo app has been published that demonstrates desired caching behaviour here: <https://sjp.co.nz/projects/query-shared-worker-persister/demo>

The source for the react application is available on [GitHub](https://github.com/sjp/query-shared-worker-demo)

## Getting Started

### Installation

Install the package in your project using `npm`, alongside Tanstack Query's persistence package for React:

```shell
npm install @sjpnz/query-shared-worker-persister @tanstack/react-query-persist-client @tanstack/query-async-storage-persister
```

`@tanstack/query-async-storage-persister` and `@tanstack/query-persist-client-core` are peer dependencies: this
package's public types are expressed in terms of them, so your project supplies the single copy that has to match
your TanStack Query version. `@tanstack/react-query-persist-client` already brings in
`@tanstack/query-persist-client-core`, and npm installs missing peers automatically, so the command above is usually
all that is needed.

The recommended cross-tab broadcasting plugin is a separate, optional install:

```shell
npm install @tanstack/query-broadcast-client-experimental
```

### Bundler requirements

The worker ships as a second file, `dist/cache.worker.js`, and the bundle loads it with

```javascript
new SharedWorker(new URL("./cache.worker.js", import.meta.url), { type: "module" });
```

Your bundler has to recognise that pattern _inside a dependency in `node_modules`_, copy the file into your output, and rewrite the URL to point at the copy. Vite and webpack 5 do this, as do bundlers built on the same convention (Rspack, Parcel 2). Plain esbuild, older bundlers, and serving the package straight from `node_modules` with no build step do not: the URL then resolves to something that isn't there.

Two more constraints on the emitted file:

- **It must be served from the same origin as your page.** A cross-origin worker script cannot be loaded at all, and sharing is per-origin anyway, so a copy on a separate asset domain gets you nothing. If your build uploads assets to a CDN on another origin, use `workerUrl` below to point at a same-origin copy.
- **Its URL is half the worker's identity.** Tabs share a store only while they load the worker from the same URL and under the same name — see [Which tabs share a worker](#which-tabs-share-a-worker).

Worth checking in both your dev server and a production build: dependencies are resolved differently in each, so the asset can be emitted correctly by one and not the other.

If the worker asset isn't there, the browser reports the load failure and the persister treats it as terminal — the error is logged once, and every request from then on fails immediately rather than waiting out its timeout (see [Browser Support](#browser-support)). Queries still work; nothing is persisted or shared.

#### Hosting the worker yourself

For builds that can't trace the asset, copy `cache.worker.js` into whatever you serve and name it with `workerUrl`:

```typescript
export const persister = createSharedWorkerPersister({
  workerUrl: "/static/cache.worker.js",
});
```

```shell
cp node_modules/@sjpnz/query-shared-worker-persister/dist/cache.worker.js public/static/
```

The package also exports the subpath `@sjpnz/query-shared-worker-persister/cache.worker.js`, so a copy step that resolves rather than hard-codes a path — `import.meta.resolve("@sjpnz/query-shared-worker-persister/cache.worker.js")`, or a bundler plugin doing the same — keeps working if the published layout changes.

It is an ES module and must be served as JavaScript. Every app that should share a store has to pass the same `workerUrl`, and changing it between deployments starts a fresh, empty worker — the same trade-off a content-hashed asset URL brings; [How sharing works](#how-sharing-works) covers what that means for open tabs.

### Configuration

Follow these steps to configure `QueryClient` persistence. The examples build on each other, and use React; a similar approach applies to other frameworks.

1. Create a `QueryClient` and `SharedWorker` persister in a module your app can import, for example `query-client.ts`:

   ```typescript
   // query-client.ts
   import { QueryClient } from "@tanstack/react-query";
   import { createSharedWorkerPersister } from "@sjpnz/query-shared-worker-persister";

   export const queryClient = new QueryClient();
   export const persister = createSharedWorkerPersister();
   ```

   Set a `staleTime` on this client before you go any further — with the default of `0` every query refetches immediately on mount and nothing is served from the shared cache. See [Configure `staleTime` for your queries](#recommendations) below.

2. (Recommended) Use a [`broadcastQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/broadcastQueryClient):

   [`broadcastQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/broadcastQueryClient) mirrors cache updates between open tabs over a `BroadcastChannel`. This persister stores one serialised cache per `key` and reads it only once, at startup, so broadcasting is what keeps the tabs' caches in step and stops them from overwriting each other's persisted data. Treat it as part of the setup rather than optional polish, and read [How sharing works](#how-sharing-works) before deciding to go without it.

   The plugin is framework-agnostic and, in Tanstack's own terms, experimental — its API may change in a minor release.

   ```typescript
   // query-client.ts
   import { broadcastQueryClient } from "@tanstack/query-broadcast-client-experimental";

   broadcastQueryClient({ queryClient });
   ```

3. Render your app inside a [`PersistQueryClientProvider`](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient#persistqueryclientprovider):

   Pass the persister through `persistOptions`. The provider holds off rendering its children until the cache has been restored, so the first render already sees the shared data.

   ```tsx
   // App.tsx
   import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
   import { persister, queryClient } from "./query-client";

   const persistOptions = { persister };

   export default function App() {
     return (
       <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
         <h1>Hello, world!</h1>
         {/* Your app components */}
       </PersistQueryClientProvider>
     );
   }
   ```

### Other frameworks

Outside React, wire the same persister up imperatively with [`persistQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient#persistqueryclient) from `@tanstack/query-persist-client-core`. Restoration is asynchronous, so await it before rendering anything that reads from the cache:

```typescript
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { persister, queryClient } from "./query-client";

const [unsubscribe, restored] = persistQueryClient({
  queryClient,
  persister,
});

await restored;

// later, to stop persisting further updates:
unsubscribe();
```

### Per-query persistence

By default the persister serialises the whole dehydrated cache under a single key, so the last tab to write wins and everything another tab had cached is replaced (see [How sharing works](#how-sharing-works)). TanStack's experimental per-query persister avoids that by storing one key per query hash, which suits a shared store much better: two tabs caching different queries add to the same store instead of overwriting each other.

Pass the storage (not the persister) to `experimental_createQueryPersister`:

```typescript
// query-client.ts
import { QueryClient } from "@tanstack/react-query";
import { experimental_createQueryPersister } from "@tanstack/query-persist-client-core";
import { createSharedWorkerStorage } from "@sjpnz/query-shared-worker-persister";

const storage = createSharedWorkerStorage();

export const queryPersister = experimental_createQueryPersister({
  storage,
  // Every key this persister writes starts with `prefix`; give each app its own
  // so apps sharing a worker don't restore each other's queries.
  prefix: "MY_AWESOME_APP",
  maxAge: 1000 * 60 * 60, // discard anything older on restore
});

export const queryClient = new QueryClient({
  defaultOptions: { queries: { persister: queryPersister.persisterFn } },
});
```

`persisterFn` only restores a query when that query is actually used, so it fills the cache lazily. To have the shared cache present from the first render — the point of sharing it across tabs — restore everything up front and await it before rendering:

```typescript
await queryPersister.restoreQueries(queryClient);
```

Use this _instead of_ `PersistQueryClientProvider` and `createSharedWorkerPersister`, not alongside them; running both persists the same data twice under different keys. Note that this API is marked experimental by TanStack and its shape may change in a minor release.

## How sharing works

The worker holds one in-memory store, shared by every tab connected to it. What that store does and does not synchronise is worth knowing before you rely on it:

- **One value per key, written by whichever tab saved last.** `createSharedWorkerPersister` serialises the entire dehydrated `QueryClient` into a single string under its `key`, and each save replaces the previous value outright. A tab holding only queries A and B overwrites an entry that also held C.
- **Restoring is a one-shot read at startup.** A tab reads the shared value once, while persistence is being set up, and never again. Anything another tab writes afterwards does not reach it, so the benefit is that a new tab starts warm rather than that open tabs stay in sync. Live sync is what `broadcastQueryClient` adds: with the in-memory caches kept in step, tabs write near-identical values instead of clobbering each other.
- **A restore that doesn't produce a usable cache clears the entry for everyone.** `persistQueryClient` calls `removeClient()` when the `buster` doesn't match or when `maxAge` has elapsed. Because the store is shared, one tab making that call empties the entry every other tab is using. A read that merely _fails_ is deliberately kept out of that group — see [When a read fails](#when-a-read-fails).
- **Access tokens are no exception.** Sharing a token across tabs is the headline use case, and it is subject to the same overwrites and clears as any other query: a tab whose own cache no longer holds the token will persist a value without it.

Whether a deployment carries the cache across depends on the worker asset's URL, because that URL is part of the worker's identity (see [Which tabs share a worker](#which-tabs-share-a-worker)). If a deployment changes it — a content hash, typically — tabs opened afterwards connect to a fresh worker and start with an empty store, while already-open tabs keep talking to the old one; the two versions then don't share anything. If the URL is unchanged, old and new tabs are on the same worker during a rolling deployment: keep `buster` stable across versions whose cached shapes are compatible, so an older tab doesn't wipe an entry the newer ones just filled — or accept the wipe and let the next writer refill it.

[Per-query persistence](#per-query-persistence) avoids the whole-cache overwrite entirely: each query gets its own key, so tabs caching different queries add to the shared store instead of replacing each other's work, and an expired or unreadable entry drops only that query.

### Which tabs share a worker

A `SharedWorker` is identified by its script URL _and_ its name, and the script URL here is the worker asset your bundler copies into your output. Two applications built separately on one origin normally serve that asset from different (usually content-hashed) URLs, so they already get separate workers and separate stores without doing anything. Sharing happens when applications serve the _same_ worker file — a shell and micro-frontends built together, for instance — and that is what [`namespace`](#recommendations) exists for: it changes the worker's name so those applications get a worker each.

## Security considerations

The shared store is readable by any script on the origin. Nothing about the worker restricts an entry to the application that wrote it: same-origin code can open the same worker with `new SharedWorker(sameUrl, { name: "TANSTACK_QUERY_SHARED_CACHE_WORKER:MY_APP" })` and read every key in it, `namespace` or not. `namespace` is a collision guard, not an access boundary — the protection you get is `localStorage`'s, a store scoped to an origin rather than a private one.

Treat it accordingly: don't persist anything you would not put in `localStorage`. Access tokens are the headline use case for this package and are a reasonable fit wherever you would already accept them in `localStorage`, but that is a decision worth making deliberately rather than inheriting from the example. To keep particular queries out of the shared store, exclude them with TanStack's `shouldDehydrateQuery`, or strip them in the persister's `serialize` hook.

## Browser Support

This package relies on [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker), which is available in modern desktop browsers but **not** in some environments such as Chrome on Android and certain in-app webviews.

The worker is a module worker (`{ type: "module" }`), which browsers gained separately from — and later than — `SharedWorker` itself. Any browser current enough to matter has both, but a browser with `SharedWorker` and no module-worker support fails to start the worker rather than falling back, and is handled as a load failure below.

When `SharedWorker` is unavailable, the persister degrades gracefully to a no-op storage: TanStack Query keeps working with its normal in-memory cache, just without cross-tab persistence. A single warning is reported so the fallback is visible during development, and `createSharedWorkerStorage` marks the storage it hands back `mode: "noop"`.

The same fallback covers a `SharedWorker` that exists but refuses to be constructed — an opaque-origin document (a sandboxed iframe without `allow-same-origin`, or a `blob:`, `data:` or `file:` page), or a privacy mode or enterprise policy that disables workers. `isSharedWorkerSupported()` only reports that the API is present, so it returns `true` in those environments; construction is attempted, the error is reported as a warning, and you get the no-op storage rather than a throw at startup.

A worker that is available but fails to _start_ is a different matter — the usual cause is the worker asset not being copied into your bundle output, so its URL 404s. That failure is treated as terminal: the error is reported once, and every request from then on is answered immediately rather than hanging until the request timeout. Writes reject, so the failure reaches `createAsyncStoragePersister`'s `retry` hook and your own error handling; reads resolve empty, for the reason below.

If you'd rather branch on support yourself — for example to skip wiring up persistence entirely — use the exported check:

```typescript
import {
  createSharedWorkerPersister,
  isSharedWorkerSupported,
} from "@sjpnz/query-shared-worker-persister";

const persister = isSharedWorkerSupported() ? createSharedWorkerPersister() : undefined;
```

### Disposal

Most apps keep a single persister for the page's lifetime and never need to dispose it. If you do recreate the persister (for example in tests, micro-frontends, or hot-module reloads), release the underlying SharedWorker connection when you're done:

```typescript
const persister = createSharedWorkerPersister();

// later, to tear it down:
persister.dispose();
```

`createSharedWorkerStorage` has the same `dispose()`. Either way it settles whatever is in flight and closes the port, it is idempotent, and afterwards writes reject at once and reads resolve empty.

For a connection whose life is one block — a test, a script — declare it with `using` and it is disposed on the way out:

```typescript
{
  using persister = createSharedWorkerPersister();
  await persister.persistClient(client);
} // disposed here
```

`using` needs TypeScript 5.2 or later to compile, and `Symbol.dispose` to exist at runtime. On a browser too old to have it, either apply the polyfill TypeScript documents (`Symbol.dispose ??= Symbol("Symbol.dispose")`, before the storage is created) or just call `dispose()` — it is the same teardown.

Your `tsconfig` needs no extra `lib` entry for any of this. The package's declarations pull in `esnext.disposable` themselves, so they type check against a plain `lib: ["ES2022", "DOM"]` even with `skipLibCheck` off.

When the lifetime is already governed by an `AbortSignal`, pass it instead and disposal follows the abort — an already-aborted signal disposes immediately:

```typescript
const controller = new AbortController();
const persister = createSharedWorkerPersister({ signal: controller.signal });

// later, to tear it down:
controller.abort();
```

### Request timeout

Every read and write waits up to 10 seconds for the worker to answer, after which the write rejects and the read resolves empty ([why](#when-a-read-fails)). Pass `timeoutMs` to change that — raise it if the worker starts slowly on your pages (a heavy first paint, or a throttled background tab), lower it if you would rather give up on the cache quickly and let the network serve the first render:

```typescript
const persister = createSharedWorkerPersister({ timeoutMs: 2_000 });
```

The same option is available on `createSharedWorkerStorage` if you are wiring the storage up yourself.

The value must be greater than `0` and at most `2147483647` — about 24.8 days, the longest delay a timer can hold — or `Infinity`, which means no timeout at all: the request waits for the worker's answer however long it takes, and is otherwise only settled by a transport failure or by disposal. Anything else, including `0`, a negative number, `NaN` and any finite value past that limit, throws a `RangeError` when the persister or storage is created. Each of those would otherwise be handed to a timer that fires immediately, so every request would fail on the next tick — writes rejecting and reads resolving empty — and the cache would look permanently cold rather than misconfigured.

### When a read fails

Reads never reject. A `getItem` or `entries` the worker can't answer — a timeout, a worker that never started, an unreadable reply — resolves as though the store were empty, and reports a warning saying why.

That is deliberate, and it is about the store being shared. `persistQueryClient` treats a restore that throws as a corrupt cache, and responds by calling `removeClient()`; here that deletes the entry inside the worker, which is the entry every other tab is living off. So a tab that was only slow to read — a heavy page, a tab throttled in the background, a worker starting while the machine is busy — would not just fail to warm itself, it would erase everyone else's cache. Resolving empty keeps the damage local: that tab fetches from the network, and the shared store is left alone.

Writes still reject, so a save that didn't reach the worker reaches your `retry` hook and your error handling. And a genuine invalidation still clears the entry for everyone: a `buster` mismatch or an elapsed `maxAge` never goes through a failed read.

If your application wants to know that the cache was unreachable, take the report through [`onError`](#diagnostics); the value itself is indistinguishable from a cold cache by design.

### Diagnostics

Warnings and errors go to the console by default. Pass `onError` to take them instead — to a structured logger, an error reporter, or a `() => {}` if you want them gone. Nothing is written to the console once you do.

```typescript
const persister = createSharedWorkerPersister({
  onError: (error) => {
    if (error.code === "unsupported") analytics.track("cache_not_shared");
    else logger.warn(error.message, { code: error.code, cause: error.cause });
  },
});
```

Every failure this package raises is a `SharedWorkerStorageError` with a `code`, so you can branch on the cause rather than match on the message:

| `code`        | What happened                                                                                     | Reported             |
| ------------- | ------------------------------------------------------------------------------------------------- | -------------------- |
| `unsupported` | No `SharedWorker`, or the constructor refused; the storage is the no-op one and persists nothing. | Yes                  |
| `transport`   | The worker failed after construction (terminal), or sent a message that couldn't be deserialized. | Yes                  |
| `timeout`     | The worker didn't answer within `timeoutMs`.                                                      | If it stopped a read |
| `protocol`    | The worker answered with an error, or with a result that doesn't fit the request.                 | If it stopped a read |
| `disposed`    | The call came after `dispose()`, or after the signal aborted.                                     | If it stopped a read |

The same errors reach you as the rejection of a failed write, so a `retry` hook can read `code` too. Reads never reject ([why](#when-a-read-fails)), which is exactly why a failed read is reported: the error that stopped it is the report's `cause`, and the report carries that error's `code`. A write is not reported separately — its rejection already carries the error — and a terminal worker failure is reported once, no matter how many calls follow it.

`onError` is diagnostic only: it never changes how a call settles, and that holds even when your handler throws. A throw from it is caught and written to the console together with the error it was given, and the read, write or worker failure that reported carries on exactly as it would have — a reporter that is itself broken can't turn a read into a rejection or leave a failed worker half-shut-down.

To check synchronously whether persistence is live at all, read `mode` on the storage:

```typescript
const storage = createSharedWorkerStorage();
if (storage.mode === "noop") {
  // SharedWorker is missing or refused: nothing will be persisted or shared.
}
```

## API

Two entry points: `createSharedWorkerPersister` for the usual whole-cache setup, and `createSharedWorkerStorage` for the storage on its own — the lower-level building block, and what [per-query persistence](#per-query-persistence) needs.

### `createSharedWorkerPersister(options?)`

Builds a SharedWorker-backed storage and wraps it in TanStack's [`createAsyncStoragePersister`](https://tanstack.com/query/latest/docs/framework/react/plugins/createAsyncStoragePersister). Returns a `Persister` to pass as `persistOptions.persister`.

Every `createAsyncStoragePersister` option except `storage` is forwarded untouched, alongside the three this package adds:

| Option         | Type                                                              | Default                       | Purpose                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`          | `string`                                                          | `"REACT_QUERY_OFFLINE_CACHE"` | The entry the whole dehydrated cache is stored under. Give each application its own; see [Recommendations](#recommendations).                                                                                          |
| `throttleTime` | `number`                                                          | `1000`                        | Milliseconds to coalesce saves over.                                                                                                                                                                                   |
| `serialize`    | `(client: PersistedClient) => string \| Promise<string>`          | `JSON.stringify`              | Also the place to strip queries you don't want in a store any same-origin script can read; see [Security considerations](#security-considerations).                                                                    |
| `deserialize`  | `(cached: string) => PersistedClient \| Promise<PersistedClient>` | `JSON.parse`                  | Inverse of `serialize`.                                                                                                                                                                                                |
| `retry`        | `AsyncPersistRetryer`                                             | —                             | Called when a save fails, to shrink the client and try again.                                                                                                                                                          |
| `namespace`    | `string`                                                          | —                             | Give this app a worker, and therefore a store, of its own; see [Which tabs share a worker](#which-tabs-share-a-worker).                                                                                                |
| `timeoutMs`    | `number`                                                          | `10000`                       | How long a read or write waits for the worker before giving up. Greater than `0` and at most `2147483647`, or `Infinity` for no timeout; anything else throws a `RangeError`. See [Request timeout](#request-timeout). |
| `workerUrl`    | `string \| URL`                                                   | —                             | Load the worker from a copy you host, for builds that can't emit the packaged asset; see [Bundler requirements](#bundler-requirements).                                                                                |
| `signal`       | `AbortSignal`                                                     | —                             | Disposes the underlying storage when aborted.                                                                                                                                                                          |
| `onError`      | `(error: SharedWorkerStorageError) => void`                       | console                       | Receives the storage's warnings and errors instead of the console; see [Diagnostics](#diagnostics).                                                                                                                    |

Beyond the `Persister` methods, the returned object carries the storage's teardown:

| Member               | Returns | Notes                                                                                                                            |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `dispose()`          | `void`  | Disposes the storage this persister created: settles in-flight requests, closes the port. Idempotent; see [Disposal](#disposal). |
| `[Symbol.dispose]()` | `void`  | The same call under the well-known symbol, so the persister can be declared with `using`.                                        |

### `createSharedWorkerStorage(options?)`

Returns a `SharedWorkerStorage`: an `AsyncStorage` the shared worker backs, usable anywhere TanStack takes a storage.

| Option      | Type                                        | Default | Purpose                                                                                                                                                                                                           |
| ----------- | ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeoutMs` | `number`                                    | `10000` | Give up on a pending request after this many milliseconds. Greater than `0` and at most `2147483647`, or `Infinity` for no timeout; anything else throws a `RangeError`. See [Request timeout](#request-timeout). |
| `namespace` | `string`                                    | —       | Appended to the worker's name, so apps shipping the same worker asset get a worker each.                                                                                                                          |
| `workerUrl` | `string \| URL`                             | —       | The worker's script URL, replacing the packaged `cache.worker.js`; see [Bundler requirements](#bundler-requirements).                                                                                             |
| `signal`    | `AbortSignal`                               | —       | Calls `dispose()` when aborted; an already-aborted signal disposes immediately.                                                                                                                                   |
| `port`      | `PortAdapter`                               | —       | Carry the protocol over a port you supply instead of constructing a worker; see [Supplying your own port](#supplying-your-own-port).                                                                              |
| `onError`   | `(error: SharedWorkerStorageError) => void` | console | Receives every warning and error instead of the console; see [Diagnostics](#diagnostics).                                                                                                                         |

The returned object:

| Member                | Returns                            | Notes                                                                                                                                                            |
| --------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getItem(key)`        | `Promise<string \| null>`          | `null` when the key is absent, and also when the read fails; see [When a read fails](#when-a-read-fails).                                                        |
| `setItem(key, value)` | `Promise<void>`                    | Replaces any existing value outright; see [How sharing works](#how-sharing-works).                                                                               |
| `removeItem(key)`     | `Promise<void>`                    | Removes the entry for every connected tab.                                                                                                                       |
| `entries()`           | `Promise<Array<[string, string]>>` | Every pair in the store, including entries written by other apps on the same worker. Required by `experimental_createQueryPersister`. Empty when the read fails. |
| `dispose()`           | `void`                             | Settles in-flight requests and closes the port. Idempotent; afterwards writes reject at once and reads resolve empty.                                            |
| `[Symbol.dispose]()`  | `void`                             | The same teardown as `dispose()`, so the storage can be declared with `using`; see [Disposal](#disposal).                                                        |
| `mode`                | `"shared-worker" \| "noop"`        | Whether a transport was established at all. `"noop"` means nothing is persisted; see [Diagnostics](#diagnostics).                                                |

A write rejects with a `SharedWorkerStorageError` if the worker doesn't answer within `timeoutMs`, and rejects immediately once the storage is disposed or the worker has failed; a read resolves empty in all three cases. When `SharedWorker` is missing or refuses to be constructed you get the same shape backed by no-op storage — reads resolve empty and writes are dropped; see [Browser Support](#browser-support).

#### Supplying your own port

`port` takes over from worker construction: give it anything matching `PortAdapter` and the storage talks to that instead, ignoring `namespace` and `workerUrl` and skipping the `SharedWorker` support check and its no-op fallback.

```typescript
import {
  createSharedWorkerStorage,
  type PortAdapter,
  type StorageRequest,
  type StorageResponse,
} from "@sjpnz/query-shared-worker-persister";

const port: PortAdapter = {
  onmessage: null,
  postMessage(request: StorageRequest) {
    const response: StorageResponse = { kind: "response", id: request.id, ok: true, result: null };
    port.onmessage?.({ data: response } as MessageEvent<StorageResponse>);
  },
};

const storage = createSharedWorkerStorage({ port });
```

Every request carries an `id` and is answered by the response with the same `id`, so replies may arrive in any order; a request never answered is left to `timeoutMs`. Anything that isn't a well-formed `StorageResponse` is ignored, since a real shared worker's port is reachable by any same-origin script. `dispose()` calls `close()` on the port when it has one.

This is mainly how the package's own tests drive the storage without a browser, and it is the seam to reach for when testing an application that persists through this package. It is not a plugin point for a different backing store: the worker's semantics — one store shared by every connected tab, last write wins — are what the rest of this document describes.

### `isSharedWorkerSupported()`

`true` when the `SharedWorker` constructor exists. A presence check only: it can't tell you the constructor will succeed, which is why construction failures fall back to no-op storage rather than throwing. See [Browser Support](#browser-support).

### Types

| Type                                 | What it is                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `CreateSharedWorkerPersisterOptions` | The options object above.                                                                            |
| `CreateSharedWorkerStorageOptions`   | The storage options object above.                                                                    |
| `SharedWorkerStorage`                | The storage returned by `createSharedWorkerStorage`.                                                 |
| `SharedWorkerStorageError`           | The error every failure is raised and reported as; a class, so `instanceof` works.                   |
| `SharedWorkerStorageErrorCode`       | The `code` it carries; see [Diagnostics](#diagnostics).                                              |
| `PortAdapter`                        | The port shape `port` accepts: the slice of `MessagePort` this package uses.                         |
| `StorageRequest`, `StorageResponse`  | The messages exchanged over the port, for anyone implementing a `port` or inspecting worker traffic. |
| `StorageResult`, `StorageEntries`    | The payload shapes those messages carry.                                                             |

## Recommendations

To get the most out of this package and ensure optimal performance, consider the following recommendations:

1. Configure `staleTime` for your queries

   Set an appropriate `staleTime` for effective caching. Without it, queries will not be loaded from the cache, negating the benefits of this package.

   See the following links for more details:
   - <https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults>
   - <https://tkdodo.eu/blog/react-query-as-a-state-manager>

   ```typescript
   // query-client.ts
   // Configure all queries to be considered stale after 5 minutes
   const STALE_TIME = 1000 * 60 * 5; // 5 minutes

   export const queryClient = new QueryClient({
     defaultOptions: {
       queries: {
         staleTime: STALE_TIME,
       },
     },
   });
   ```

2. Use a Named Identifier for Your Application

   A unique identifier ensures that the cache remains relevant to your specific application, particularly when there are multiple applications running for a given origin.

   ```typescript
   // query-client.ts
   // Define a unique identifier for your application
   const APP_NAME = "MY_AWESOME_APP";

   // Configure the SharedWorker persister with the app-specific key
   export const persister = createSharedWorkerPersister({
     key: APP_NAME,
   });

   // If using broadcastQueryClient, apply the same identifier
   broadcastQueryClient({
     queryClient,
     broadcastChannel: APP_NAME,
   });
   ```

   Applications that serve the same worker asset share a single `SharedWorker`, and therefore a single in-memory store, with `key` namespacing the entry within it. Pass a `namespace` as well to give this application a worker of its own — it changes the worker's name, so applications shipping the same worker file no longer land in the same store:

   ```typescript
   export const persister = createSharedWorkerPersister({
     key: APP_NAME,
     namespace: APP_NAME, // separate SharedWorker from other apps shipping this worker file
   });
   ```

   Applications built separately usually get separate workers already, because the worker asset's URL differs between their bundles — see [Which tabs share a worker](#which-tabs-share-a-worker). And note that `namespace` does not stop same-origin code from opening the worker and reading it; see [Security considerations](#security-considerations).

3. Implement Cache Busting

   Provide an application version to invalidate the cache when it doesn't match the current application version. This ensures that outdated data isn't persisted when one tab/window has a newer application version than another. Bear in mind that a mismatch clears the shared entry for every connected tab, not just the one that noticed — see [How sharing works](#how-sharing-works).

   Add a `buster` to the `persistOptions` from step 3 above:

   ```tsx
   // App.tsx
   const APP_VERSION = "MY_AWESOME_APP_v1.2.3";

   const persistOptions = {
     persister,
     buster: APP_VERSION,
   };
   ```
