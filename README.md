# Improve Tanstack Query Caching

Quickly improve performance in your web application by sharing a query cache across multiple tabs and windows.

## Introduction

This package allows [Tanstack Query](https://tanstack.com/query/latest) state to be persisted using a [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker). When a new tab or window is opened, its query cache can be populated with queries from another window.

### Features

* Share a query cache between tabs and windows
* Reduce redundant network calls
* Simple configuration and setup
* Easy performance wins

A common use case is for access tokens. There is rarely a need for fetching a separate token for each new window. A shared query cache via `SharedWorker` will greatly improve application startup as a result.

### Demo

A simple demo app has been published that demonstrates desired caching behaviour here: <https://sjp.co.nz/projects/query-shared-worker-persister/demo>

The source for the react application is available on [GitHub](https://github.com/sjp/query-shared-worker-demo)

## Getting Started

### Installation

Install the package in your project using `npm`:

```shell
npm install @sjpnz/query-shared-worker-persister
```

### Configuration

Follow these steps to configure `QueryClient` persistence. While the examples use React, a similar approach applies to other frameworks.

1. Create a `QueryClient` and `SharedWorker` persister:

    ```typescript
    import { QueryClient } from '@tanstack/react-query';
    import { createSharedWorkerPersister } from '@sjpnz/query-shared-worker-persister';
    
    const queryClient = new QueryClient();
    const sharedWorkerPersister = createSharedWorkerPersister();
    ```

2. (Recommended) Use a [`broadcastQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/broadcastQueryClient):

    For optimal performance and to ensure true global sharing of cached values across tabs, it's highly recommended to use a [`broadcastQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/broadcastQueryClient). This prevents different tabs from overwriting each other's cached values, while also keeping the shared cache fresh.

    ```typescript
    import { broadcastQueryClient } from '@tanstack/react-query-broadcast-client-experimental';
    
    broadcastQueryClient({ queryClient });
    ```

3. Use a [`persistQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient):

    Configure `SharedWorker` persistence via `persistQueryClient`. This will set up the shared cache.

    ```typescript
    import { persistQueryClient } from '@tanstack/react-query-persist-client';

    persistQueryClient({ 
      queryClient,
      persister: sharedWorkerPersister 
    });
    
    export default function App() {
      return (
        <QueryClientProvider
          client={queryClient}
        >
          <h1>Hello, world!</h1>
          {/* Your app components */}
        </QueryClientProvider>
      );
    }
    ```

## Recommendations

To get the most out of this package and ensure optimal performance, consider the following recommendations:

1. Configure `staleTime` for your queries

    Set an appropriate `staleTime` for effective caching. Without it, queries will not be loaded from the cache, negating the benefits of this package.

    See the following links for more details:
    * <https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults>
    * <https://tkdodo.eu/blog/react-query-as-a-state-manager>

    ```typescript
    // Configure all queries to be considered stale after 5 minutes
    const STALE_TIME = 1000 * 60 * 5; // 5 minutes
    
    const queryClient = new QueryClient({
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
    // Define a unique identifier for your application
    const APP_NAME = "MY_AWESOME_APP";
    
    // Configure the SharedWorker persister with the app-specific key
    const persister = createSharedWorkerPersister({ 
      key: APP_NAME
    });
    
    // If using broadcastQueryClient, apply the same identifier
    broadcastQueryClient({
      queryClient,
      broadcastChannel: APP_NAME,
    });
    ```

3. Implement Cache Busting

    Provide an application version to invalidate the cache when it doesn't match the current application version. This ensures that outdated data isn't persisted when one tab/window has a newer application version than another.

    ```typescript
    const APP_VERSION = "MY_AWESOME_APP_v1.2.3";
    
    const persistOptions = {
      persister: persister,
      buster: APP_VERSION,
    };
    
    export default function App() {
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={persistOptions}
        >
          <h1>Hello, world!</h1>
        </PersistQueryClientProvider>
      );
    }
    ```