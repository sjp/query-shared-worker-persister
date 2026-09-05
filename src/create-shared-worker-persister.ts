import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { createSharedWorkerStorage } from "./shared-worker-storage";

/** Options for {@link createAsyncStoragePersister}, minus the `storage` we supply. */
type AsyncStoragePersisterOptions = Parameters<typeof createAsyncStoragePersister>[0];
export type CreateSharedWorkerPersisterOptions = Omit<AsyncStoragePersisterOptions, "storage"> & {
  /**
   * Reject a request to the SharedWorker after this many ms. Default 10s. Worth
   * raising on slow or heavily throttled pages and lowering when you would
   * rather fall back to the network quickly. See
   * {@link createSharedWorkerStorage}'s `timeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Give this app its own SharedWorker, and its own store, instead of sharing
   * one with other apps that serve the same worker asset. Not an access
   * boundary — any same-origin script can open the same worker. See
   * {@link createSharedWorkerStorage}'s `namespace`.
   */
  namespace?: string;
  /**
   * Dispose the underlying SharedWorker storage when this signal aborts. Since
   * this convenience wrapper hides the storage's `dispose()`, the signal is the
   * way to bound its lifetime. See {@link createSharedWorkerStorage}'s `signal`.
   */
  signal?: AbortSignal;
};

/**
 * One-call convenience: build a SharedWorker-backed `AsyncStorage` and wrap it
 * in TanStack's async-storage persister. Drop the result straight into
 * `PersistQueryClientProvider`'s `persistOptions.persister`.
 */
export function createSharedWorkerPersister(options: CreateSharedWorkerPersisterOptions = {}) {
  const { timeoutMs, namespace, signal, ...persisterOptions } = options;
  const storage = createSharedWorkerStorage({ timeoutMs, namespace, signal });
  return createAsyncStoragePersister({ throttleTime: 1_000, ...persisterOptions, storage });
}
