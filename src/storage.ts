import { wrap } from "comlink";
import type {
  AsyncStorage,
  PersistedClient,
} from "@tanstack/query-persist-client-core";

export const CacheWorkerUrl = new URL("./cache.worker.ts", import.meta.url);

/**
 * A convenenience method used for exposing a SharedWorker as an asynchronous storage provider.
 * @param worker A SharedWorker that exposes functionality for persisting a QueryClient.
 *   If not provided a default SharedWorker will be constructed.
 * @returns A storage provider compatible with a QueryClient's persistence layer.
 */
export const createSharedStorage = (
  worker?: SharedWorker
): AsyncStorage<PersistedClient> => {
  const sharedWorker = worker ?? createSharedWorker();
  return wrap(sharedWorker.port);
};

/**
 * Creates a SharedWorker that stores our cache
 */
export const createSharedWorker = (): SharedWorker => {
  return new SharedWorker(CacheWorkerUrl, {
    type: "module",
    name: "TANSTACK_QUERY_SHARED_CACHE_WORKER"
  });
};
