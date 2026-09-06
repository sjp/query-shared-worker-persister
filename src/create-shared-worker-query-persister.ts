import {
  experimental_createQueryPersister,
  PERSISTER_KEY_PREFIX,
  type StoragePersisterOptions,
} from "@tanstack/query-persist-client-core";
import {
  createSharedWorkerStorage,
  type PortAdapter,
  type SharedWorkerStorage,
  type SharedWorkerStorageError,
} from "./shared-worker-storage";

/**
 * Options for {@link experimental_createQueryPersister}, minus the `storage` we
 * supply. Its values are strings, because that is what the shared worker's
 * store holds.
 */
type QueryPersisterOptions = Omit<StoragePersisterOptions<string>, "storage">;

/** What {@link experimental_createQueryPersister} hands back over a string store. */
type QueryPersister = ReturnType<typeof experimental_createQueryPersister<string>>;

export type CreateSharedWorkerQueryPersisterOptions = QueryPersisterOptions & {
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
   * one with other apps that serve the same worker asset. Must not be `""`,
   * which names the default worker and so shares it; that throws a `TypeError`
   * here. Not an access boundary either — any same-origin script can open the
   * same worker. See {@link createSharedWorkerStorage}'s `namespace`.
   */
  namespace?: string | undefined;
  /**
   * Load the worker from a URL you host yourself, instead of the
   * `cache.worker.js` published beside this bundle. Only needed when your build
   * can't copy that asset out of `node_modules`. Must be on the page's own
   * origin; one that resolves elsewhere throws a `TypeError`. See
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
   * Carry the protocol over this {@link PortAdapter} instead of constructing a
   * `SharedWorker`, so an application wired up through this function can be
   * tested against an in-process store. Supplying a port replaces worker
   * construction entirely: `namespace` and `workerUrl` are ignored, no
   * `SharedWorker` support check is made, and the persister never falls back to
   * no-op. See {@link createSharedWorkerStorage}'s `port`.
   */
  port?: PortAdapter | undefined;
  /**
   * Receive the warnings and errors the storage would otherwise write to the
   * console — the no-op fallback, a failed worker, a read that resolved empty —
   * so they can go to your logger or error reporter instead. See
   * {@link createSharedWorkerStorage}'s `onError`.
   */
  onError?: ((error: SharedWorkerStorageError) => void) | undefined;
};

/**
 * TanStack's per-query persister with the storage behind it attached, so the
 * SharedWorker connection it opened can be released — and asked whether it
 * persists anything at all — without holding the storage separately.
 */
export interface SharedWorkerQueryPersister extends QueryPersister {
  /**
   * The storage this persister was built on, for the calls TanStack's persister
   * doesn't make on your behalf — reading a key another app wrote, say.
   * `entries()` on it is already narrowed to this persister's own keys.
   */
  readonly storage: SharedWorkerStorage;
  /**
   * `"shared-worker"` when a transport was established, `"noop"` when one could
   * not be and nothing this persister saves is kept — the fallback taken when
   * `SharedWorker` is missing or refuses to be constructed. Fixed for the life
   * of the persister: a worker that fails *after* construction leaves this
   * `"shared-worker"`, and is reported through
   * {@link CreateSharedWorkerQueryPersisterOptions.onError} instead.
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
   * The same teardown as {@link SharedWorkerQueryPersister.dispose}, so a
   * persister scoped to a block can be declared with `using`. Needs TypeScript
   * 5.2 or newer to compile and `Symbol.dispose` at runtime.
   */
  [Symbol.dispose]: () => void;
}

/**
 * One-call convenience for per-query persistence: build a SharedWorker-backed
 * `AsyncStorage` and wrap it in TanStack's per-query persister, which stores one
 * key per query hash instead of the whole cache under one. Pass
 * `persisterFn` as a query's `persister`, and call `restoreQueries` to fill the
 * cache up front.
 *
 * The keys this persister writes all start with `prefix` (default
 * `"tanstack-query"`) followed by a `-`, and the storage is narrowed to exactly
 * that, so the reads behind `restoreQueries`, `persisterGc` and `removeQueries`
 * bring back this app's entries rather than everything else on the worker as
 * well. That is the reason to reach for this over assembling the two halves
 * yourself: they cannot drift apart.
 *
 * The storage stays reachable through the returned `storage` and `dispose()`,
 * for the short-lived persisters — tests, hot reloads, a micro-frontend being
 * unmounted — that have to give the connection back, and through `mode`, for
 * code that wants to know whether anything is being persisted at all.
 *
 * Named after the TanStack function it wraps, and experimental for the same
 * reason: that API's shape may change in a minor release, and this one follows
 * it.
 */
export function experimental_createSharedWorkerQueryPersister(
  options: CreateSharedWorkerQueryPersisterOptions = {},
): SharedWorkerQueryPersister {
  const { timeoutMs, namespace, workerUrl, signal, port, onError, ...persisterOptions } = options;
  const storage = createSharedWorkerStorage({
    timeoutMs,
    namespace,
    workerUrl,
    signal,
    port,
    onError,
    // TanStack joins `prefix` to each query hash with a `-`, and defaults the
    // prefix itself, so the filter is derived from the same two facts rather
    // than restated by the caller.
    entriesPrefix: `${persisterOptions.prefix ?? PERSISTER_KEY_PREFIX}-`,
  });
  const persister = experimental_createQueryPersister({ ...persisterOptions, storage });
  const dispose = () => {
    storage.dispose();
  };
  return { ...persister, storage, mode: storage.mode, dispose, [Symbol.dispose]: dispose };
}
