import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import type {
  StorageEntries,
  StorageRequest,
  StorageResponse,
  StorageResult,
} from "./worker/protocol";

/** The minimal `MessagePort` surface we use — lets tests inject a fake port. */
export interface PortAdapter {
  postMessage: (message: StorageRequest) => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  /** Fired when an incoming message can't be deserialized. Real `MessagePort` has this. */
  onmessageerror?: ((event: MessageEvent) => void) | null;
  start?: () => void;
  /** Close the underlying port; called on disposal. Real `MessagePort` has this. */
  close?: () => void;
}

export interface SharedWorkerStorage extends AsyncStorage {
  /**
   * Every key/value pair in the shared store, including any written by other
   * apps sharing the same worker. Always present here (TanStack declares it
   * optional), so this storage can drive `experimental_createQueryPersister`,
   * which needs to iterate the store for `restoreQueries`, `persisterGc` and
   * `removeQueries`.
   *
   * Like `getItem`, this never rejects: a read the worker couldn't answer
   * resolves empty.
   */
  entries: () => Promise<StorageEntries>;
  /**
   * Detach the port handler and settle any in-flight requests. Idempotent: a
   * second call does nothing. Once disposed the storage stays disposed: later
   * writes reject straight away, and later reads resolve empty.
   */
  dispose: () => void;
}

export interface CreateSharedWorkerStorageOptions {
  /** Reject a pending request after this many ms. Default 10s. */
  timeoutMs?: number;
  /**
   * Give this app its own SharedWorker, and its own `CacheStore`, by changing
   * the worker's name. A SharedWorker is identified by `(scriptURL, name)`, and
   * the script URL is the worker asset the page loads, so separately built apps
   * on one origin usually serve that asset from different URLs and get separate
   * workers already. A `namespace` is what keeps apps shipping the *same* worker
   * file — a shell and its micro-frontends, say — out of each other's store.
   *
   * It is not an access boundary: any same-origin script can open that worker
   * under the same name and read every entry in it, just as it could read
   * `localStorage`. Don't store values here you wouldn't put in `localStorage`.
   */
  namespace?: string;
  /**
   * Load the worker from this URL instead of the `dist/cache.worker.js` that
   * ships beside the bundle. The default reference is written as
   * `new URL("./cache.worker.js", import.meta.url)`, which every modern bundler
   * has to recognise inside a dependency in order to copy the asset into the
   * output; point this at a copy you host yourself when your build doesn't. The
   * URL must be same-origin — a cross-origin worker script can't be loaded, so
   * nothing would be shared.
   *
   * The URL is also half of the worker's identity, the other half being `name`,
   * so tabs share a store only while they agree on it: pass the same value in
   * every app that should share, and keep it stable across deployments you want
   * the cache to survive.
   */
  workerUrl?: string | URL;
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
  /** The operation asked for; fixes which result shape the response may carry. */
  op: StorageRequest["op"];
  resolve: (value: StorageResult) => void;
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
 * Build a SharedWorker-backed {@link AsyncStorage}. Every storage method
 * round-trips a {@link StorageRequest} to the worker and awaits the response
 * with the matching `id`, so concurrent calls never cross wires.
 *
 * With no `port` injected this spins up the shared `cache.worker.ts`. When
 * `SharedWorker` is unavailable (e.g. Chrome on Android, some webviews) — or is
 * present but refuses to be constructed, as on an opaque origin — it falls back
 * to a no-op storage — TanStack Query then runs with its normal in-memory cache
 * and no cross-tab persistence — and logs a single warning. Use
 * {@link isSharedWorkerSupported} to detect and branch before reaching this.
 *
 * If the worker fails to start — most often because its asset URL didn't resolve
 * in the consumer's bundle, which `workerUrl` exists to work around — the failure
 * is permanent: the error is logged once,
 * the port is closed, and every write from then on rejects with that same
 * error straight away rather than waiting out `timeoutMs`. A single
 * undeserializable response is treated as the lesser fault it is: the in-flight
 * requests settle, but the port stays open and later requests may still succeed.
 *
 * Reads (`getItem` and `entries`) never reject at all: a read the worker
 * couldn't answer resolves empty and is logged, so an unreachable cache looks
 * like an empty one rather than a corrupt one — which `persistQueryClient`
 * would answer by clearing the entry for every tab.
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
    options.port ?? connectSharedWorker(options, (error) => handleTransportError(error, true));

  // Constructing the worker can fail outright rather than failing later through
  // `onerror`; there is no transport to set up in that case, so degrade to the
  // same no-op storage an unsupported environment gets. Past this point the port
  // is known to exist, which is what the closures above assume.
  if (!connection) return createNoopStorage();
  const port: PortAdapter = connection;

  port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    // The worker is shared by `(scriptURL, name)`, so any same-origin script can
    // open the same port and post to it. Only messages shaped like our responses
    // are allowed to settle a pending request; everything else is not ours.
    if (!isStorageResponse(message)) return;
    const entry = pending.get(message.id);
    if (!entry) return; // already timed out, or a stray message — ignore
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      // The envelope alone doesn't say which result shape is legal - that
      // follows from the request. Checking it against the operation we sent
      // keeps a reply from resolving `getItem` with an array, or `entries` with
      // a bare string, in a caller that has no reason to expect either.
      if (matchesOperation(entry.op, message.result)) entry.resolve(message.result);
      else entry.reject(new Error(`SharedWorker returned an unexpected ${entry.op} result`));
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

  function request(message: DistributiveOmit<StorageRequest, "id">): Promise<StorageResult> {
    // Once the port is closed the browser drops `postMessage` silently, so a
    // request issued here would sit in `pending` and only fail at the timeout —
    // a misleading error, ten seconds late, holding a timer the whole way. Fail
    // fast instead. Writes reject rather than resolve, so one that never reached
    // the worker is surfaced to `createAsyncStoragePersister`'s `retry` hook;
    // `read` converts the same rejection into an empty result for reads.
    if (disposed) return Promise.reject(new Error("SharedWorker storage disposed"));
    // Likewise once the worker has failed: there is no port left to answer, so
    // hand back the transport error that explains why rather than a timeout that
    // doesn't.
    if (fatalError) return Promise.reject(fatalError);

    const id = nextId++;
    return new Promise<StorageResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`SharedWorker storage request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { op: message.op, resolve, reject, timer });
      port.postMessage({ ...message, id } as StorageRequest);
    });
  }

  /**
   * Run a read, turning any failure into "the store holds nothing" rather than
   * a rejection.
   *
   * This isn't leniency for its own sake. `persistQueryClient` reads a rejected
   * restore as a corrupt cache and responds by calling `removeClient()`, which
   * deletes the entry in the worker — and the worker's store belongs to every
   * connected tab. So a tab that merely read too slowly (a heavy page, a
   * throttled background tab, a worker starting under load) would not just fail
   * to warm itself, it would erase the cache the other tabs are living off.
   * Resolving empty makes that tab fetch from the network and leave the shared
   * store alone. A `buster` or `maxAge` mismatch still clears the entry, since
   * that path never goes through a failed read.
   *
   * Writes keep rejecting: a save that didn't happen has to reach the
   * persister's `retry` hook, and no failed write can destroy another tab's
   * data.
   */
  function read(
    message: DistributiveOmit<StorageRequest, "id">,
    empty: StorageResult,
  ): Promise<StorageResult> {
    return request(message).catch((error: unknown) => {
      // A fatal transport failure is already reported where it happens, once.
      // Everything else — a timeout, a worker-side error, a reply that broke
      // the protocol — is reported here, so a cache that silently stays cold
      // still says why.
      if (error !== fatalError) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(
          `[${PACKAGE_NAME}] Could not read from the SharedWorker cache (${reason}); ` +
            "continuing as though it were empty.",
        );
      }
      return empty;
    });
  }

  // Each method narrows the shared result type to the shape its operation is
  // defined to return. The cast is sound because `request` only resolves a
  // result that matched the operation it was sent for, and a read that failed
  // falls back to the empty value of that same shape.
  const storage: SharedWorkerStorage = {
    getItem: (key) => read({ kind: "request", op: "getItem", key }, null) as Promise<string | null>,
    entries: () => read({ kind: "request", op: "entries" }, []) as Promise<StorageEntries>,
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
 * Whether `data` is a well-formed {@link StorageResponse}. Checked field by
 * field rather than trusting the declared `MessageEvent` type, which says
 * nothing about what actually arrives on the port. An `ok: true` message whose
 * `result` is missing fails this test, so a request is never resolved with a
 * value the protocol doesn't allow.
 */
function isStorageResponse(data: unknown): data is StorageResponse {
  if (typeof data !== "object" || data === null) return false;
  const message = data as Record<string, unknown>;
  if (message.kind !== "response" || typeof message.id !== "number") return false;
  if (message.ok === true) return isStorageResult(message.result);
  return message.ok === false && typeof message.error === "string";
}

/** Whether `value` is one of the result shapes the protocol allows at all. */
function isStorageResult(value: unknown): value is StorageResult {
  return typeof value === "string" || value === null || isStorageEntries(value);
}

/** Whether `value` is an array of `[key, value]` string pairs. */
function isStorageEntries(value: unknown): value is StorageEntries {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

/** Whether `result` is the shape `op` is defined to answer with. */
function matchesOperation(op: StorageRequest["op"], result: StorageResult): boolean {
  return op === "entries"
    ? isStorageEntries(result)
    : typeof result === "string" || result === null;
}

/**
 * Storage that quietly does nothing: `getItem` always resolves `null` and
 * `entries` an empty array (so TanStack Query restores nothing and just
 * fetches), and writes are dropped.
 * Returned when `SharedWorker` is unavailable so callers can keep one code path.
 */
function createNoopStorage(): SharedWorkerStorage {
  return {
    getItem: () => Promise.resolve(null),
    entries: () => Promise.resolve([]),
    setItem: () => Promise.resolve(),
    removeItem: () => Promise.resolve(),
    dispose: () => {},
  };
}

/**
 * Base SharedWorker name; a `namespace` is appended to it. The name and the
 * worker's script URL together identify the worker, so tabs share a store only
 * when both match.
 */
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
 * commonly because its asset URL didn't resolve in the consumer's bundle, which
 * `workerUrl` overrides) so the
 * storage can fail pending requests fast instead of waiting for each to time
 * out. That failure is unrecoverable — there is no worker to reconnect to — so
 * callers are expected to treat it as terminal.
 */
function connectSharedWorker(
  options: CreateSharedWorkerStorageOptions,
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
  //
  // This URL is also half of the worker's identity, the other half being `name`,
  // so tabs share a worker only while they load the asset from the same URL. A
  // deployment that changes it — a content hash, typically — gives new tabs a
  // fresh, empty worker while already-open tabs keep talking to the old one.
  //
  // A build that can't do that tracing is what `workerUrl` is for: it names a
  // copy the consumer hosts themselves, and the resolution below is skipped.
  const { namespace, workerUrl } = options;
  let worker: SharedWorker;
  try {
    worker = new SharedWorker(workerUrl ?? new URL("./cache.worker.js", import.meta.url), {
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
