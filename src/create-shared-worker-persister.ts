import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { createSharedWorkerStorage } from "./shared-worker-storage";

/** Options for {@link createAsyncStoragePersister}, minus the `storage` we supply. */
type AsyncStoragePersisterOptions = Parameters<typeof createAsyncStoragePersister>[0];
export type CreateSharedWorkerPersisterOptions = Omit<AsyncStoragePersisterOptions, "storage"> & {
  /**
   * Isolate this app's cache in its own SharedWorker process instead of sharing
   * the per-origin default. See {@link createSharedWorkerStorage}'s `namespace`.
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
  const { namespace, signal, ...persisterOptions } = options;
  const storage = createSharedWorkerStorage({ namespace, signal });
  return createAsyncStoragePersister({ throttleTime: 1_000, ...persisterOptions, storage });
}
