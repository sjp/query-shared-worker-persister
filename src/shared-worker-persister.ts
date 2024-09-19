import type {
  AsyncStorage,
  PersistedClient,
  Persister,
} from "@tanstack/query-persist-client-core";
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

const isServer = () => typeof window === 'undefined';
const isSharedWorkerAvailable = () => !isServer() && !!window.SharedWorker;

const STORAGE_KEY = "TANSTACK_QUERY_SHARED_WORKER_CACHE";

interface CreateSharedWorkerPersisterOptions {
  /** The storage client used for setting and retrieving items from cache.
   * For SSR pass in `null`.
   * If not provided, a default SharedWorker-based storage provider will be created.
   */
  storage?: AsyncStorage<PersistedClient> | null;

  /** The key to use when storing the cache.
   * Primarily useful when there are multiple applications that
   * use the same storage.
   * @default "TANSTACK_QUERY_SHARED_WORKER_CACHE"
   */
  key?: string;
}

/**
 * Creates a persister that saves to a SharedWorker.
 * @param options An optional set of parameters that enables configuration of the persister.
 * @returns A persister intended to be used with the QueryClient's persistence layer.
 */
export const createSharedWorkerPersister = (
  options: CreateSharedWorkerPersisterOptions = {}
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
