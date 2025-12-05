import { wrap } from "comlink";
import type {
  AsyncStorage,
  PersistedClient,
} from "@tanstack/query-persist-client-core";

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
  const port = sharedWorker.port;

  // Set up the ready promise and event listener BEFORE starting the port
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  const handleMessage = (event: MessageEvent) => {
    if (event?.data?.ready) {
      port.removeEventListener("message", handleMessage);
      readyResolve?.();
    }
  };
  
  port.addEventListener("message", handleMessage);
  // Start the port after the listener is set up
  port.start();

  // gross type hack required
  // TS cannot resolve the entries parameter that should be correctly
  // handled but is not supported once wrapped via comlink/remote
  const wrappedStorage = wrap(port) as unknown as AsyncStorage<PersistedClient>;

  // Wrap each method to wait for ready before executing
  return {
    getItem: async (key: string) => {
      await readyPromise;
      return wrappedStorage.getItem(key);
    },
    setItem: async (key: string, value: PersistedClient) => {
      await readyPromise;
      return wrappedStorage.setItem(key, value);
    },
    removeItem: async (key: string) => {
      await readyPromise;
      return wrappedStorage.removeItem(key);
    },
    entries: async () => {
      await readyPromise;
      return wrappedStorage.entries?.() ?? [];
    },
  };
};

/**
 * Creates a SharedWorker that stores our cache
 */
export const createSharedWorker = (): SharedWorker => {
  return new SharedWorker(new URL("./cache.worker.ts", import.meta.url), {
    type: "module",
    name: "TANSTACK_QUERY_SHARED_CACHE_WORKER",
  });
};
