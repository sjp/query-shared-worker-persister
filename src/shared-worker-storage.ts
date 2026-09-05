import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import {
  PROTOCOL_VERSION,
  UNVERSIONED_PROTOCOL_VERSION,
  type StorageEntries,
  type StorageRequest,
  type StorageResponse,
  type StorageResult,
} from "./worker/protocol";

/** Prefixes console output so a line is traceable to this package. */
const PACKAGE_NAME = "@sjpnz/query-shared-worker-persister";

/**
 * Base SharedWorker name; a `namespace` is appended to it. The name and the
 * worker's script URL together identify the worker, so tabs share a store only
 * when both match.
 */
const WORKER_NAME = "TANSTACK_QUERY_SHARED_CACHE_WORKER";

/**
 * The longest delay `setTimeout` can hold. The delay is stored as a 32-bit
 * signed integer, and a larger one overflows: browsers fire it on the next
 * tick, Node warns and treats it as 1ms. Either way a `timeoutMs` above this
 * would expire immediately rather than far in the future, which is the opposite
 * of what the caller asked for. Rejected up front rather than clamped, since
 * silently substituting a different deadline is its own surprise; `Infinity` is
 * the way to say "wait as long as it takes".
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Which kind of failure a {@link SharedWorkerStorageError} describes. */
export type SharedWorkerStorageErrorCode =
  | "unsupported"
  | "transport"
  | "timeout"
  | "protocol"
  | "disposed";

/**
 * Every failure this package raises or reports, tagged with a `code` so callers
 * can branch on the cause instead of matching on message text:
 *
 * - `unsupported` — there is no `SharedWorker` here, or the constructor refused
 *   the call. The storage handed back is the no-op one, so nothing is persisted.
 * - `transport` — the worker failed after it was constructed, or sent a message
 *   that could not be deserialized. The first of those is terminal.
 * - `timeout` — the worker did not answer within `timeoutMs`.
 * - `protocol` — the worker answered, but with an error, with a result that
 *   doesn't fit the operation it was sent, or in a protocol version this build
 *   doesn't speak.
 * - `disposed` — the request was made after `dispose()`.
 *
 * These reach a caller two ways: as the rejection of a write, and through
 * {@link CreateSharedWorkerStorageOptions.onError}. Where one failure was caused
 * by another — the `DOMException` from a refused constructor, or the request
 * failure behind a read that resolved empty — that other error is the `cause`.
 */
export class SharedWorkerStorageError extends Error {
  readonly code: SharedWorkerStorageErrorCode;

  constructor(code: SharedWorkerStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SharedWorkerStorageError";
    this.code = code;
  }
}

/**
 * The minimal `MessagePort` surface this package uses. A real `SharedWorker`
 * port satisfies it, and so does anything else that can carry a
 * {@link StorageRequest} out and a {@link StorageResponse} back — an in-process
 * fake in a test, or another transport entirely. Pass one as
 * {@link CreateSharedWorkerStorageOptions.port}.
 *
 * Only `postMessage` and `onmessage` are required; the optional members are
 * used when present, so a fake need only implement the parts its test cares
 * about.
 */
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
   * `"shared-worker"` when a transport was established, `"noop"` when one could
   * not be and this storage discards everything written to it — the fallback
   * taken when `SharedWorker` is missing or refuses to be constructed. Fixed for
   * the life of the storage: a worker that fails *after* construction leaves
   * this `"shared-worker"`, and is reported through
   * {@link CreateSharedWorkerStorageOptions.onError} instead. A storage built
   * from an already-aborted signal opens no transport either, and names the one
   * it would have used.
   */
  readonly mode: "shared-worker" | "noop";
  /**
   * Detach this storage's handlers and settle any in-flight requests.
   * Idempotent: a second call does nothing. Once disposed the storage stays
   * disposed: later writes reject straight away, later reads resolve empty, and
   * a worker that fails afterwards is neither recorded nor reported.
   */
  dispose: () => void;
  /**
   * The same teardown as {@link SharedWorkerStorage.dispose}, under the well-known
   * symbol, so a storage whose lifetime matches a block can be declared with
   * `using` and released on the way out:
   *
   * ```ts
   * using storage = createSharedWorkerStorage();
   * ```
   *
   * Needs TypeScript 5.2 or newer to compile, and a runtime with
   * `Symbol.dispose` (or a polyfill for it) to run.
   */
  [Symbol.dispose]: () => void;
}

// Every option below spells out `| undefined` rather than relying on `?` alone,
// so a caller building this object conditionally — `{ namespace: flag ? id :
// undefined }` — is still passing a valid one under `exactOptionalPropertyTypes`,
// which otherwise distinguishes an absent key from a key set to `undefined`.
// Omitting an option and passing it as `undefined` mean the same thing here.
export interface CreateSharedWorkerStorageOptions {
  /**
   * Reject a pending request after this many ms. Default 10s.
   *
   * Must be greater than `0` and at most `2147483647` (about 24.8 days), which
   * is the largest delay a timer can hold; `Infinity` is also accepted and
   * means no timeout at all, leaving a request to be settled by the worker's
   * answer, a transport failure or `dispose()`. Anything else — `0`, a negative
   * number, `NaN`, or a finite value past the limit — throws a `RangeError`
   * when the storage is created, because each of them would otherwise time
   * every request out immediately and leave the cache permanently cold.
   */
  timeoutMs?: number | undefined;
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
  namespace?: string | undefined;
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
  workerUrl?: string | URL | undefined;
  /**
   * Tear the storage down when this signal aborts — reject any in-flight
   * requests and detach the port, exactly as calling `dispose()` would. Lets
   * callers that only hold the persister (e.g. via `createSharedWorkerPersister`)
   * still bound its lifetime. A signal that has already aborted is honoured
   * before anything is set up: no worker is constructed for a storage that is
   * over before it began, and the one handed back is already disposed.
   */
  signal?: AbortSignal | undefined;
  /**
   * Carry the protocol over this {@link PortAdapter} instead of constructing a
   * `SharedWorker`. Chiefly a test seam — pipe the messages through an
   * in-process store and the storage becomes synchronous to drive — but any
   * transport that can move a {@link StorageRequest} and return the matching
   * {@link StorageResponse} works. Application code doesn't need it.
   *
   * Supplying a port replaces worker construction entirely, so `namespace` and
   * `workerUrl` are ignored, no support check is made, and the storage never
   * falls back to no-op. Disposal still closes the port if it has a `close`.
   */
  port?: PortAdapter | undefined;
  /**
   * Take the warnings and errors this package would otherwise write to the
   * console: the no-op fallback, a worker that failed, a read that resolved
   * empty because nothing could answer it. Supplying this replaces the console
   * output entirely, so a structured logger or an error reporter can receive
   * them instead — and `() => {}` is how you silence them.
   *
   * Each error carries a {@link SharedWorkerStorageError.code} saying which kind
   * of failure it was; the `"unsupported"` one is the report that says the
   * storage you were handed persists nothing. That one is raised only where a
   * `SharedWorker` could have existed: outside a document — on a server or in an
   * edge runtime, where the module that builds the persister is evaluated too —
   * the no-op storage is handed back silently, since there is nothing there for
   * a handler to act on.
   *
   * Purely diagnostic — what is reported here doesn't change how any call
   * settles, and that holds even if this callback throws: the throw is caught
   * and written to the console alongside the error it interrupted, and the call
   * that reported settles exactly as it would have. A failed write isn't
   * reported, since its rejection already carries the error; a failed read is,
   * because resolving empty hides it.
   */
  onError?: ((error: SharedWorkerStorageError) => void) | undefined;
}

/** A request awaiting its matching response, plus the timer that will reject it. */
interface Pending {
  /** The operation asked for; fixes which result shape the response may carry. */
  op: StorageRequest["op"];
  resolve: (value: StorageResult) => void;
  reject: (reason: Error) => void;
  /** Absent when `timeoutMs` is `Infinity`, where the request has no deadline. */
  timer: ReturnType<typeof setTimeout> | undefined;
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
 * Whether this is a page rather than a server or edge runtime, which is what
 * decides whether a missing `SharedWorker` is worth saying anything about. A
 * browser without the API is a fallback the developer should hear about; a
 * server never had one and never will, so there is nothing there to act on.
 *
 * `document` is the test because it is the global a page has and a server-side
 * runtime does not, and because the browser-simulating test environments
 * (jsdom, happy-dom) define it — so an application's own tests keep seeing the
 * report, which is where it is most useful.
 */
function isDocumentEnvironment(): boolean {
  return typeof document !== "undefined";
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
 * and no cross-tab persistence — and reports it once. Where there is no document
 * at all, as on a server rendering the page, the same fallback is handed back
 * without a report: nothing there could have had a worker. Use
 * {@link isSharedWorkerSupported} to detect and branch before reaching this, or
 * read `mode` on the result to see which storage you were given.
 *
 * If the worker fails to start — most often because its asset URL didn't resolve
 * in the consumer's bundle, which `workerUrl` exists to work around — the failure
 * is permanent: the error is reported once,
 * the port is closed, and every write from then on rejects with that same
 * error straight away rather than waiting out `timeoutMs`. A single
 * undeserializable response is treated as the lesser fault it is: it is
 * reported and nothing else, so the port stays open, the requests in flight
 * settle on their own responses, and only the request whose answer was lost
 * falls to its timeout.
 *
 * Reads (`getItem` and `entries`) never reject at all: a read the worker
 * couldn't answer resolves empty and is reported, so an unreachable cache looks
 * like an empty one rather than a corrupt one — which `persistQueryClient`
 * would answer by clearing the entry for every tab.
 *
 * Everything reported goes to the console unless `onError` is supplied, in which
 * case it goes there and the console is left alone. Each report is a
 * {@link SharedWorkerStorageError} carrying a `code` for the kind of failure.
 *
 * An out-of-range `timeoutMs` is the one thing that throws rather than being
 * reported: it is a programming error, and a deadline no timer can honour would
 * otherwise leave the cache silently and permanently cold. See
 * {@link CreateSharedWorkerStorageOptions.timeoutMs} for the accepted range.
 */
export function createSharedWorkerStorage(
  options: CreateSharedWorkerStorageOptions = {},
): SharedWorkerStorage {
  const { timeoutMs = 10_000 } = options;
  // Before the support check, so a bad option is a hard error everywhere rather
  // than one that only surfaces in environments that have a SharedWorker.
  validateTimeoutMs(timeoutMs);

  // A signal that aborted before this call asks for a storage that is over
  // before it begins. Nothing is set up for one: no worker is constructed only
  // to be closed again, and nothing is reported about an environment the caller
  // has already stopped caring about. What comes back is what a `dispose()`
  // straight after construction leaves behind.
  const abortedUpFront = options.signal?.aborted === true;

  if (!options.port && !isSharedWorkerSupported()) {
    // Worth saying only for a storage that is going to be used, in a place that
    // could have had a worker. The fallback is still what an aborted caller and
    // a server get, so `mode` still reports it either way.
    if (!abortedUpFront && isDocumentEnvironment()) {
      report(
        options,
        "warn",
        new SharedWorkerStorageError(
          "unsupported",
          "SharedWorker is unavailable in this environment; falling back to no-op " +
            "storage. The query cache will not be persisted or shared across tabs. " +
            "Use isSharedWorkerSupported() to branch beforehand.",
        ),
      );
    }
    return createNoopStorage();
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  // An already-aborted signal starts the storage in the state `dispose()` would
  // leave it in, which is also what keeps a transport from being opened below.
  let disposed = abortedUpFront;
  let closed = false;
  // Set once the transport is beyond recovery; every later request rejects with it.
  let fatalError: SharedWorkerStorageError | undefined;

  function rejectPending(error: SharedWorkerStorageError) {
    for (const entry of pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  /**
   * Detach every handler this storage installed and close the port. Safe to
   * call more than once. Detaching matters as much as closing: a handler left
   * on the `SharedWorker` object keeps the whole storage — its pending map, its
   * options, its port — reachable from an event that may never fire.
   */
  function closePort() {
    if (closed) return;
    closed = true;
    // A storage disposed before it opened a connection has nothing to detach.
    if (!connection) return;
    connection.detach();
    connection.port.onmessage = null;
    connection.port.onmessageerror = null;
    connection.port.close?.();
  }

  // The worker itself failing leaves nothing to talk to, and the failure can't
  // be tied to a single request id. So the port is closed, everything in flight
  // is rejected rather than left to hang until its timeout, and every later
  // request rejects immediately with this same error instead of posting into
  // the void. Reported too, since the most likely cause — a misresolved worker
  // asset URL — is otherwise invisible until the 10s timeout; reported here and
  // only here, so one dead worker is one report no matter how many requests
  // follow it.
  //
  // The bookkeeping runs before the report, so the storage is left consistent
  // whatever the caller's reporter does with the error it is handed.
  function handleWorkerFailure(error: SharedWorkerStorageError) {
    // A worker that dies after the caller let go of the storage is not news:
    // every request is already rejecting with `disposed`, and nothing the
    // caller could do would change that. Leave the error state alone and say
    // nothing.
    if (disposed) return;
    fatalError = error;
    closePort();
    rejectPending(error);
    report(options, "error", error);
  }

  // A storage that is already disposed has nothing to say and nowhere to say
  // it, so no worker is constructed and an injected port is left as it was
  // found — never started, never closed, still the caller's to use.
  const connection = abortedUpFront
    ? undefined
    : options.port
      ? // An injected port is the caller's own transport: there is no worker
        // behind it and so nothing of ours to take back off it.
        { port: options.port, detach: () => {} }
      : connectSharedWorker(options, handleWorkerFailure);
  const port = connection?.port;

  // Constructing the worker can fail outright rather than failing later through
  // `onerror`; there is no transport to set up in that case, so degrade to the
  // same no-op storage an unsupported environment gets. The other way to reach
  // here without a port is the aborted signal above, which keeps its storage.
  if (!port && !abortedUpFront) return createNoopStorage();

  // Only a storage that has a port has anything to listen to or start.
  if (port) {
    port.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      // The worker is shared by `(scriptURL, name)`, so any same-origin script
      // can open the same port and post to it. Only messages shaped like our
      // responses are allowed to settle a pending request; everything else is
      // not ours.
      if (!isStorageResponse(message)) return;
      const entry = pending.get(message.id);
      if (!entry) return; // already timed out, or a stray message — ignore
      pending.delete(message.id);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      // The worker runs whichever build of this package the first tab to
      // connect loaded, which need not be this one. A response written to a
      // wire format this build doesn't speak can't be read as one, so it fails
      // the request rather than being decoded on the chance that it fits, and
      // names both versions so the mismatch isn't mistaken for a bad worker.
      const version = message.version ?? UNVERSIONED_PROTOCOL_VERSION;
      if (version !== PROTOCOL_VERSION) {
        entry.reject(
          new SharedWorkerStorageError(
            "protocol",
            `SharedWorker speaks protocol version ${version}, this build speaks ${PROTOCOL_VERSION}`,
          ),
        );
        return;
      }
      if (message.ok) {
        // The envelope alone doesn't say which result shape is legal - that
        // follows from the request. Checking it against the operation we sent
        // keeps a reply from resolving `getItem` with an array, or `entries`
        // with a bare string, in a caller that has no reason to expect either.
        if (matchesOperation(entry.op, message.result)) entry.resolve(message.result);
        else {
          entry.reject(
            new SharedWorkerStorageError(
              "protocol",
              `SharedWorker returned an unexpected ${entry.op} result`,
            ),
          );
        }
      } else {
        entry.reject(new SharedWorkerStorageError("protocol", message.error));
      }
    };
    // One response the structured clone algorithm couldn't reconstruct. The
    // event says nothing about which request it belonged to, and the port is
    // still good, so this is reported and otherwise left alone: the one request
    // whose answer was lost settles by its own timeout, and every other request
    // in flight goes on to settle on its own response. Rejecting the whole
    // pending map here would instead fail concurrent writes for a fault that
    // was not theirs and resolve concurrent reads empty, and each of those
    // reads would report the same bad message a second time.
    port.onmessageerror = () => {
      report(
        options,
        "error",
        new SharedWorkerStorageError(
          "transport",
          "SharedWorker sent a message that could not be deserialized",
        ),
      );
    };
    port.start?.();
  }

  /**
   * Post one request and resolve with its response. The caller supplies a
   * builder rather than a finished message because the `id` is allocated here:
   * handing the builder the id lets it construct a whole {@link StorageRequest}
   * in one go, so the message is type checked against the operation it names
   * instead of being assembled from a partial and cast back.
   */
  function request(build: (id: number) => StorageRequest): Promise<StorageResult> {
    // Once the port is closed the browser drops `postMessage` silently, so a
    // request issued here would sit in `pending` and only fail at the timeout —
    // a misleading error, ten seconds late, holding a timer the whole way. Fail
    // fast instead. Writes reject rather than resolve, so one that never reached
    // the worker is surfaced to `createAsyncStoragePersister`'s `retry` hook;
    // `read` converts the same rejection into an empty result for reads.
    // A missing port says the same thing as `disposed`, since the only storage
    // built without one is the storage that was disposed before it opened one;
    // checking it here is also what leaves something to post to below.
    if (disposed || !port) return Promise.reject(disposedError());
    // Likewise once the worker has failed: there is no port left to answer, so
    // hand back the transport error that explains why rather than a timeout that
    // doesn't.
    if (fatalError) return Promise.reject(fatalError);

    const id = nextId++;
    const message = build(id);
    return new Promise<StorageResult>((resolve, reject) => {
      // `Infinity` asks for no deadline at all, so no timer is created: the
      // request stays pending until the worker answers, the transport fails, or
      // the storage is disposed.
      const timer =
        timeoutMs === Number.POSITIVE_INFINITY
          ? undefined
          : setTimeout(() => {
              pending.delete(id);
              reject(
                new SharedWorkerStorageError(
                  "timeout",
                  `SharedWorker storage request timed out after ${timeoutMs}ms`,
                ),
              );
            }, timeoutMs);
      pending.set(id, { op: message.op, resolve, reject, timer });
      // A port can refuse the message itself — a real `MessagePort` throws when
      // a value cannot be structured-cloned. The throw would otherwise escape
      // the executor and reject this promise while leaving the timer scheduled
      // and the entry in `pending`, so a request that never left the tab would
      // still be settled a second time at its deadline. Unwind it here instead,
      // and reject with the same error shape the rest of the transport uses so
      // a caller branching on `code` — or a read turning the failure into an
      // empty result — sees no special case.
      try {
        // Stamped here rather than in each builder above so every request
        // carries it, and so a builder stays free to name only its operation.
        port.postMessage({ ...message, version: PROTOCOL_VERSION });
      } catch (cause) {
        pending.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        reject(
          new SharedWorkerStorageError(
            "transport",
            "Could not post a request to the SharedWorker " +
              `(${cause instanceof Error ? cause.message : String(cause)})`,
            { cause },
          ),
        );
      }
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
    build: (id: number) => StorageRequest,
    empty: StorageResult,
  ): Promise<StorageResult> {
    return request(build).catch((error: unknown) => {
      // A fatal transport failure is already reported where it happens, once.
      // Everything else — a timeout, a worker-side error, a reply that broke
      // the protocol — is reported here, so a cache that silently stays cold
      // still says why.
      if (error !== fatalError) {
        const reason = error instanceof Error ? error.message : String(error);
        // Reported under the code of the failure behind it, which is also kept
        // as the `cause`: a caller filtering on `timeout` wants this read too.
        report(
          options,
          "warn",
          new SharedWorkerStorageError(
            error instanceof SharedWorkerStorageError ? error.code : "transport",
            `Could not read from the SharedWorker cache (${reason}); ` +
              "continuing as though it were empty.",
            { cause: error },
          ),
        );
      }
      return empty;
    });
  }

  // Set below when a `signal` is supplied; detaches the abort listener so a
  // manual `dispose()` doesn't leave this storage — its pending map and its
  // closed port — reachable from a signal that may never abort.
  let detachAbortListener: (() => void) | undefined;

  function dispose() {
    if (disposed) return;
    disposed = true;
    detachAbortListener?.();
    detachAbortListener = undefined;
    rejectPending(disposedError());
    closePort();
  }

  // Each method narrows the shared result type to the shape its operation is
  // defined to return. The cast is sound because `request` only resolves a
  // result that matched the operation it was sent for, and a read that failed
  // falls back to the empty value of that same shape.
  const storage: SharedWorkerStorage = {
    mode: "shared-worker",
    getItem: (key) =>
      read((id) => ({ kind: "request", id, op: "getItem", key }), null) as Promise<string | null>,
    entries: () =>
      read((id) => ({ kind: "request", id, op: "entries" }), []) as Promise<StorageEntries>,
    setItem: async (key, value) => {
      await request((id) => ({ kind: "request", id, op: "setItem", key, value }));
    },
    removeItem: async (key) => {
      await request((id) => ({ kind: "request", id, op: "removeItem", key }));
    },
    dispose,
    // The symbol is read when the storage is built rather than when this module
    // loads, so a runtime polyfilled during application startup still installs
    // the method under the symbol `using` will look for.
    [Symbol.dispose]: dispose,
  };

  // Bind disposal to the caller's signal. `dispose` is idempotent, so an abort
  // after a manual dispose (or vice versa) is harmless. A manual dispose also
  // removes the listener: the signal may outlive many storages — one
  // long-lived controller shared by a component that remounts, say — and each
  // listener left on it pins the storage it closes over.
  //
  // A signal that had already aborted needs no listener at all: the storage was
  // built disposed, and a second abort would have nothing left to tear down.
  if (options.signal && !abortedUpFront) {
    const signal = options.signal;
    const onAbort = () => dispose();
    signal.addEventListener("abort", onAbort, { once: true });
    detachAbortListener = () => signal.removeEventListener("abort", onAbort);
  }

  return storage;
}

/**
 * Send a diagnostic to the caller's `onError`, or to the console when there is
 * none. `level` picks the console method only; a caller taking these over gets
 * one channel and sorts by the error's `code`.
 *
 * Never throws. Reporting is woven through paths that promise something to the
 * caller — a read resolving empty, a fatal failure closing the port and
 * rejecting what was in flight — and a reporter that threw would otherwise
 * break the promise it was only meant to describe. A throw is caught and
 * written to the console, together with the report it interrupted, so a broken
 * logger is visible rather than silent.
 */
function report(
  options: CreateSharedWorkerStorageOptions,
  level: "warn" | "error",
  error: SharedWorkerStorageError,
): void {
  if (!options.onError) {
    console[level](`[${PACKAGE_NAME}] ${error.message}`);
    return;
  }
  try {
    options.onError(error);
  } catch (thrown) {
    console.error(
      `[${PACKAGE_NAME}] The onError handler threw while reporting: ${error.message}`,
      thrown,
      error,
    );
  }
}

/**
 * Reject a `timeoutMs` that a timer cannot honour, before anything is built.
 *
 * Every value refused here is one that `setTimeout` would accept and then fire
 * on immediately: `0` and negatives are due at once, `NaN` and non-numbers
 * coerce to `0`, and anything past {@link MAX_TIMEOUT_MS} overflows the timer's
 * 32-bit delay. All of them make every request fail at once — writes rejecting and
 * reads resolving empty — which reads as a cache that is simply always cold
 * rather than as a mistyped option. A `RangeError` at construction says so
 * instead, since this can only ever be a programming error.
 *
 * `Infinity` is deliberately allowed: it is the one out-of-range value with an
 * obvious meaning, and it is honoured as "no timeout" rather than passed to a
 * timer that would overflow it.
 */
function validateTimeoutMs(timeoutMs: number): void {
  if (timeoutMs === Number.POSITIVE_INFINITY) return;
  // `Number.isFinite` rather than a `typeof` check: it rejects `NaN` and, for
  // callers without types, anything that isn't a number at all.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `[${PACKAGE_NAME}] timeoutMs must be a number greater than 0 and at most ` +
        `${MAX_TIMEOUT_MS} (about 24.8 days), or Infinity to wait indefinitely; ` +
        `received ${String(timeoutMs)}.`,
    );
  }
}

/** The rejection every request made after `dispose()` gets. */
function disposedError(): SharedWorkerStorageError {
  return new SharedWorkerStorageError("disposed", "SharedWorker storage disposed");
}

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
  // A worker older than the field sends none, which is the one absence this
  // envelope allows; anything other than a number in its place is not a version
  // and so not one of our responses.
  if (message.version !== undefined && typeof message.version !== "number") return false;
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
  // There is no port and nothing in flight, so disposal has nothing to do; it
  // exists so callers can keep one code path, `using` included.
  const dispose = () => {};
  return {
    mode: "noop",
    getItem: () => Promise.resolve(null),
    entries: () => Promise.resolve([]),
    setItem: () => Promise.resolve(),
    removeItem: () => Promise.resolve(),
    dispose,
    [Symbol.dispose]: dispose,
  };
}

/** A live `SharedWorker` connection: its port, and a way to let go of it. */
interface SharedWorkerConnection {
  port: PortAdapter;
  /**
   * Take this package's handler back off the `SharedWorker` object, so a worker
   * that fails later has nothing to call and holds nothing of the storage.
   */
  detach: () => void;
}

/**
 * Instantiate the shared `cache.worker.ts` and return its port together with a
 * `detach` that takes this package's handler back off the worker, or
 * `undefined` if the constructor rejected the call — an opaque origin, a `blob:`/`data:`/
 * `file:` document, or a policy that disables workers all expose `SharedWorker`
 * and then throw on construction. That is reported like an unsupported
 * environment, under the same `unsupported` code, and the caller degrades to
 * no-op storage.
 * Callers must still have confirmed support (see
 * {@link isSharedWorkerSupported}); reaching here without `SharedWorker` at all
 * would throw a raw `ReferenceError`.
 *
 * `onFatal` is invoked if the worker itself fails *after* construction (most
 * commonly because its asset URL didn't resolve in the consumer's bundle, which
 * `workerUrl` overrides) so the
 * storage can fail pending requests fast instead of waiting for each to time
 * out. That failure is unrecoverable — there is no worker to reconnect to — so
 * callers are expected to treat it as terminal, and `detach` is how they stop
 * hearing about it once they have.
 */
function connectSharedWorker(
  options: CreateSharedWorkerStorageOptions,
  onFatal?: (error: SharedWorkerStorageError) => void,
): SharedWorkerConnection | undefined {
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
    report(
      options,
      "warn",
      new SharedWorkerStorageError(
        "unsupported",
        "SharedWorker could not be created in this environment " +
          `(${cause instanceof Error ? cause.message : String(cause)}); falling back ` +
          "to no-op storage. The query cache will not be persisted or shared across " +
          "tabs.",
        { cause },
      ),
    );
    return undefined;
  }
  worker.onerror = (event) => {
    onFatal?.(
      new SharedWorkerStorageError(
        "transport",
        `SharedWorker failed: ${event.message || "worker could not be started"}`,
      ),
    );
  };
  return {
    port: worker.port,
    detach: () => {
      worker.onerror = null;
    },
  };
}
