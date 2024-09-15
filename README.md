# Tanstack Query SharedWorker Persistence

This package allows [Tanstack Query](https://tanstack.com/query/latest) state to be persisted using a [SharedWorker](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker). By leveraging this functionality, query caches can be shared and reused across multiple [browsing contexts](https://developer.mozilla.org/en-US/docs/Glossary/Browsing_context) within the same origin.

Key benefit: When opening a new tab or window in your Tanstack Query-based application, it won't need to refetch queries that are already cached, improving performance and reducing unnecessary network requests.

A practical use case is caching an access token. Typically, there's no need for multiple tabs to maintain separate access tokens, making this an ideal scenario for shared persistence.

## Getting Started

### Installation

Install the package in your project using npm:

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

    For optimal performance and to ensure true global sharing of cached values across tabs, it's highly recommended to use a [`broadcastQueryClient`](https://tanstack.com/query/latest/docs/framework/react/plugins/broadcastQueryClient). This prevents different tabs from overwriting each other's cached values.

    ```typescript
    import { broadcastQueryClient } from '@tanstack/react-query-broadcast-client-experimental';
    
    broadcastQueryClient({ queryClient });
    ```

3. Replace `QueryClientProvider` with `PersistQueryClientProvider`:

    Replace the standard `<QueryClientProvider>` with a `<PersistQueryClientProvider>` in your app's root component:

    ```typescript
    import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
    
    const persistOptions = {
      persister: sharedWorkerPersister,
    };
    
    export default function App() {
      return (
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={persistOptions}
        >
          <h1>Hello, world!</h1>
          {/* Your app components */}
        </PersistQueryClientProvider>
      );
    }
    ```

With these configurations in place, your Tanstack Query cache will now be shared across multiple tabs and windows within the same origin. This means queries can be reused without unnecessary refetching when opening new tabs or windows in your application.

## Best Practices and Recommendations

To get the most out of this package and ensure optimal performance, consider the following recommendations:

1. Configure `staleTime` for your queries

    Setting an appropriate staleTime is crucial for effective caching. Without it, queries will not be loaded from the cache, negating the benefits of this package.

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

    Employing a unique identifier ensures that the cache remains relevant to your specific application, preventing conflicts in shared environments.

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

3. Implement Cache Busting with Version Control

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

## Troubleshooting

The first thing you should do is use the [Devtools](https://tanstack.com/query/latest/docs/framework/react/devtools) to verify behaviour. You should see queries available in the cache.

There are some common and known reasons why you may not be seeing query caching working properly.

* Your queries do not have a `staleTime` set, meaning they will (by default) not be loaded from the cache.
* [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) is not natively supported in your browser.
* [SharedWorker](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker) is not natively supported in your browser.

Regarding browser support, all modern browsers should support this functionality.

If you're experiencing issues with query caching, follow these steps to diagnose and resolve common problems:

1. Verify Behavior with Devtools

    Start by using the Tanstack Query Devtools to inspect your query cache. You should see queries available in the cache if everything is working correctly.

2. Common Issues and Solutions

    1. Queries Not Loading from Cache

        Problem: Queries are refetching unnecessarily.

        Possible Cause: No staleTime set for queries.

        Solution: Set an appropriate staleTime for your queries. By default, queries are considered stale immediately,which can lead to unnecessary refetching. Example:

        ```typescript
        useQuery({
          queryKey: ['myData'],
          queryFn: fetchMyData,
          staleTime: 60000, // 1 minute
        });
        ```

    2. Cross-Tab Synchronization Not Working

        Problem: Changes in one tab aren't reflected in others.

        Possible Cause: BroadcastChannel API not supported or not properly implemented.

        Solution: Ensure you're using the `broadcastQueryClient` as recommended in the setup.
        Check if your browser supports [`BroadcastChannel`](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel). A polyfill or fallback mechanism will be used in its absence. Browser support via caniuse: <https://caniuse.com/broadcastchannel>

    3. Shared Worker Not Functioning

        Problem: Persistence across tabs/windows isn't working at all.

        Possible Cause: [`SharedWorker`](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker) not supported by the browser.

        Solution: Verify browser support for `SharedWorker`. Browser support via caniuse: <https://caniuse.com/sharedworkers>

3. Browser Compatibility

    While all modern desktop browsers should support the required APIs (`SharedWorker` and `BroadcastChannel`), you may encounter issues with older browser versions or mobile browsers.

    To check current browser support:

    * `SharedWorker`: <https://caniuse.com/sharedworkers>
    * `BroadcastChannel` <https://caniuse.com/broadcastchannel>

4. Additional Debugging

    If issues persist:

    Check your browser's console for any error messages.
    Ensure all dependencies are up to date.
    Verify that your implementation matches the setup guide exactly.

    If you're still experiencing problems after trying these solutions, consider opening an issue on the project's GitHub repository with a detailed description of your setup and the issue you're facing.
