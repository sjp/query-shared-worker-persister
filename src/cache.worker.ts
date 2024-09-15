import { expose } from "comlink";
import type {
  AsyncStorage,
  PersistedClient,
} from "@tanstack/query-persist-client-core";

const sharedWorkerGlobalScope = self as unknown as SharedWorkerGlobalScope;

/**
 * The actual storage provider, simply a Map.
 * The keys are the name of an application identifier, enabling more than one application to use the cache at a time.
 * The values are the state of a QueryClient, including it's cache.
 */
const cache = new Map<string, PersistedClient>();

/**
 * A wrapper that is compatible with the QueryClient's serialization layer.
 */
const storage: AsyncStorage<PersistedClient> = {
  getItem: (key: string): PersistedClient => {
    const result = cache.get(key);
    return result as PersistedClient;
  },
  setItem: (key: string, value: PersistedClient): unknown => {
    cache.set(key, value);
    return value;
  },
  removeItem: (key: string): void => {
    cache.delete(key);
  },
};

sharedWorkerGlobalScope.onconnect = (event) => {
  const port = event.ports[0];
  expose(storage, port);
};
