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
 * acting on a message, and neither treats the static type as a guarantee.
 *
 * The two halves are also not deployed together. A `SharedWorker` runs the
 * script fetched by the first tab that connected to it and lives until the last
 * one closes, so a tab on a new build can meet a worker started by an old one.
 * That is what {@link PROTOCOL_VERSION} is for: an incompatible change to the
 * shapes below bumps it rather than reusing a field name for new meaning, so the
 * mismatch is reported as such instead of surfacing as a missing operation or a
 * field that is quietly absent.
 */

/**
 * The version of the wire format below that this build speaks. Every message it
 * sends carries it in {@link Versioned.version}.
 *
 * The worker half declares its own copy rather than importing this one, so that
 * its bundle stays the single self-contained file consumers copy out of the
 * package; that copy is annotated with this constant's type, so a bump here
 * that isn't matched there fails to compile.
 *
 * Bump it only for a change that would make one version misread the other -
 * a field whose meaning changed, one that is now required, or a response shape
 * an older client would accept and misinterpret. Adding an operation does not
 * qualify: an older worker already answers one it doesn't know with an error,
 * and an older client never sends it. Nor does an optional field a peer that
 * doesn't know it can ignore and still answer correctly, as `entries`' `prefix`
 * does — the client narrows the reply by the same prefix either way.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The version to read a message carrying no {@link Versioned.version} as: it was
 * sent by a build made before the field existed, which is version 1 by
 * definition. Kept a constant of its own because it is fixed for good — later
 * versions do carry the field — where {@link PROTOCOL_VERSION} moves.
 */
export const UNVERSIONED_PROTOCOL_VERSION = 1;

/**
 * Carried by every message this build sends, in either direction. Optional
 * because the peer may be older than the field — read one that lacks it as
 * {@link UNVERSIONED_PROTOCOL_VERSION} — not because a sender may leave it off.
 */
interface Versioned {
  version?: number | undefined;
}

/** The key/value pairs an `entries` request answered with. */
export type StorageEntries = Array<[key: string, value: string]>;

/**
 * What a successful response carries. Which of the two shapes it is follows from
 * the request's `op` — reads and writes answer with `string | null`, `entries`
 * with a list of pairs — so the client checks the result against the operation
 * it asked for rather than guessing from the value alone.
 */
export type StorageResult = string | null | StorageEntries;

/** Client -> worker: a single storage operation. */
export type StorageRequest = Versioned &
  (
    | { kind: "request"; id: number; op: "getItem"; key: string }
    | { kind: "request"; id: number; op: "setItem"; key: string; value: string }
    | { kind: "request"; id: number; op: "removeItem"; key: string }
    | { kind: "request"; id: number; op: "entries"; prefix?: string | undefined }
  );

/** Worker -> client: the result of a single request, keyed by `id`. */
export type StorageResponse = Versioned &
  (
    | { kind: "response"; id: number; ok: true; result: StorageResult }
    | { kind: "response"; id: number; ok: false; error: string }
  );
