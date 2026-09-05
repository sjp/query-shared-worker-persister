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
  // so apps sharing the default worker don't restore each other's queries.
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
- **A restore that doesn't produce a usable cache clears the entry for everyone.** `persistQueryClient` calls `removeClient()` when the `buster` doesn't match, when `maxAge` has elapsed, or when restoring throws — a request timeout included. Because the store is shared, one tab making that call empties the entry every other tab is using.
- **Access tokens are no exception.** Sharing a token across tabs is the headline use case, and it is subject to the same overwrites and clears as any other query: a tab whose own cache no longer holds the token will persist a value without it.

During a rolling deployment, tabs on the old and new versions are connected to the same worker. Keep `buster` stable across versions whose cached shapes are compatible, so an older tab doesn't wipe an entry the newer ones just filled — or accept the wipe and let the next writer refill it.

[Per-query persistence](#per-query-persistence) avoids the whole-cache overwrite entirely: each query gets its own key, so tabs caching different queries add to the shared store instead of replacing each other's work, and an expired or unreadable entry drops only that query.

## Browser Support

This package relies on [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker), which is available in modern desktop browsers but **not** in some environments such as Chrome on Android and certain in-app webviews.

When `SharedWorker` is unavailable, the persister degrades gracefully to a no-op storage: TanStack Query keeps working with its normal in-memory cache, just without cross-tab persistence. A single warning is logged to the console so the fallback is visible during development.

The same fallback covers a `SharedWorker` that exists but refuses to be constructed — an opaque-origin document (a sandboxed iframe without `allow-same-origin`, or a `blob:`, `data:` or `file:` page), or a privacy mode or enterprise policy that disables workers. `isSharedWorkerSupported()` only reports that the API is present, so it returns `true` in those environments; construction is attempted, the error is logged as a warning, and you get the no-op storage rather than a throw at startup.

A worker that is available but fails to _start_ is a different matter — the usual cause is the worker asset not being copied into your bundle output, so its URL 404s. That failure is treated as terminal: the error is logged once, and every read and write from then on rejects immediately with it rather than hanging until the request timeout. Reads and writes reject (rather than quietly resolving) so the failure reaches `createAsyncStoragePersister`'s `retry` hook and your own error handling instead of looking like an empty cache.

If you'd rather branch on support yourself — for example to skip wiring up persistence entirely — use the exported check:

```typescript
import {
  createSharedWorkerPersister,
  isSharedWorkerSupported,
} from "@sjpnz/query-shared-worker-persister";

const persister = isSharedWorkerSupported() ? createSharedWorkerPersister() : undefined;
```

### Disposal

Most apps keep a single persister for the page's lifetime and never need to dispose it. If you do recreate the persister (for example in tests, micro-frontends, or hot-module reloads), pass an `AbortSignal` to release the underlying SharedWorker connection when you're done:

```typescript
const controller = new AbortController();
const persister = createSharedWorkerPersister({ signal: controller.signal });

// later, to tear it down:
controller.abort();
```

### Request timeout

Every read and write waits for the worker to answer and rejects after 10 seconds. Pass `timeoutMs` to change that — raise it if the worker starts slowly on your pages (a heavy first paint, or a throttled background tab), lower it if you would rather give up on the cache quickly and let the network serve the first render:

```typescript
const persister = createSharedWorkerPersister({ timeoutMs: 2_000 });
```

The same option is available on `createSharedWorkerStorage` if you are wiring the storage up yourself.

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

   By default every application on an origin shares a single `SharedWorker` (and therefore a single in-memory store), with `key` namespacing the entry within it. If you want a fully isolated worker process per application — so that other same-origin apps can't read your cached values — pass a `namespace` as well:

   ```typescript
   export const persister = createSharedWorkerPersister({
     key: APP_NAME,
     namespace: APP_NAME, // dedicated SharedWorker, isolated from other apps on this origin
   });
   ```

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
