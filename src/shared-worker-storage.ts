import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import type { StorageRequest, StorageResponse } from "./worker/protocol";

/** The minimal `MessagePort` surface we use — lets tests inject a fake port. */
export interface PortAdapter {
  postMessage: (message: StorageRequest) => void;
  onmessage: ((event: MessageEvent<StorageResponse>) => void) | null;
  /** Fired when an incoming message can't be deserialized. Real `MessagePort` has this. */
  onmessageerror?: ((event: MessageEvent) => void) | null;
  start?: () => void;
  /** Close the underlying port; called on disposal. Real `MessagePort` has this. */
  close?: () => void;
}

export interface SharedWorkerStorage extends AsyncStorage {
  /** Detach the port handler and reject any in-flight requests. */
  dispose: () => void;
}

export interface CreateSharedWorkerStorageOptions {
  /** Reject a pending request after this many ms. Default 10s. */
  timeoutMs?: number;
  /**
   * Isolate this app's cache in its own SharedWorker process. SharedWorkers are
   * keyed by `(scriptURL, name)`, so every app on an origin otherwise shares one
   * worker — and any same-origin context can read the whole store. Pass a unique
   * `namespace` to get a dedicated worker (and a dedicated `CacheStore`) instead.
   * Omit it to keep the shared default.
   */
  namespace?: string;
  /**
   * Tear the storage down when this signal aborts — reject any in-flight
   * requests and detach the port, exactly as calling `dispose()` would. Lets
   * callers that only hold the persister (e.g. via `createSharedWorkerPersister`)
   * still bound its lifetime. If the signal is already aborted, the storage is
   * disposed immediately.
   */
  signal?: AbortSignal;
  /**
   * Inject a port instead of creating a real `SharedWorker`. Used by tests to
   * pipe messages through an in-process store; not needed in app code.
   */
  port?: PortAdapter;
}

/** `Omit` that distributes over a union, preserving per-variant fields like `value`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A request awaiting its matching response, plus the timer that will reject it. */
interface Pending {
  resolve: (value: string | null) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Reports whether SharedWorker-backed storage can run in this environment.
 * Call this to decide up front whether to wire up the persister at all; if you
 * build the storage anyway in an unsupported environment it degrades to a no-op
 * (see {@link createSharedWorkerStorage}) rather than throwing.
 */
export function isSharedWorkerSupported(): boolean {
  return typeof SharedWorker !== "undefined";
}

/**
 * Build a SharedWorker-backed {@link AsyncStorage}. All three storage methods
 * round-trip a {@link StorageRequest} to the worker and await the response with
 * the matching `id`, so concurrent calls never cross wires.
 *
 * With no `port` injected this spins up the shared `cache.worker.ts`. When
 * `SharedWorker` is unavailable (e.g. Chrome on Android, some webviews) it falls
 * back to a no-op storage — TanStack Query then runs with its normal in-memory
 * cache and no cross-tab persistence — and logs a single warning. Use
 * {@link isSharedWorkerSupported} to detect and branch before reaching this.
 */
export function createSharedWorkerStorage(
  options: CreateSharedWorkerStorageOptions = {},
): SharedWorkerStorage {
  const { timeoutMs = 10_000 } = options;

  if (!options.port && !isSharedWorkerSupported()) {
    console.warn(
      `[${PACKAGE_NAME}] SharedWorker is unavailable in this environment; ` +
        "falling back to no-op storage. The query cache will not be persisted or " +
        "shared across tabs. Use isSharedWorkerSupported() to branch beforehand.",
    );
    return createNoopStorage();
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;

  // A transport-level failure (worker failed to load, or a response that can't be
  // deserialized) can't be tied to a single request id, so reject everything
  // in flight rather than letting each call hang until its timeout. Logged too,
  // since the most likely cause — a misresolved worker asset URL — is otherwise
  // invisible until the 10s timeout.
  function handleTransportError(error: Error) {
    console.error(`[${PACKAGE_NAME}] ${error.message}`);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  const port = options.port ?? connectSharedWorker(options.namespace, handleTransportError);

  port.onmessage = (event: MessageEvent<StorageResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return; // already timed out, or a stray message — ignore
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(message.error));
    }
  };
  port.onmessageerror = () => {
    handleTransportError(new Error("SharedWorker sent a message that could not be deserialized"));
  };
  port.start?.();

  function request(message: DistributiveOmit<StorageRequest, "id">): Promise<string | null> {
    const id = nextId++;
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`SharedWorker storage request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ ...message, id } as StorageRequest);
    });
  }

  const storage: SharedWorkerStorage = {
    getItem: (key) => request({ kind: "request", op: "getItem", key }),
    setItem: async (key, value) => {
      await request({ kind: "request", op: "setItem", key, value });
    },
    removeItem: async (key) => {
      await request({ kind: "request", op: "removeItem", key });
    },
    dispose: () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("SharedWorker storage disposed"));
      }
      pending.clear();
      port.onmessage = null;
      port.onmessageerror = null;
      port.close?.();
    },
  };

  // Bind disposal to the caller's signal. `dispose` is idempotent, so an abort
  // after a manual dispose (or vice versa) is harmless.
  if (options.signal) {
    if (options.signal.aborted) storage.dispose();
    else options.signal.addEventListener("abort", () => storage.dispose(), { once: true });
  }

  return storage;
}

/** Used to prefix the console warning so it's traceable to this package. */
const PACKAGE_NAME = "@sjpnz/query-shared-worker-persister";

/**
 * Storage that quietly does nothing: `getItem` always resolves `null` (so
 * TanStack Query restores nothing and just fetches), and writes are dropped.
 * Returned when `SharedWorker` is unavailable so callers can keep one code path.
 */
function createNoopStorage(): SharedWorkerStorage {
  return {
    getItem: () => Promise.resolve(null),
    setItem: () => Promise.resolve(),
    removeItem: () => Promise.resolve(),
    dispose: () => {},
  };
}

/** Base SharedWorker name; a `namespace` is appended to isolate per app. */
const WORKER_NAME = "TANSTACK_QUERY_SHARED_CACHE_WORKER";

/**
 * Instantiate the shared `cache.worker.ts` and return its port. Callers must
 * have confirmed support (see {@link isSharedWorkerSupported}); reaching here
 * without `SharedWorker` would throw a raw `ReferenceError`.
 *
 * `onError` is invoked if the worker itself fails (most commonly because its
 * asset URL didn't resolve in the consumer's bundle) so the storage can fail
 * pending requests fast instead of waiting for each to time out.
 */
function connectSharedWorker(
  namespace?: string,
  onError?: (error: Error) => void,
): PortAdapter {
  // The `new URL(..., import.meta.url)` + `new SharedWorker` pattern is resolved
  // at *build time* by this package's own bundler (Vite/Rolldown via `vp build`):
  // it emits the worker as a hashed asset (`dist/assets/cache.worker-*.js`) and
  // rewrites this reference to point at it, relative to the published module's
  // `import.meta.url`. So the shipped artifact already carries the real worker
  // URL — the consumer's bundler does not re-emit it; it only has to trace and
  // copy that sibling asset into its output, keeping it same-origin. That
  // same-origin requirement is what lets the SharedWorker actually be shared
  // across tabs (a cross-origin copy would silently break sharing).
  const worker = new SharedWorker(new URL("./cache.worker.js", import.meta.url), {
    type: "module",
    name: namespace ? `${WORKER_NAME}:${namespace}` : WORKER_NAME,
  });
  worker.onerror = (event) => {
    onError?.(new Error(`SharedWorker failed: ${event.message || "worker could not be started"}`));
  };
  return worker.port;
}
