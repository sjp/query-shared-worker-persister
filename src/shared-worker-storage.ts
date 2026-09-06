import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import { createRequestChannel, type PortAdapter, type RequestChannel } from "./request-channel";
import { SharedWorkerStorageError } from "./storage-error";
import type { StorageEntries, StorageRequest, StorageResult } from "./worker/protocol";

// The transport and the error type are defined next to the code that produces
// them, and re-exported here because this module is where a caller meets them:
// the `port` option takes a `PortAdapter`, and every rejection and report is a
// `SharedWorkerStorageError`.
export type { PortAdapter } from "./request-channel";
export { SharedWorkerStorageError, type SharedWorkerStorageErrorCode } from "./storage-error";

// a console output prefix so a line is traceable to this package
const PACKAGE_NAME = "@sjpnz/query-shared-worker-persister";

/**
 * Base SharedWorker name; a `namespace` is appended to it. The name and the
 * worker's script URL together identify the worker, so tabs share a store only
 * when both match.
 */
const WORKER_NAME = "TANSTACK_QUERY_SHARED_CACHE_WORKER";

// the longest delay `setTimeout` can hold
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface SharedWorkerStorage extends AsyncStorage {
  /**
   * Every key/value pair in the shared store, including any written by other
   * apps sharing the same worker — or, with
   * {@link CreateSharedWorkerStorageOptions.entriesPrefix} set, only the pairs
   * whose key starts with it. Always present here (TanStack declares it
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
   * the life of the storage: a worker that fails or goes away *after*
   * construction leaves this `"shared-worker"`, and is reported through
   * {@link CreateSharedWorkerStorageOptions.onError} instead. A storage built
   * from an already-aborted signal opens no transport either, and names the one
   * it would have used.
   */
  readonly mode: "shared-worker" | "noop";
  /**
   * Detach this storage's handlers and settle any in-flight requests.
   * Idempotent: a second call does nothing. Once disposed the storage stays
   * disposed: later writes reject straight away, later reads resolve empty —
   * the first of them reported, the rest silently — and a worker that fails
   * afterwards is neither recorded nor reported.
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
   * Must not be `""`. The empty string is the default worker's name, so a
   * storage given one would join the very store the option was passed to stay
   * out of; it throws a `TypeError` when the storage is created instead. Omit
   * the option, or pass `undefined`, to join the default worker on purpose.
   *
   * It is not an access boundary: any same-origin script can open that worker
   * under the same name and read every entry in it, just as it could read
   * `localStorage`. Don't store values here you wouldn't put in `localStorage`.
   */
  namespace?: string | undefined;
  /**
   * Return only the entries whose key starts with this string from `entries()`,
   * instead of everything in the shared store.
   *
   * Worth setting wherever `entries()` is actually used, which in practice
   * means TanStack's per-query persister: it reads the whole store on
   * `restoreQueries`, on every garbage-collection pass and on `removeQueries`,
   * then keeps only the keys under its own `prefix`. One worker's store holds
   * every tab's entries, and every entry of any other app sharing that worker,
   * so without this each of those reads copies all of it across the port to
   * discard most of it. Pass the persister's `prefix` followed by the `-` it
   * joins keys with, and only the matching pairs make the trip.
   *
   * This narrows what is transferred, not what is reachable: `getItem` and
   * `setItem` still address the whole store, and any same-origin script can
   * read every entry in the worker regardless.
   */
  entriesPrefix?: string | undefined;
  /**
   * Load the worker from this URL instead of the `dist/cache.worker.js` that
   * ships beside the bundle. The default reference is written as
   * `new URL("./cache.worker.js", import.meta.url)`, which every modern bundler
   * has to recognise inside a dependency in order to copy the asset into the
   * output; point this at a copy you host yourself when your build doesn't. The
   * URL must be on the page's own origin: a cross-origin worker script can't be
   * loaded, and a store is shared per origin in any case, so one that resolves
   * elsewhere is refused with a `TypeError` here rather than left to surface as
   * a browser that wouldn't build the worker.
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
   * `StorageResponse` works. Application code doesn't need it.
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
   * because resolving empty hides it — except for reads that failed only
   * because the storage was disposed, where the first is reported and the rest
   * are not: the caller asked for the disposal, and a persister reading on
   * every query mount would otherwise repeat the same line indefinitely.
   */
  onError?: ((error: SharedWorkerStorageError) => void) | undefined;
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
 * Three options throw rather than being reported, because each can only be a
 * programming error and none of them shows up as a failure at run time: an
 * out-of-range `timeoutMs`, a deadline no timer can honour that would leave the
 * cache permanently cold (see
 * {@link CreateSharedWorkerStorageOptions.timeoutMs} for the accepted range); a
 * `workerUrl` pointing at another origin, a script no browser will load; and an
 * empty `namespace`, which asks for a worker of this app's own and would
 * quietly get the shared one.
 */
export function createSharedWorkerStorage(
  options: CreateSharedWorkerStorageOptions = {},
): SharedWorkerStorage {
  const { timeoutMs = 10_000 } = options;
  // Before the support check, so a bad option is a hard error everywhere rather
  // than one that only surfaces in environments that have a SharedWorker. A
  // `workerUrl` is exempt where a port was injected, which replaces worker
  // construction entirely: that URL is never loaded, so it never has to be
  // loadable. A `namespace` is checked either way: whether it names a
  // worker of its own is a property of the string, not of the environment or of
  // what the storage ends up talking to.
  validateTimeoutMs(timeoutMs);
  if (options.namespace !== undefined) validateNamespace(options.namespace);
  if (!options.port && options.workerUrl !== undefined) validateWorkerUrl(options.workerUrl);

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

  // Constructing the worker can fail outright rather than failing later through
  // `onerror`; there is no transport to build a storage on in that case, so
  // degrade to the same no-op storage an unsupported environment gets.
  return createConnectedStorage(options, timeoutMs, abortedUpFront) ?? createNoopStorage();
}

/**
 * The storage for an environment that can carry the protocol. It opens the
 * transport — a `SharedWorker` of its own, or the caller's injected port — and
 * owns everything whose meaning depends on this storage's state rather than on
 * one request: which failures are terminal, which are reported and how often,
 * what a read does with one, and what disposal settles. Correlating requests to
 * responses is the channel's job, and the fast-fail checks below sit in front of
 * it precisely because the channel has no idea this storage was disposed.
 *
 * `undefined` when the `SharedWorker` constructor refused the call outright, so
 * there is nothing to build a storage on and the caller falls back to the no-op
 * one. A storage from an already-aborted signal is not that case: it opens no
 * transport either, but it is a storage, and it comes back in the state a
 * `dispose()` straight after construction would leave it in.
 */
function createConnectedStorage(
  options: CreateSharedWorkerStorageOptions,
  timeoutMs: number,
  abortedUpFront: boolean,
): SharedWorkerStorage | undefined {
  // An already-aborted signal starts the storage in the state `dispose()` would
  // leave it in, which is also what keeps a transport from being opened below.
  let disposed = abortedUpFront;
  // Set once the transport is beyond recovery; every later request rejects with it.
  let fatalError: SharedWorkerStorageError | undefined;
  // Set the first time a read is answered by disposal, so the rest stay quiet.
  let disposedReadReported = false;
  // Assigned below once there is a port to talk over; stays `undefined` for a
  // storage that was disposed before it opened one. Declared ahead of the
  // handlers the channel is given, which reach back for it when the transport
  // fails.
  let channel: RequestChannel | undefined;
  // Set below when a `signal` is supplied; detaches the abort listener so a
  // manual `dispose()` doesn't leave this storage — its pending requests and
  // its closed port — reachable from a signal that may never abort.
  let detachAbortListener: (() => void) | undefined;

  /**
   * Let go of the transport: this package's handler off the `SharedWorker`
   * object, the channel's off the port, and the port closed. Safe to call more
   * than once, and it settles nothing on its own.
   */
  function releaseTransport() {
    connection?.detach();
    channel?.close();
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
    if (disposed) return;
    fatalError = error;
    releaseTransport();
    channel?.rejectAll(error);
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

  // No connection where one was wanted means the constructor refused; there is
  // no storage to hand back. The other way to be here without one is the
  // aborted signal above, which keeps its storage.
  if (!connection && !abortedUpFront) return undefined;

  if (connection) channel = openChannel(connection.port, timeoutMs, options, handleWorkerFailure);

  /** Post one request, unless this storage already knows how it has to end. */
  function request(build: (id: number) => StorageRequest): Promise<StorageResult> {
    // Once the port is closed the browser drops `postMessage` silently, so a
    // request issued here would sit pending and only fail at the timeout — a
    // misleading error, ten seconds late, holding a timer the whole way. Fail
    // fast instead. Writes reject rather than resolve, so one that never reached
    // the worker is surfaced to `createAsyncStoragePersister`'s `retry` hook;
    // `read` converts the same rejection into an empty result for reads.
    // A missing channel says the same thing as `disposed`, since the only
    // storage built without one is the storage that was disposed before it
    // opened a transport; checking it here is also what leaves something to
    // post through below.
    if (disposed || !channel) return Promise.reject(disposedError());
    // Likewise once the worker has failed: there is no port left to answer, so
    // hand back the transport error that explains why rather than a timeout that
    // doesn't.
    if (fatalError) return Promise.reject(fatalError);
    return channel.request(build);
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
      const disposedRead = error instanceof SharedWorkerStorageError && error.code === "disposed";
      // A fatal transport failure is already reported where it happens, once.
      // Disposal is reported once too: the first read says the one thing worth
      // hearing — something is still reading a storage the caller released —
      // and a persister reading on every query mount would otherwise repeat it
      // for as long as the reference is held. Everything else — a timeout, a
      // worker-side error, a reply that broke the protocol — is reported on
      // every read, so a cache that silently stays cold still says why.
      const alreadyReported = error === fatalError || (disposedRead && disposedReadReported);
      if (disposedRead) disposedReadReported = true;
      if (!alreadyReported) report(options, "warn", emptyReadReport(error));
      return empty;
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    detachAbortListener?.();
    detachAbortListener = undefined;
    channel?.rejectAll(disposedError());
    releaseTransport();
  }

  const storage = createStorageMethods(options, { read, request, dispose });

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
 * Open a request channel over `port` and give it this package's reading of the
 * two events on it that name no request and so cannot be settled as one.
 *
 * An undeserializable message is the lesser fault: the port is still good, so it
 * is reported and nothing else — the one request whose answer was lost settles
 * on its own timeout while the rest go on to settle on their own responses. A
 * port that closes is the greater one, and as terminal as a worker that never
 * started: there is no worker left to reconnect to, and a caller who wants
 * another builds a new storage.
 */
function openChannel(
  port: PortAdapter,
  timeoutMs: number,
  options: CreateSharedWorkerStorageOptions,
  onFatal: (error: SharedWorkerStorageError) => void,
): RequestChannel {
  return createRequestChannel(port, timeoutMs, {
    onUndeliverableMessage: () => {
      report(
        options,
        "error",
        new SharedWorkerStorageError(
          "transport",
          "SharedWorker sent a message that could not be deserialized",
        ),
      );
    },
    onDisconnect: () => {
      onFatal(new SharedWorkerStorageError("transport", "SharedWorker connection was closed"));
    },
  });
}

/** The transport, already wrapped in the storage's policy, that the methods below run on. */
interface StorageOperations {
  /** Run a read: any failure resolves as the `empty` value rather than rejecting. */
  read: (build: (id: number) => StorageRequest, empty: StorageResult) => Promise<StorageResult>;
  /** Run a write: a failure rejects, so the persister's `retry` hook hears about it. */
  request: (build: (id: number) => StorageRequest) => Promise<StorageResult>;
  dispose: () => void;
}

/**
 * The `AsyncStorage` surface itself: each operation as the request that carries
 * it, and disposal under both of its names.
 *
 * Each method narrows the shared result type to the shape its operation is
 * defined to return. The cast is sound because `request` only resolves a result
 * that matched the operation it was sent for, and a read that failed falls back
 * to the empty value of that same shape.
 */
function createStorageMethods(
  options: CreateSharedWorkerStorageOptions,
  { read, request, dispose }: StorageOperations,
): SharedWorkerStorage {
  return {
    mode: "shared-worker",
    getItem: (key) =>
      read((id) => ({ kind: "request", id, op: "getItem", key }), null) as Promise<string | null>,
    entries: async () => {
      const { entriesPrefix } = options;
      const pairs = (await read(
        (id) => ({ kind: "request", id, op: "entries", prefix: entriesPrefix }),
        [],
      )) as StorageEntries;
      // Filtered again here because the worker may be an older build than this
      // tab — it runs whichever script the first tab to connect loaded — and one
      // that predates `prefix` answers with the whole store. Repeating the test
      // costs a pass over a list this tab was going to walk anyway, and makes
      // the result the same either way.
      return entriesPrefix === undefined
        ? pairs
        : pairs.filter(([key]) => key.startsWith(entriesPrefix));
    },
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
}

/**
 * The report for a read that resolved empty instead of rejecting. It is raised
 * under the code of the failure behind it, which is also kept as the `cause`: a
 * caller filtering on `timeout` wants this read too.
 */
function emptyReadReport(error: unknown): SharedWorkerStorageError {
  const reason = error instanceof Error ? error.message : String(error);
  return new SharedWorkerStorageError(
    error instanceof SharedWorkerStorageError ? error.code : "transport",
    `Could not read from the SharedWorker cache (${reason}); ` +
      "continuing as though it were empty.",
    { cause: error },
  );
}

/**
 * Send a diagnostic to the caller's `onError`, or to the console when there is
 * none. `level` picks the console method only; a caller taking these over gets
 * one channel and sorts by the error's `code`.
 *
 * A console report is the prefixed message followed by the error itself, so a
 * text filter still matches the line while devtools can expand the `code`, the
 * `cause` and the stack behind it.
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
    console[level](`[${PACKAGE_NAME}] ${error.message}`, error);
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

/**
 * Reject a `namespace` that names no worker of its own.
 *
 * The option's only job is to change the worker's name, and `""` is the one
 * value that cannot: it leaves the name the default worker's, so the storage
 * connects to exactly the worker the caller was separating themselves from and
 * reads and writes the store they asked to stay out of. Nothing about that
 * looks like a failure — the cache works, holding another app's entries — so
 * the empty string is refused where it is passed rather than found later
 * through a key that collided.
 */
function validateNamespace(namespace: string): void {
  if (namespace !== "") return;
  throw new TypeError(
    `[${PACKAGE_NAME}] namespace must not be empty: an empty name is the default ` +
      "worker's, so this storage would share the store the option asks to stay out of. " +
      "Pass a name, or omit the option to join the default worker deliberately.",
  );
}

/**
 * Reject a `workerUrl` this page could never load a worker from, before
 * anything is built.
 *
 * `new SharedWorker(url)` answers a cross-origin script with a `SecurityError`,
 * which arrives here indistinguishable from a browser that refuses workers at
 * all and so reads as an environment to degrade in rather than an option to
 * fix. It is the option: a worker script has to be same-origin, and a store is
 * shared per origin in any case, so a copy on an asset domain would share
 * nothing even if it loaded. Naming both origins says that outright.
 *
 * Two cases are deliberately left to the constructor. Without a `location`
 * there is no origin to compare against and no worker being built anyway — a
 * server rendering the page — and a value that is not a URL at all can't be
 * placed on an origin, so it is reported with the browser's own reason for
 * refusing it. So is anything on an opaque origin (a sandboxed iframe, a
 * `blob:`, `data:` or `file:` page), where no URL would have worked and the
 * no-op fallback is the better answer than a throw.
 */
function validateWorkerUrl(workerUrl: string | URL): void {
  if (typeof location === "undefined") return;
  const page = new URL(location.href);
  if (page.origin === "null") return;
  let resolved: URL;
  try {
    resolved = new URL(workerUrl, page);
  } catch {
    // Not a URL, so not one that can be placed on an origin.
    return;
  }
  if (resolved.origin === page.origin) return;
  throw new TypeError(
    `[${PACKAGE_NAME}] workerUrl must be on the page's own origin: the page is ` +
      `${page.origin} and ${String(workerUrl)} resolves to ${resolved.origin}. ` +
      "A cross-origin worker script cannot be loaded, and a store is shared per " +
      "origin in any case; serve a copy of cache.worker.js from this origin instead.",
  );
}

/** The rejection every request made after `dispose()` gets. */
function disposedError(): SharedWorkerStorageError {
  return new SharedWorkerStorageError("disposed", "SharedWorker storage disposed");
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
 * and then throw on construction, as does a `workerUrl` that is not a URL the
 * page can load. That is reported under the `unsupported` code and the caller
 * degrades to no-op storage; the report is phrased around `workerUrl` when
 * there is one, since a URL the caller chose is the likelier culprit than the
 * environment and is the thing they can act on.
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
  const { namespace, workerUrl } = options;
  let worker: SharedWorker;
  try {
    worker = new SharedWorker(workerUrl ?? new URL("./cache.worker.js", import.meta.url), {
      type: "module",
      name: namespace ? `${WORKER_NAME}:${namespace}` : WORKER_NAME,
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const refusal =
      workerUrl === undefined
        ? `SharedWorker could not be created in this environment (${reason})`
        : `SharedWorker could not be created from workerUrl ${String(workerUrl)} ` +
          `(${reason}); check that it names a script this page can load`;
    report(
      options,
      "warn",
      new SharedWorkerStorageError(
        "unsupported",
        `${refusal}; falling back to no-op storage. The query cache will not be ` +
          "persisted or shared across tabs.",
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
