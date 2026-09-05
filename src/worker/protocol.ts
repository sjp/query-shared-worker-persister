/**
 * Message contract shared by the SharedWorker (`cache.worker.ts`) and the
 * client-side storage (`shared-worker-storage.ts`).
 *
 * Every request carries a unique `id`; the worker echoes that same `id` back on
 * the matching response so the client can correlate concurrent in-flight calls
 * to the right pending promise.
 *
 * These types describe intent, not what arrives: a `SharedWorker` is addressable
 * by `(scriptURL, name)` from any same-origin script, so either side may be
 * handed a message from a sender that doesn't speak this protocol at all. Both
 * sides therefore check the `kind` discriminator and the fields they read before
 * acting on a message, and neither treats the static type as a guarantee. An
 * incompatible change to the shapes below should add an explicit version field
 * rather than reuse a field name for new meaning, since two builds of an app can
 * share one worker.
 */

/** Every key/value pair in the store, as returned by an `entries` request. */
export type StorageEntries = Array<[key: string, value: string]>;

/**
 * What a successful response carries. Which of the two shapes it is follows from
 * the request's `op` — reads and writes answer with `string | null`, `entries`
 * with the whole store — so the client checks the result against the operation
 * it asked for rather than guessing from the value alone.
 */
export type StorageResult = string | null | StorageEntries;

/** Client -> worker: a single storage operation. */
export type StorageRequest =
  | { kind: "request"; id: number; op: "getItem"; key: string }
  | { kind: "request"; id: number; op: "setItem"; key: string; value: string }
  | { kind: "request"; id: number; op: "removeItem"; key: string }
  | { kind: "request"; id: number; op: "entries" };

/** Worker -> client: the result of a single request, keyed by `id`. */
export type StorageResponse =
  | { kind: "response"; id: number; ok: true; result: StorageResult }
  | { kind: "response"; id: number; ok: false; error: string };
