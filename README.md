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

## Contents

- [Getting started](#getting-started) — install, wire it up, and watch two tabs share a cache
  - [1. Install the packages](#1-install-the-packages)
  - [2. Create the query client and the persister](#2-create-the-query-client-and-the-persister)
  - [3. Keep open tabs in step](#3-keep-open-tabs-in-step)
  - [4. Render the app behind the provider](#4-render-the-app-behind-the-provider)
  - [5. See it working](#5-see-it-working)
  - [Where to go from here](#where-to-go-from-here)
- [Security considerations](#security-considerations)
- [Guides](#guides)
  - [Other frameworks](#other-frameworks)
  - [Per-query persistence](#per-query-persistence) · [What the wrapper does with `prefix`](#what-the-wrapper-does-with-prefix)
  - [Bundler requirements](#bundler-requirements) · [Hosting the worker yourself](#hosting-the-worker-yourself)
  - [Browser support](#browser-support) · [Server-side rendering](#server-side-rendering)
  - [Disposal](#disposal)
  - [Request timeout](#request-timeout)
  - [Diagnostics](#diagnostics)
- [API](#api)
  - [`createSharedWorkerPersister(options?)`](#createsharedworkerpersisteroptions)
  - [`experimental_createSharedWorkerQueryPersister(options?)`](#experimental_createsharedworkerquerypersisteroptions)
  - [`createSharedWorkerStorage(options?)`](#createsharedworkerstorageoptions) · [Supplying your own port](#supplying-your-own-port)
  - [`isSharedWorkerSupported()`](#issharedworkersupported)
  - [Types](#types)
- [How sharing works](#how-sharing-works)
  - [Which tabs share a worker](#which-tabs-share-a-worker)
  - [When a read fails](#when-a-read-fails)

## Getting started

This walkthrough goes from a React application already using TanStack Query to two tabs sharing one query cache. Each step builds on the one before it, and the code is React; only [step 4](#4-render-the-app-behind-the-provider) differs elsewhere, and [Other frameworks](#other-frameworks) covers what to do instead.

### 1. Install the packages

`react` and `@tanstack/react-query` are assumed to be installed already. Install this package alongside TanStack Query's persistence packages for React:

```shell
npm install @sjpnz/query-shared-worker-persister @tanstack/react-query-persist-client @tanstack/query-async-storage-persister
```

TanStack Query 5.80.5 or newer is required. That is the first release whose persistence packages carry the per-query persister API this package's `entries()` is written for, including `restoreQueries`.

`@tanstack/query-async-storage-persister` and `@tanstack/query-persist-client-core` are peer dependencies: this package's public types are expressed in terms of them, so your project supplies the single copy that has to match your TanStack Query version. `@tanstack/react-query-persist-client` already brings in `@tanstack/query-persist-client-core`, and npm installs missing peers automatically, so the command above is usually all that is needed. On pnpm or Yarn Classic, which leave peers to you, add `@tanstack/query-persist-client-core` to it.

### 2. Create the query client and the persister

Both belong in a module the rest of the app imports, so there is one of each:

```typescript
// query-client.ts
import { QueryClient } from "@tanstack/react-query";
import { createSharedWorkerPersister } from "@sjpnz/query-shared-worker-persister";

// A name of your own, so this app's cache doesn't collide with another on the same origin.
const APP_NAME = "MY_AWESOME_APP";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
    },
  },
});

export const persister = createSharedWorkerPersister({ key: APP_NAME });
```

Two things there are worth pausing on.

`staleTime` decides whether any of this pays off. It defaults to `0`, which makes every query stale the moment it mounts: the restored cache is replaced by a network response before anyone sees it, and nothing is served from the shared cache at all. Set it to however long your data can be allowed to go without a refetch — five minutes is a reasonable place to start. TanStack's [important defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults) and [React Query as a state manager](https://tkdodo.eu/blog/react-query-as-a-state-manager) both go further into this.

`key` names the entry the whole dehydrated cache is written to. Applications that serve the same worker asset share one store, so a `key` of your own keeps this app out of another's data. To have a store of your own rather than an entry in a shared one, pass `namespace: APP_NAME` as well — it gives this application a worker to itself; see [Which tabs share a worker](#which-tabs-share-a-worker).

### 3. Keep open tabs in step

The persister writes one serialised cache under its `key` and reads it back only once, at startup. That is enough for a new tab to start warm, but not enough to stop two open tabs from overwriting each other's saves. [`broadcastQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/broadcastQueryClient) mirrors cache updates between tabs over a `BroadcastChannel`, so their in-memory caches stay in step and they write near-identical values instead of clobbering each other. Treat it as part of the setup rather than optional polish, and read [How sharing works](#how-sharing-works) before deciding to go without it.

It is a separate, optional install:

```shell
npm install @tanstack/query-broadcast-client-experimental
```

The plugin is framework-agnostic and, in TanStack's own terms, experimental — its API may change in a minor release. Point it at the same name and `query-client.ts` is finished:

```typescript
// query-client.ts
import { QueryClient } from "@tanstack/react-query";
import { broadcastQueryClient } from "@tanstack/query-broadcast-client-experimental";
import { createSharedWorkerPersister } from "@sjpnz/query-shared-worker-persister";

const APP_NAME = "MY_AWESOME_APP";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
    },
  },
});

export const persister = createSharedWorkerPersister({ key: APP_NAME });

broadcastQueryClient({ queryClient, broadcastChannel: APP_NAME });
```

### 4. Render the app behind the provider

[`PersistQueryClientProvider`](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient#persistqueryclientprovider) takes the persister through `persistOptions` and holds off rendering its children until the cache has been restored, so the first render already sees what another tab left behind:

```tsx
// App.tsx
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { persister, queryClient } from "./query-client";

const APP_VERSION = "MY_AWESOME_APP_v1.2.3";

const persistOptions = { persister, buster: APP_VERSION };

export default function App() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <h1>Hello, world!</h1>
      {/* Your app components */}
    </PersistQueryClientProvider>
  );
}
```

`buster` is your application's version, and a cache stamped with a different one is thrown away rather than restored into a build that may no longer understand its shape — which is what you want when a tab on an older version is still open beside a newly deployed one. Change it with the deployments that change what you cache, and leave it alone for the ones that don't: a mismatch clears the shared entry for every connected tab, not only the one that noticed it. [How sharing works](#how-sharing-works) has the details.

### 5. See it working

Start the app, open it in one tab, then open a second. The second tab should render its data without going to the network for it, because the first tab's cache reached it through the worker before its first render. TanStack's devtools, or the network panel filtered to a request you expect not to see, both show this happening.

If the second tab fetches anyway, these are the usual reasons, in the order worth checking:

- **`persister.mode` is `"noop"`.** No worker was built, and nothing is being persisted or shared. Usually the browser has no `SharedWorker` — see [Browser support](#browser-support).
- **The console reports that the worker failed to load.** The worker asset didn't reach your build's output, so its URL 404s. [Bundler requirements](#bundler-requirements) covers which bundlers emit it and what to do when yours doesn't.
- **Nothing is reported and `mode` is `"shared-worker"`.** The cache is being shared and the queries are refetching on top of it, which is what a `staleTime` of `0` does. Check that the client from step 2 is the one the app is rendering with.

Try a production build as well as the dev server. Dependencies are resolved differently in each, so the worker asset can be emitted correctly by one and not the other.

### Where to go from here

- [Per-query persistence](#per-query-persistence) stores an entry per query rather than one for the whole cache, which suits a shared store better than the default does.
- [Security considerations](#security-considerations) is worth reading before the cache holds an access token.
- [How sharing works](#how-sharing-works) sets out what the shared store does and doesn't synchronise.
- [Diagnostics](#diagnostics) sends this package's warnings somewhere other than the console.

## Security considerations

The shared store is readable by any script on the origin. Nothing about the worker restricts an entry to the application that wrote it: same-origin code can open the same worker with `new SharedWorker(sameUrl, { name: "TANSTACK_QUERY_SHARED_CACHE_WORKER:MY_APP" })` and read every key in it, `namespace` or not. `namespace` is a collision guard, not an access boundary — the protection you get is `localStorage`'s, a store scoped to an origin rather than a private one.

Treat it accordingly: don't persist anything you would not put in `localStorage`. Access tokens are the headline use case for this package and are a reasonable fit wherever you would already accept them in `localStorage`, but that is a decision worth making deliberately rather than inheriting from the example. To keep particular queries out of the shared store, exclude them with TanStack's `shouldDehydrateQuery`, or strip them in the persister's `serialize` hook.

## Guides

Nothing here is needed to get started. Each section stands on its own; read the one that matches what you are doing.

### Other frameworks

Steps 1 to 3 above are the same outside React; only the provider in step 4 is React's. Elsewhere, wire the same persister up imperatively with [`persistQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient#persistqueryclient) from `@tanstack/query-persist-client-core`. Restoration is asynchronous, so await it before rendering anything that reads from the cache:

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

Set it up with `experimental_createSharedWorkerQueryPersister`, in place of `createSharedWorkerPersister`:

```typescript
// query-client.ts
import { QueryClient } from "@tanstack/react-query";
import { experimental_createSharedWorkerQueryPersister } from "@sjpnz/query-shared-worker-persister";

export const queryPersister = experimental_createSharedWorkerQueryPersister({
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

Use this _instead of_ `PersistQueryClientProvider` and `createSharedWorkerPersister`, not alongside them; running both persists the same data twice under different keys. Note that the API it wraps is marked experimental by TanStack and its shape may change in a minor release, which is why this one carries the same prefix on its name.

#### What the wrapper does with `prefix`

The per-query persister reads the entire store — on `restoreQueries`, on every garbage-collection pass and on `removeQueries` — and then keeps only the keys under its own `prefix`, which it joins to each query hash with a `-`. One worker's store holds every tab's entries, and every entry of any other app sharing that worker, so reading all of it copies the lot across the port to throw most of it away. So the wrapper builds its storage with `entriesPrefix` set to `prefix` followed by that `-` — `"MY_AWESOME_APP-"` above, `"tanstack-query-"` when you leave `prefix` alone — and the worker sends back only the matching pairs. This narrows what is transferred, not what is reachable: `getItem` and `setItem` on the storage still address the whole store, and any same-origin script can read all of it regardless (see [Security considerations](#security-considerations)).

The two halves can still be assembled by hand, with `createSharedWorkerStorage` and TanStack's `experimental_createQueryPersister`, when you want a filter that isn't the persister's prefix — or none at all. Then the derivation above is yours to keep in step: `entriesPrefix` has to be the persister's `prefix` plus a `-`, and a mismatch is silent, because a listing that matches nothing is a valid answer and leaves `restoreQueries` restoring nothing.

```typescript
import { experimental_createQueryPersister } from "@tanstack/query-persist-client-core";
import { createSharedWorkerStorage } from "@sjpnz/query-shared-worker-persister";

const storage = createSharedWorkerStorage({ entriesPrefix: "MY_AWESOME_APP-" });
const queryPersister = experimental_createQueryPersister({ storage, prefix: "MY_AWESOME_APP" });
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

If the worker asset isn't there, the browser reports the load failure and the persister treats it as terminal — the error is logged once, and every request from then on fails immediately rather than waiting out its timeout (see [Browser support](#browser-support)). Queries still work; nothing is persisted or shared.

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

The URL must be on the page's own origin. One that resolves to another origin is refused with a `TypeError` when the storage or persister is created: a cross-origin worker script cannot be loaded, and a store is shared per origin in any case, so a copy on an asset domain would share nothing even if it did load. A same-origin URL the browser refuses for its own reasons is reported as a warning naming that URL, and you get the no-op storage; a URL it accepts but nothing is served at fails to load, which is the terminal failure described above.

It is an ES module and must be served as JavaScript. Every app that should share a store has to pass the same `workerUrl`, and changing it between deployments starts a fresh, empty worker — the same trade-off a content-hashed asset URL brings; [How sharing works](#how-sharing-works) covers what that means for open tabs.

Changing it is also the only way to get new worker code running while tabs are still open, because a worker keeps the script the first tab to connect loaded and tabs opening later attach to it as it is ([Which tabs share a worker](#which-tabs-share-a-worker)). So if you take the copy step above and later update this package, name the file for the version you copied — `/static/cache.worker.1.2.3.js` — and accept the empty store that comes with the new URL. A path you keep fixed forever is the trade in the other direction: the cache survives every deployment, and the worker code turns over only once every tab has closed.

### Browser support

This package relies on [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker), which is available in modern desktop browsers but **not** in some environments such as Chrome on Android and certain in-app webviews.

The worker is a module worker (`{ type: "module" }`), which browsers gained separately from — and later than — `SharedWorker` itself. Any browser current enough to matter has both, but a browser with `SharedWorker` and no module-worker support fails to start the worker rather than falling back, and is handled as a load failure below.

When `SharedWorker` is unavailable, the persister degrades gracefully to a no-op storage: TanStack Query keeps working with its normal in-memory cache, just without cross-tab persistence. In a browser a single warning is reported, so the fallback is visible during development; outside one, where the API was never going to be there, nothing is reported ([server-side rendering](#server-side-rendering)). Either way `createSharedWorkerStorage` marks the storage it hands back `mode: "noop"`.

The same fallback covers a `SharedWorker` that exists but refuses to be constructed — an opaque-origin document (a sandboxed iframe without `allow-same-origin`, or a `blob:`, `data:` or `file:` page), or a privacy mode or enterprise policy that disables workers. `isSharedWorkerSupported()` only reports that the API is present, so it returns `true` in those environments; construction is attempted, the error is reported as a warning, and you get the no-op storage rather than a throw at startup.

A worker that is available but fails to _start_ is a different matter — the usual cause is the worker asset not being copied into your bundle output, so its URL 404s. That failure is treated as terminal: the error is reported once, and every request from then on is answered immediately rather than hanging until the request timeout. Writes reject, so the failure reaches `createAsyncStoragePersister`'s `retry` hook and your own error handling; reads resolve empty, for the reason below.

A worker can also stop _after_ it started: the browser reclaiming it under memory pressure, a crash, or a developer terminating it from devtools. Messages posted to a worker that is gone are dropped in silence, so the browser has to say the connection went — it does that with a `close` event on the port, which not every browser has yet. Where it is available, this is terminal in exactly the way a worker that never started is: the error is reported once as `transport`, and writes reject and reads resolve empty from then on instead of each request waiting out its `timeoutMs`. Where it isn't, nothing changes from earlier releases — those requests do wait out the timeout, one by one, for as long as the tab is open.

Nothing reconnects on its own, and a long-lived application does not have to do anything either: TanStack Query's in-memory cache is untouched, so the app keeps working exactly as it does for a user whose browser has no `SharedWorker` at all — it just stops persisting and sharing. If you would rather have that back, rebuild it: take the `transport` report through [`onError`](#diagnostics), create a new persister (in React, remounting `PersistQueryClientProvider` under a new `key` is enough), and it constructs a worker again. That is a fresh start rather than a resume — the terminated worker took the shared store with it, so the new one begins empty and warms up from what tabs write from then on.

If you'd rather branch on support yourself — for example to skip wiring up persistence entirely — use the exported check:

```typescript
import {
  createSharedWorkerPersister,
  isSharedWorkerSupported,
} from "@sjpnz/query-shared-worker-persister";

const persister = isSharedWorkerSupported() ? createSharedWorkerPersister() : undefined;
```

#### Server-side rendering

Importing this package on the server is safe, and silent. Under a framework that renders on the server — Next.js, Remix, SvelteKit, Nuxt — the module that creates the persister is evaluated there too, and the server has no `SharedWorker`: `isSharedWorkerSupported()` is `false` and both entry points hand back the no-op storage. Nothing is written to the server log and `onError` is not called, because a server never had a worker to lose and there is nothing to act on; the warning above is for a browser that lacks the API, which is a real fallback to know about. Nothing about server rendering needs to change to use this package, and no `next/dynamic` or `"use client"` gymnastics are needed to keep the logs clean.

The server-side persister is inert: every read resolves empty, every write is dropped, nothing throws, and the browser builds its own persister when the same module is evaluated there. Read `mode` if you want to branch on it — it is `"noop"` on the server.

A test environment that simulates a browser (jsdom, happy-dom) defines `document`, so your application's tests do see the warning when `SharedWorker` is missing there. Pass `onError` if you'd rather they didn't.

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

When the lifetime is already governed by an `AbortSignal`, pass it instead and disposal follows the abort. A signal that has already aborted is honoured before anything is built: no worker is constructed, and what comes back is a storage that is already disposed.

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

| `code`        | What happened                                                                                                                                                     | Reported             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `unsupported` | No `SharedWorker`, or the constructor refused — a `workerUrl` it won't take included; the storage is the no-op one and persists nothing.                          | In a browser         |
| `transport`   | The worker failed after construction, or its connection closed because the worker went away — both terminal — or it sent a message that couldn't be deserialized. | Yes                  |
| `timeout`     | The worker didn't answer within `timeoutMs`.                                                                                                                      | If it stopped a read |
| `protocol`    | The worker answered with an error, with a result that doesn't fit the request, or in a wire-protocol version this build doesn't speak.                            | If it stopped a read |
| `disposed`    | The call came after `dispose()`, or after the signal aborted.                                                                                                     | First read only      |

The same errors reach you as the rejection of a failed write, so a `retry` hook can read `code` too. Reads never reject ([why](#when-a-read-fails)), which is exactly why a failed read is reported: the error that stopped it is the report's `cause`, and the report carries that error's `code`. A write is not reported separately — its rejection already carries the error — and a terminal worker failure is reported once, no matter how many calls follow it. Reads made after disposal are reported once too: the first says that a released storage is still being read from, and later ones add nothing to it. A message that couldn't be deserialized is reported and nothing more: the port stays open, every request in flight settles on its own response, and only the request whose answer was lost falls to its timeout.

The one report that is conditional on the environment is `unsupported`: it is raised in a browser, and skipped where there is no `document` at all, so a server render neither logs nor calls your handler ([server-side rendering](#server-side-rendering)).

`onError` is diagnostic only: it never changes how a call settles, and that holds even when your handler throws. A throw from it is caught and written to the console together with the error it was given, and the read, write or worker failure that reported carries on exactly as it would have — a reporter that is itself broken can't turn a read into a rejection or leave a failed worker half-shut-down.

To check synchronously whether persistence is live at all, read `mode`. Both entry points carry it:

```typescript
const persister = createSharedWorkerPersister();
if (persister.mode === "noop") {
  // SharedWorker is missing or refused: nothing will be persisted or shared.
}
```

`createSharedWorkerStorage` returns a storage with the same `mode`. It is fixed when the persister or storage is built, so it is safe to read once; a worker that fails later stays `"shared-worker"` and reports through `onError` instead.

## API

Three entry points: `createSharedWorkerPersister` for the usual whole-cache setup, `experimental_createSharedWorkerQueryPersister` for [per-query persistence](#per-query-persistence), and `createSharedWorkerStorage` for the storage on its own — the building block underneath both.

### `createSharedWorkerPersister(options?)`

Builds a SharedWorker-backed storage and wraps it in TanStack's [`createAsyncStoragePersister`](https://tanstack.com/query/latest/docs/framework/react/plugins/createAsyncStoragePersister). Returns a `SharedWorkerPersister`: a TanStack `Persister` to pass as `persistOptions.persister`, with the storage's teardown and mode on it.

Every `createAsyncStoragePersister` option except `storage` is forwarded untouched, alongside the options this package adds:

| Option         | Type                                                              | Default                       | Purpose                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`          | `string`                                                          | `"REACT_QUERY_OFFLINE_CACHE"` | The entry the whole dehydrated cache is stored under. Give each application its own.                                                                                                                                   |
| `throttleTime` | `number`                                                          | `1000`                        | Milliseconds to coalesce saves over.                                                                                                                                                                                   |
| `serialize`    | `(client: PersistedClient) => string \| Promise<string>`          | `JSON.stringify`              | Also the place to strip queries you don't want in a store any same-origin script can read; see [Security considerations](#security-considerations).                                                                    |
| `deserialize`  | `(cached: string) => PersistedClient \| Promise<PersistedClient>` | `JSON.parse`                  | Inverse of `serialize`.                                                                                                                                                                                                |
| `retry`        | `AsyncPersistRetryer`                                             | —                             | Called when a save fails, to shrink the client and try again.                                                                                                                                                          |
| `namespace`    | `string`                                                          | —                             | Give this app a worker, and therefore a store, of its own. Must not be empty; `""` throws a `TypeError`. See [Which tabs share a worker](#which-tabs-share-a-worker).                                                  |
| `timeoutMs`    | `number`                                                          | `10000`                       | How long a read or write waits for the worker before giving up. Greater than `0` and at most `2147483647`, or `Infinity` for no timeout; anything else throws a `RangeError`. See [Request timeout](#request-timeout). |
| `workerUrl`    | `string \| URL`                                                   | —                             | Load the worker from a copy you host, for builds that can't emit the packaged asset. Must be on the page's own origin; anything else throws a `TypeError`. See [Bundler requirements](#bundler-requirements).          |
| `signal`       | `AbortSignal`                                                     | —                             | Disposes the underlying storage when aborted.                                                                                                                                                                          |
| `port`         | `PortAdapter`                                                     | —                             | Carry the protocol over a port you supply instead of constructing a worker; see [Supplying your own port](#supplying-your-own-port).                                                                                   |
| `onError`      | `(error: SharedWorkerStorageError) => void`                       | console                       | Receives the storage's warnings and errors instead of the console; see [Diagnostics](#diagnostics).                                                                                                                    |

Beyond the `Persister` methods, the returned object carries the storage's teardown and its mode:

| Member               | Type                        | Notes                                                                                                                            |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `dispose()`          | `void`                      | Disposes the storage this persister created: settles in-flight requests, closes the port. Idempotent; see [Disposal](#disposal). |
| `[Symbol.dispose]()` | `void`                      | The same call under the well-known symbol, so the persister can be declared with `using`.                                        |
| `mode`               | `"shared-worker" \| "noop"` | Whether a transport was established at all. `"noop"` means nothing is persisted; see [Diagnostics](#diagnostics).                |

### `experimental_createSharedWorkerQueryPersister(options?)`

Builds a SharedWorker-backed storage and wraps it in TanStack's [`experimental_createQueryPersister`](https://tanstack.com/query/latest/docs/framework/react/plugins/createPersister), which stores one key per query hash rather than the whole cache under one; see [Per-query persistence](#per-query-persistence). Returns everything that function returns — `persisterFn`, `persistQuery`, `restoreQueries`, `persisterGc`, `removeQueries` and the rest — with the storage attached.

Every `experimental_createQueryPersister` option except `storage` is forwarded untouched, alongside the options this package adds:

| Option             | Type                                                            | Default            | Purpose                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefix`           | `string`                                                        | `"tanstack-query"` | Starts every key this persister writes, joined to the query hash with a `-`. Give each application its own. The storage's listing is narrowed to exactly this; `entriesPrefix` is derived and not accepted here.       |
| `maxAge`           | `number`                                                        | `86400000`         | Discard a persisted query older than this on restore.                                                                                                                                                                  |
| `buster`           | `string`                                                        | `""`               | Change it to invalidate everything persisted under the old value.                                                                                                                                                      |
| `serialize`        | `(query: PersistedQuery) => string \| Promise<string>`          | `JSON.stringify`   | Also the place to strip queries you don't want in a store any same-origin script can read; see [Security considerations](#security-considerations).                                                                    |
| `deserialize`      | `(cached: string) => PersistedQuery \| Promise<PersistedQuery>` | `JSON.parse`       | Inverse of `serialize`.                                                                                                                                                                                                |
| `filters`          | `QueryFilters`                                                  | —                  | Narrow which queries are persisted at all.                                                                                                                                                                             |
| `refetchOnRestore` | `boolean \| "always"`                                           | `true`             | Whether a restored query that is stale refetches.                                                                                                                                                                      |
| `namespace`        | `string`                                                        | —                  | Give this app a worker, and therefore a store, of its own. Must not be empty; `""` throws a `TypeError`. See [Which tabs share a worker](#which-tabs-share-a-worker).                                                  |
| `timeoutMs`        | `number`                                                        | `10000`            | How long a read or write waits for the worker before giving up. Greater than `0` and at most `2147483647`, or `Infinity` for no timeout; anything else throws a `RangeError`. See [Request timeout](#request-timeout). |
| `workerUrl`        | `string \| URL`                                                 | —                  | Load the worker from a copy you host, for builds that can't emit the packaged asset. Must be on the page's own origin; anything else throws a `TypeError`. See [Bundler requirements](#bundler-requirements).          |
| `signal`           | `AbortSignal`                                                   | —                  | Disposes the underlying storage when aborted.                                                                                                                                                                          |
| `port`             | `PortAdapter`                                                   | —                  | Carry the protocol over a port you supply instead of constructing a worker; see [Supplying your own port](#supplying-your-own-port).                                                                                   |
| `onError`          | `(error: SharedWorkerStorageError) => void`                     | console            | Receives the storage's warnings and errors instead of the console; see [Diagnostics](#diagnostics).                                                                                                                    |

Beyond TanStack's methods, the returned object carries the storage itself, its teardown and its mode:

| Member               | Type                        | Notes                                                                                                                       |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `storage`            | `SharedWorkerStorage`       | The storage this persister was built on, for calls the persister doesn't make for you; its `entries()` is already narrowed. |
| `dispose()`          | `void`                      | Disposes that storage: settles in-flight requests, closes the port. Idempotent; see [Disposal](#disposal).                  |
| `[Symbol.dispose]()` | `void`                      | The same call under the well-known symbol, so the persister can be declared with `using`.                                   |
| `mode`               | `"shared-worker" \| "noop"` | Whether a transport was established at all. `"noop"` means nothing is persisted; see [Diagnostics](#diagnostics).           |

### `createSharedWorkerStorage(options?)`

Returns a `SharedWorkerStorage`: an `AsyncStorage` the shared worker backs, usable anywhere TanStack takes a storage.

| Option          | Type                                        | Default | Purpose                                                                                                                                                                                                           |
| --------------- | ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeoutMs`     | `number`                                    | `10000` | Give up on a pending request after this many milliseconds. Greater than `0` and at most `2147483647`, or `Infinity` for no timeout; anything else throws a `RangeError`. See [Request timeout](#request-timeout). |
| `namespace`     | `string`                                    | —       | Appended to the worker's name, so apps shipping the same worker asset get a worker each. Must not be empty; `""` throws a `TypeError`.                                                                            |
| `entriesPrefix` | `string`                                    | —       | Return only the entries whose key starts with this from `entries()`, instead of the whole shared store; see [Per-query persistence](#per-query-persistence).                                                      |
| `workerUrl`     | `string \| URL`                             | —       | The worker's script URL, replacing the packaged `cache.worker.js`. Must be on the page's own origin; anything else throws a `TypeError`. See [Bundler requirements](#bundler-requirements).                       |
| `signal`        | `AbortSignal`                               | —       | Disposes the storage when aborted; a signal that has already aborted skips construction entirely and yields a disposed storage.                                                                                   |
| `port`          | `PortAdapter`                               | —       | Carry the protocol over a port you supply instead of constructing a worker; see [Supplying your own port](#supplying-your-own-port).                                                                              |
| `onError`       | `(error: SharedWorkerStorageError) => void` | console | Receives every warning and error instead of the console; see [Diagnostics](#diagnostics).                                                                                                                         |

The returned object:

| Member                | Returns                            | Notes                                                                                                                                                                                                 |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getItem(key)`        | `Promise<string \| null>`          | `null` when the key is absent, and also when the read fails; see [When a read fails](#when-a-read-fails).                                                                                             |
| `setItem(key, value)` | `Promise<void>`                    | Replaces any existing value outright; see [How sharing works](#how-sharing-works).                                                                                                                    |
| `removeItem(key)`     | `Promise<void>`                    | Removes the entry for every connected tab.                                                                                                                                                            |
| `entries()`           | `Promise<Array<[string, string]>>` | Every pair in the store, including entries written by other apps on the same worker, or only those under `entriesPrefix`. Required by `experimental_createQueryPersister`. Empty when the read fails. |
| `dispose()`           | `void`                             | Settles in-flight requests and closes the port. Idempotent; afterwards writes reject at once and reads resolve empty.                                                                                 |
| `[Symbol.dispose]()`  | `void`                             | The same teardown as `dispose()`, so the storage can be declared with `using`; see [Disposal](#disposal).                                                                                             |
| `mode`                | `"shared-worker" \| "noop"`        | Whether a transport was established at all. `"noop"` means nothing is persisted; see [Diagnostics](#diagnostics).                                                                                     |

A write rejects with a `SharedWorkerStorageError` if the worker doesn't answer within `timeoutMs`, and rejects immediately once the storage is disposed or the worker has failed; a read resolves empty in all three cases. When `SharedWorker` is missing or refuses to be constructed you get the same shape backed by no-op storage — reads resolve empty and writes are dropped; see [Browser support](#browser-support).

#### Supplying your own port

`port` takes over from worker construction: give it anything matching `PortAdapter` and the storage talks to that instead, ignoring `namespace` and `workerUrl` and skipping the `SharedWorker` support check and its no-op fallback. Both entry points accept it, so an application wired up with `createSharedWorkerPersister` can hand one in without rebuilding that wiring itself.

```typescript
import {
  createSharedWorkerPersister,
  createSharedWorkerStorage,
  type PortAdapter,
  PROTOCOL_VERSION,
  type StorageRequest,
  type StorageResponse,
} from "@sjpnz/query-shared-worker-persister";

const port: PortAdapter = {
  onmessage: null,
  postMessage(request: StorageRequest) {
    const response: StorageResponse = {
      kind: "response",
      id: request.id,
      ok: true,
      result: null,
      version: PROTOCOL_VERSION,
    };
    port.onmessage?.({ data: response } as MessageEvent<StorageResponse>);
  },
};

const storage = createSharedWorkerStorage({ port });
const persister = createSharedWorkerPersister({ port });
```

Every request carries an `id` and is answered by the response with the same `id`, so replies may arrive in any order; a request never answered is left to `timeoutMs`. Anything that isn't a well-formed `StorageResponse` is ignored, since a real shared worker's port is reachable by any same-origin script. `dispose()` calls `close()` on the port when it has one. A port may also set `onclose`, which the storage assigns to be told that the transport is gone for good — a real `MessagePort` fires it when the worker behind it goes away — and every request from then on fails as a `transport` error rather than waiting out its timeout; a port that never calls it behaves exactly as before. Requests also carry the wire protocol's own `version`, and so should responses. A port that answers on its own, as the one above does, stamps the exported `PROTOCOL_VERSION` — the version of the wire format it was built against. A port that forwards to a real worker passes the field through as it found it instead, since the version belongs to whichever build actually answered. A response with no version at all is read as `1`, which is what a build made before the field existed spoke; that keeps an old worker readable, but it is not a shape to write on purpose, because it becomes wrong the moment the protocol moves past `1`. A response naming a version this build doesn't speak fails its request rather than being decoded.

This is mainly how the package's own tests drive the storage without a browser, and it is the seam to reach for when testing an application that persists through this package. It is not a plugin point for a different backing store: the worker's semantics — one store shared by every connected tab, last write wins — are what the rest of this document describes.

### `isSharedWorkerSupported()`

`true` when the `SharedWorker` constructor exists. A presence check only: it can't tell you the constructor will succeed, which is why construction failures fall back to no-op storage rather than throwing. See [Browser support](#browser-support).

### Types

| Type                                      | What it is                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CreateSharedWorkerPersisterOptions`      | The options object above.                                                                                                                                                     |
| `CreateSharedWorkerQueryPersisterOptions` | The per-query persister's options object above.                                                                                                                               |
| `CreateSharedWorkerStorageOptions`        | The storage options object above.                                                                                                                                             |
| `SharedWorkerPersister`                   | The persister returned by [`createSharedWorkerPersister`](#createsharedworkerpersisteroptions); a TanStack `Persister` carrying `dispose()`, `[Symbol.dispose]()` and `mode`. |
| `SharedWorkerQueryPersister`              | What `experimental_createSharedWorkerQueryPersister` returns.                                                                                                                 |
| `SharedWorkerStorage`                     | The storage returned by `createSharedWorkerStorage`.                                                                                                                          |
| `SharedWorkerStorageError`                | The error every failure is raised and reported as; a class, so `instanceof` works.                                                                                            |
| `SharedWorkerStorageErrorCode`            | The `code` it carries; see [Diagnostics](#diagnostics).                                                                                                                       |
| `PortAdapter`                             | The port shape `port` accepts: the slice of `MessagePort` this package uses.                                                                                                  |
| `StorageRequest`, `StorageResponse`       | The messages exchanged over the port, for anyone implementing a `port` or inspecting worker traffic.                                                                          |
| `StorageResult`, `StorageEntries`         | The payload shapes those messages carry.                                                                                                                                      |
| `PROTOCOL_VERSION`                        | A number, not a type: the wire protocol version a port answering on its own stamps its replies with.                                                                          |

## How sharing works

The worker holds one in-memory store, shared by every tab connected to it. What that store does and does not synchronise is worth knowing before you rely on it:

- **One value per key, written by whichever tab saved last.** `createSharedWorkerPersister` serialises the entire dehydrated `QueryClient` into a single string under its `key`, and each save replaces the previous value outright. A tab holding only queries A and B overwrites an entry that also held C.
- **Restoring is a one-shot read at startup.** A tab reads the shared value once, while persistence is being set up, and never again. Anything another tab writes afterwards does not reach it, so the benefit is that a new tab starts warm rather than that open tabs stay in sync. Live sync is what `broadcastQueryClient` adds: with the in-memory caches kept in step, tabs write near-identical values instead of clobbering each other.
- **A restore that doesn't produce a usable cache clears the entry for everyone.** `persistQueryClient` calls `removeClient()` when the `buster` doesn't match or when `maxAge` has elapsed. Because the store is shared, one tab making that call empties the entry every other tab is using. A read that merely _fails_ is deliberately kept out of that group — see [When a read fails](#when-a-read-fails).
- **Access tokens are no exception.** Sharing a token across tabs is the headline use case, and it is subject to the same overwrites and clears as any other query: a tab whose own cache no longer holds the token will persist a value without it.

Whether a deployment carries the cache across depends on the worker asset's URL, because that URL is part of the worker's identity (see [Which tabs share a worker](#which-tabs-share-a-worker)). If a deployment changes it — a content hash, typically — tabs opened afterwards connect to a fresh worker and start with an empty store, while already-open tabs keep talking to the old one; the two versions then don't share anything. If the URL is unchanged, old and new tabs are on the same worker during a rolling deployment: keep `buster` stable across versions whose cached shapes are compatible, so an older tab doesn't wipe an entry the newer ones just filled — or accept the wipe and let the next writer refill it.

[Per-query persistence](#per-query-persistence) avoids the whole-cache overwrite entirely: each query gets its own key, so tabs caching different queries add to the shared store instead of replacing each other's work, and an expired or unreadable entry drops only that query.

### Which tabs share a worker

A `SharedWorker` is identified by its script URL _and_ its name, and the script URL here is the worker asset your bundler copies into your output. Two applications built separately on one origin normally serve that asset from different (usually content-hashed) URLs, so they already get separate workers and separate stores without doing anything. Sharing happens when applications serve the _same_ worker file — a shell and micro-frontends built together, for instance — and that is what [`namespace`](#createsharedworkerpersisteroptions) exists for: it changes the worker's name so those applications get a worker each. It has to be a non-empty string: `""` is the default worker's own name, so it would quietly share the store the option was passed to stay out of, and it throws a `TypeError` instead.

Which code that worker runs follows from the same rule. A `SharedWorker` is created once per `(script URL, name)` and lives until the last tab connected to it closes, so the script it runs is the one fetched when the _first_ tab connected. A tab opened later — on a newer deployment, carrying a newer version of this package — attaches to the worker that is already running and talks to the code it started with. It gets the newer code only once every tab holding the old worker has closed, or once the worker's URL changes: a content-hashed asset URL changes on every build, which is why this rarely shows up, while a `workerUrl` held stable across deployments — what you do to keep the cache alive across one — is exactly the case where it does.

The two sides say which wire protocol they speak, so this can't be mistaken for something else. If a tab's build speaks a version the running worker doesn't, its requests fail with a `protocol` error naming both versions instead of being misread; reads then resolve empty and that tab runs on the network. The version changes only for a change that would make one side misread the other, so a worker and a tab from different releases normally talk to each other quite happily.

### When a read fails

Reads never reject. A `getItem` or `entries` the worker can't answer — a timeout, a worker that never started, a worker that went away, an unreadable reply — resolves as though the store were empty, and reports a warning saying why.

That is deliberate, and it is about the store being shared. `persistQueryClient` treats a restore that throws as a corrupt cache, and responds by calling `removeClient()`; here that deletes the entry inside the worker, which is the entry every other tab is living off. So a tab that was only slow to read — a heavy page, a tab throttled in the background, a worker starting while the machine is busy — would not just fail to warm itself, it would erase everyone else's cache. Resolving empty keeps the damage local: that tab fetches from the network, and the shared store is left alone.

Writes still reject, so a save that didn't reach the worker reaches your `retry` hook and your error handling. And a genuine invalidation still clears the entry for everyone: a `buster` mismatch or an elapsed `maxAge` never goes through a failed read.

If your application wants to know that the cache was unreachable, take the report through [`onError`](#diagnostics); the value itself is indistinguishable from a cold cache by design.
