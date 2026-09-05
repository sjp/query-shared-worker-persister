import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import type { Persister } from "@tanstack/query-persist-client-core";
import {
  createSharedWorkerStorage,
  type SharedWorkerStorage,
  type SharedWorkerStorageError,
} from "./shared-worker-storage";

/** Options for {@link createAsyncStoragePersister}, minus the `storage` we supply. */
type AsyncStoragePersisterOptions = Parameters<typeof createAsyncStoragePersister>[0];
export type CreateSharedWorkerPersisterOptions = Omit<AsyncStoragePersisterOptions, "storage"> & {
  /**
   * Reject a request to the SharedWorker after this many ms. Default 10s. Worth
   * raising on slow or heavily throttled pages and lowering when you would
   * rather fall back to the network quickly.
   *
   * Must be greater than `0` and at most `2147483647` (about 24.8 days), or
   * `Infinity` to wait indefinitely; anything else throws a `RangeError` here.
   * See {@link createSharedWorkerStorage}'s `timeoutMs`.
   */
  timeoutMs?: number | undefined;
  /**
   * Give this app its own SharedWorker, and its own store, instead of sharing
   * one with other apps that serve the same worker asset. Not an access
   * boundary — any same-origin script can open the same worker. See
   * {@link createSharedWorkerStorage}'s `namespace`.
   */
  namespace?: string | undefined;
  /**
   * Load the worker from a URL you host yourself, instead of the
   * `cache.worker.js` published beside this bundle. Only needed when your build
   * can't copy that asset out of `node_modules`. See
   * {@link createSharedWorkerStorage}'s `workerUrl`.
   */
  workerUrl?: string | URL | undefined;
  /**
   * Dispose the underlying SharedWorker storage when this signal aborts. A
   * convenience for callers that already have a signal to hang the lifetime on;
   * the returned persister can also be disposed directly. See
   * {@link createSharedWorkerStorage}'s `signal`.
   */
  signal?: AbortSignal | undefined;
  /**
   * Receive the warnings and errors the storage would otherwise write to the
   * console — the no-op fallback, a failed worker, a read that resolved empty —
   * so they can go to your logger or error reporter instead. See
   * {@link createSharedWorkerStorage}'s `onError`.
   */
  onError?: ((error: SharedWorkerStorageError) => void) | undefined;
};

/**
 * A TanStack `Persister` that also owns the storage behind it, so the
 * SharedWorker connection it opened can be released — and asked whether it
 * persists anything at all — without reaching for the storage itself.
 */
export interface SharedWorkerPersister extends Persister {
  /**
   * `"shared-worker"` when a transport was established, `"noop"` when one could
   * not be and nothing this persister saves is kept — the fallback taken when
   * `SharedWorker` is missing or refuses to be constructed. Fixed for the life
   * of the persister: a worker that fails *after* construction leaves this
   * `"shared-worker"`, and is reported through
   * {@link CreateSharedWorkerPersisterOptions.onError} instead.
   */
  readonly mode: SharedWorkerStorage["mode"];
  /**
   * Dispose the underlying storage: settle its in-flight requests and close the
   * port. Idempotent, and independent of any `signal` that was passed. The
   * persister object stays callable afterwards — with the storage gone a
   * restore resolves as though nothing were stored, and a save no longer
   * reaches the worker.
   */
  dispose: () => void;
  /**
   * The same teardown as {@link SharedWorkerPersister.dispose}, so a persister
   * scoped to a block can be declared with `using`. Needs TypeScript 5.2 or
   * newer to compile and `Symbol.dispose` at runtime.
   */
  [Symbol.dispose]: () => void;
}

/**
 * One-call convenience: build a SharedWorker-backed `AsyncStorage` and wrap it
 * in TanStack's async-storage persister. Drop the result straight into
 * `PersistQueryClientProvider`'s `persistOptions.persister`.
 *
 * The storage stays reachable through the returned `dispose()`, for the
 * short-lived persisters — tests, hot reloads, a micro-frontend being unmounted
 * — that have to give the connection back, and through `mode`, for code that
 * wants to know whether anything is being persisted at all.
 */
export function createSharedWorkerPersister(
  options: CreateSharedWorkerPersisterOptions = {},
): SharedWorkerPersister {
  const { timeoutMs, namespace, workerUrl, signal, onError, ...persisterOptions } = options;
  const storage = createSharedWorkerStorage({ timeoutMs, namespace, workerUrl, signal, onError });
  const persister = createAsyncStoragePersister({ ...persisterOptions, storage });
  const dispose = () => {
    storage.dispose();
  };
  return { ...persister, mode: storage.mode, dispose, [Symbol.dispose]: dispose };
}
