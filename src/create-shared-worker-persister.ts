import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { createSharedWorkerStorage } from "./shared-worker-storage";

/** Options for {@link createAsyncStoragePersister}, minus the `storage` we supply. */
type AsyncStoragePersisterOptions = Parameters<typeof createAsyncStoragePersister>[0];
export type CreateSharedWorkerPersisterOptions = Omit<AsyncStoragePersisterOptions, "storage">;

/**
 * One-call convenience: build a SharedWorker-backed `AsyncStorage` and wrap it
 * in TanStack's async-storage persister. Drop the result straight into
 * `PersistQueryClientProvider`'s `persistOptions.persister`.
 */
export function createSharedWorkerPersister(options: CreateSharedWorkerPersisterOptions = {}) {
  const storage = createSharedWorkerStorage();
  return createAsyncStoragePersister({ throttleTime: 1_000, ...options, storage });
}
