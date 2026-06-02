/**
 * Message contract shared by the SharedWorker (`cache.worker.ts`) and the
 * client-side storage (`shared-worker-storage.ts`).
 *
 * Every request carries a unique `id`; the worker echoes that same `id` back on
 * the matching response so the client can correlate concurrent in-flight calls
 * to the right pending promise.
 */

/** Client -> worker: a single storage operation. */
export type StorageRequest =
  | { kind: "request"; id: number; op: "getItem"; key: string }
  | { kind: "request"; id: number; op: "setItem"; key: string; value: string }
  | { kind: "request"; id: number; op: "removeItem"; key: string };

/** Worker -> client: the result of a single request, keyed by `id`. */
export type StorageResponse =
  | { kind: "response"; id: number; ok: true; result: string | null }
  | { kind: "response"; id: number; ok: false; error: string };
