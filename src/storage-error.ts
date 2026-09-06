/**
 * The one error type this package raises and reports. It lives on its own so
 * that both halves of the client — the request channel that produces most of
 * these, and the storage policy that decides what to do about them — can throw
 * the same class without either having to import the other.
 */

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
 * - `transport` — the worker failed after it was constructed, its connection was
 *   closed because the worker went away, or it sent a message that could not be
 *   deserialized. The first two are terminal.
 * - `timeout` — the worker did not answer within `timeoutMs`.
 * - `protocol` — the worker answered, but with an error, with a result that
 *   doesn't fit the operation it was sent, or in a protocol version this build
 *   doesn't speak.
 * - `disposed` — the request was made after `dispose()`.
 *
 * These reach a caller two ways: as the rejection of a write, and through the
 * storage's `onError` option. Where one failure was caused by another — the
 * `DOMException` from a refused constructor, or the request failure behind a
 * read that resolved empty — that other error is the `cause`.
 */
export class SharedWorkerStorageError extends Error {
  readonly code: SharedWorkerStorageErrorCode;

  constructor(code: SharedWorkerStorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SharedWorkerStorageError";
    this.code = code;
  }
}
