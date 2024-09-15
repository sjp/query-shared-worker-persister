// asyncStoragePersister.ts
import type {
    AsyncStorage,
    PersistedClient,
    Persister,
  } from "@tanstack/react-query-persist-client";
  import {
    createSharedStorage as createSharedWorkerStorage,
    createSharedWorker,
  } from "./storage";
  
  const noop = () => {};
  
  const noopPersister: Persister = {
    persistClient: noop,
    restoreClient: () => Promise.resolve(undefined),
    removeClient: noop,
  };
  
  const isSharedWorkerAvailable = () => !!window && !!window.SharedWorker;
  
  const STORAGE_KEY = "REACT_QUERY_SHARED_WORKER_CACHE";
  
  interface CreateSharedWorkerStoragePersisterOptions {
    /** The storage client used for setting and retrieving items from cache.
     * For SSR pass in `null`.
     * If not provided, a default SharedWorker-based storage provider will be created.
     */
    storage?: AsyncStorage<PersistedClient> | null;
  
    /** The key to use when storing the cache.
     * Primarily useful when there are multiple applications that
     * be using the same storage.
     */
    key?: string;
  }
  
  export const createSharedWorkerStoragePersister = (
    options: CreateSharedWorkerStoragePersisterOptions = {}
  ): Persister => {
    const { storage, key } = options;
  
    if (storage === null || !isSharedWorkerAvailable()) {
      return noopPersister;
    }
  
    const resolvedStorage =
      storage || createSharedWorkerStorage(createSharedWorker());
    const resolvedKey = key || STORAGE_KEY;
  
    return {
      persistClient: (persistClient: PersistedClient) => {
        resolvedStorage.setItem(resolvedKey, persistClient);
      },
      restoreClient: async () => {
        const cached = await resolvedStorage.getItem(resolvedKey);
        if (!cached) return;
        return cached;
      },
      removeClient: () => resolvedStorage.removeItem(resolvedKey),
    };
  };
  