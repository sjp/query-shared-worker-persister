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
npm install @sjpnz/query-shared-worker-persister @tanstack/react-query-persist-client
```

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

   For optimal performance and to ensure true global sharing of cached values across tabs, it's highly recommended to use a [`broadcastQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/broadcastQueryClient). This prevents different tabs from overwriting each other's cached values, while also keeping the shared cache fresh.

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

   Provide an application version to invalidate the cache when it doesn't match the current application version. This ensures that outdated data isn't persisted when one tab/window has a newer application version than another.

   Add a `buster` to the `persistOptions` from step 3 above:

   ```tsx
   // App.tsx
   const APP_VERSION = "MY_AWESOME_APP_v1.2.3";

   const persistOptions = {
     persister,
     buster: APP_VERSION,
   };
   ```
