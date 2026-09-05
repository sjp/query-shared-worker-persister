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
  /**
   * Detach the port handler and reject any in-flight requests. Idempotent: a
   * second call does nothing. Once disposed the storage stays disposed, and
   * every later `getItem`/`setItem`/`removeItem` rejects straight away.
   */
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
 * Reports whether the `SharedWorker` API exists in this environment. Call this
 * to decide up front whether to wire up the persister at all; if you build the
 * storage anyway in an unsupported environment it degrades to a no-op (see
 * {@link createSharedWorkerStorage}) rather than throwing.
 *
 * This is a presence check, not a guarantee that a worker can be constructed:
 * an opaque-origin document (a sandboxed iframe without `allow-same-origin`, or
 * a `blob:`/`data:`/`file:` page) and some privacy or enterprise policies expose
 * the constructor but reject the call. {@link createSharedWorkerStorage} falls
 * back to the same no-op storage when that happens.
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
 * `SharedWorker` is unavailable (e.g. Chrome on Android, some webviews) — or is
 * present but refuses to be constructed, as on an opaque origin — it falls back
 * to a no-op storage — TanStack Query then runs with its normal in-memory cache
 * and no cross-tab persistence — and logs a single warning. Use
 * {@link isSharedWorkerSupported} to detect and branch before reaching this.
 *
 * If the worker fails to start — most often because its asset URL didn't resolve
 * in the consumer's bundle — the failure is permanent: the error is logged once,
 * the port is closed, and every request from then on rejects with that same
 * error straight away rather than waiting out `timeoutMs`. A single
 * undeserializable response is treated as the lesser fault it is: the in-flight
 * requests reject, but the port stays open and later requests may still succeed.
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
  let disposed = false;
  let closed = false;
  // Set once the transport is beyond recovery; every later request rejects with it.
  let fatalError: Error | undefined;

  function rejectPending(error: Error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  /** Detach the port handlers and close it. Safe to call more than once. */
  function closePort() {
    if (closed) return;
    closed = true;
    port.onmessage = null;
    port.onmessageerror = null;
    port.close?.();
  }

  // A transport-level failure can't be tied to a single request id, so reject
  // everything in flight rather than letting each call hang until its timeout.
  // Logged too, since the most likely cause — a misresolved worker asset URL —
  // is otherwise invisible until the 10s timeout.
  //
  // The two failures differ in how much they condemn: a message that can't be
  // deserialized is a single bad response, so the port stays open and later
  // requests are free to succeed, while the worker itself failing means there is
  // nothing left to talk to. The latter is `fatal`: the port is closed and every
  // subsequent request rejects immediately with this same error instead of
  // posting into the void and waiting out its timeout. The error is logged here
  // and only here, so a fatal failure reports once no matter how many requests
  // follow it.
  function handleTransportError(error: Error, fatal: boolean) {
    console.error(`[${PACKAGE_NAME}] ${error.message}`);
    if (fatal) {
      fatalError = error;
      closePort();
    }
    rejectPending(error);
  }

  const connection =
    options.port ??
    connectSharedWorker(options.namespace, (error) => handleTransportError(error, true));

  // Constructing the worker can fail outright rather than failing later through
  // `onerror`; there is no transport to set up in that case, so degrade to the
  // same no-op storage an unsupported environment gets. Past this point the port
  // is known to exist, which is what the closures above assume.
  if (!connection) return createNoopStorage();
  const port: PortAdapter = connection;

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
    handleTransportError(
      new Error("SharedWorker sent a message that could not be deserialized"),
      false,
    );
  };
  port.start?.();

  function request(message: DistributiveOmit<StorageRequest, "id">): Promise<string | null> {
    // Once the port is closed the browser drops `postMessage` silently, so a
    // request issued here would sit in `pending` and only fail at the timeout —
    // a misleading error, ten seconds late, holding a timer the whole way. Fail
    // fast instead, and reject rather than resolve: writes that never reached
    // the worker are surfaced to `createAsyncStoragePersister`'s `retry` hook.
    if (disposed) return Promise.reject(new Error("SharedWorker storage disposed"));
    // Likewise once the worker has failed: there is no port left to answer, so
    // hand back the transport error that explains why rather than a timeout that
    // doesn't.
    if (fatalError) return Promise.reject(fatalError);

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
      if (disposed) return;
      disposed = true;
      rejectPending(new Error("SharedWorker storage disposed"));
      closePort();
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
 * Instantiate the shared `cache.worker.ts` and return its port, or `undefined`
 * if the constructor rejected the call — an opaque origin, a `blob:`/`data:`/
 * `file:` document, or a policy that disables workers all expose `SharedWorker`
 * and then throw on construction. That is reported with the same warning an
 * unsupported environment gets, and the caller degrades to no-op storage.
 * Callers must still have confirmed support (see
 * {@link isSharedWorkerSupported}); reaching here without `SharedWorker` at all
 * would throw a raw `ReferenceError`.
 *
 * `onError` is invoked if the worker itself fails *after* construction (most
 * commonly because its asset URL didn't resolve in the consumer's bundle) so the
 * storage can fail pending requests fast instead of waiting for each to time
 * out. That failure is unrecoverable — there is no worker to reconnect to — so
 * callers are expected to treat it as terminal.
 */
function connectSharedWorker(
  namespace?: string,
  onError?: (error: Error) => void,
): PortAdapter | undefined {
  // This package builds with `vp pack` (tsdown), which ships `cache.worker.ts`
  // as its own sibling entry (`dist/cache.worker.js`) and leaves this
  // `new URL("./cache.worker.js", import.meta.url)` reference untouched, so at
  // runtime it resolves relative to the published module's `import.meta.url`. The
  // consumer's bundler does not re-emit the worker; it only has to trace and copy
  // that sibling file into its output, keeping it same-origin. That same-origin
  // requirement is what lets the SharedWorker actually be shared across tabs (a
  // cross-origin copy would silently break sharing).
  let worker: SharedWorker;
  try {
    worker = new SharedWorker(new URL("./cache.worker.js", import.meta.url), {
      type: "module",
      name: namespace ? `${WORKER_NAME}:${namespace}` : WORKER_NAME,
    });
  } catch (cause) {
    console.warn(
      `[${PACKAGE_NAME}] SharedWorker could not be created in this environment ` +
        `(${cause instanceof Error ? cause.message : String(cause)}); falling back ` +
        "to no-op storage. The query cache will not be persisted or shared across " +
        "tabs.",
    );
    return undefined;
  }
  worker.onerror = (event) => {
    onError?.(new Error(`SharedWorker failed: ${event.message || "worker could not be started"}`));
  };
  return worker.port;
}
