import { SharedWorkerStorageError } from "./storage-error";
import {
  PROTOCOL_VERSION,
  UNVERSIONED_PROTOCOL_VERSION,
  type StorageEntries,
  type StorageRequest,
  type StorageResponse,
  type StorageResult,
} from "./worker/protocol";

/**
 * Request/response correlation over one port: allocating ids, holding the
 * requests in flight, bounding each with a timer, matching every response to
 * the request that asked for it, and checking that the answer is one this build
 * can read at all.
 *
 * Everything here follows from a port and a deadline, which is also all it
 * takes to drive it in a test. It knows nothing of why a channel might be shut
 * down or what a caller wants done about a failure — there is no disposal, no
 * fallback storage and no reporting in this file. Those are the storage's, and
 * they reach the channel only as the two handlers below and as the error passed
 * to {@link RequestChannel.rejectAll}.
 */

/**
 * The minimal `MessagePort` surface this package uses. A real `SharedWorker`
 * port satisfies it, and so does anything else that can carry a
 * {@link StorageRequest} out and a {@link StorageResponse} back — an in-process
 * fake in a test, or another transport entirely. Pass one as the `port` option
 * of `createSharedWorkerStorage`.
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
  /**
   * Fired when the port at the other end is disconnected — the worker behind it
   * terminated, crashed, or closed itself. A real `MessagePort` fires a `close`
   * event at this handler in browsers that implement it; older ones simply never
   * call it, and a fake is free to leave it out.
   */
  onclose?: ((event: Event) => void) | null;
  start?: () => void;
  /** Close the underlying port; called on disposal. Real `MessagePort` has this. */
  close?: () => void;
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
 * The two things that happen on a port which a channel cannot interpret on its
 * own, because neither names a request and neither is the channel's to act on.
 */
export interface RequestChannelHandlers {
  /**
   * One response the structured clone algorithm couldn't reconstruct. The event
   * says nothing about which request it belonged to, and the port is still
   * good, so the channel does nothing else about it: the one request whose
   * answer was lost settles by its own timeout, and every other request in
   * flight goes on to settle on its own response. Rejecting the whole pending
   * map here would instead fail concurrent writes for a fault that was not
   * theirs and resolve concurrent reads empty, and each of those reads would
   * report the same bad message a second time.
   */
  onUndeliverableMessage: () => void;
  /**
   * The other end of the port went away after it started: the worker was
   * terminated by the browser under memory pressure or after a crash, killed
   * from devtools, or closed itself. `postMessage` on a port whose other end is
   * gone is dropped in silence, so without this signal every later request
   * would wait out its full timeout for an answer that can never come, for the
   * life of the tab. What that means is the caller's to decide — there is no
   * worker left to reconnect to, so a caller treating it as terminal rejects
   * what is in flight and closes the channel.
   */
  onDisconnect: () => void;
}

export interface RequestChannel {
  /**
   * Post one request and resolve with its response. The caller supplies a
   * builder rather than a finished message because the `id` is allocated here:
   * handing the builder the id lets it construct a whole {@link StorageRequest}
   * in one go, so the message is type checked against the operation it names
   * instead of being assembled from a partial and cast back.
   *
   * There is no fast path for a channel that has been closed: a request made
   * after {@link RequestChannel.close} is posted into a port nothing is
   * listening to and settles at its deadline. Callers that know the transport
   * is gone are expected to say so before reaching here.
   */
  request: (build: (id: number) => StorageRequest) => Promise<StorageResult>;
  /**
   * Settle every request in flight with `error` and clear their timers. The
   * channel stays usable; a caller tearing the transport down calls
   * {@link RequestChannel.close} as well.
   */
  rejectAll: (error: SharedWorkerStorageError) => void;
  /**
   * Take every handler this channel installed back off the port and close it.
   * Idempotent, and it settles nothing: requests still pending are left as they
   * are, so a caller that wants them failed calls
   * {@link RequestChannel.rejectAll} too.
   *
   * Detaching matters as much as closing: a handler left on the port keeps the
   * channel — its pending map and everything the handler closes over —
   * reachable from an event that may never fire.
   */
  close: () => void;
}

/**
 * Wire a channel onto `port` and start it. Every request posted through the
 * result is stamped with {@link PROTOCOL_VERSION} and rejected after
 * `timeoutMs` unless the port answers it first; `Infinity` asks for no deadline
 * at all.
 */
export function createRequestChannel(
  port: PortAdapter,
  timeoutMs: number,
  handlers: RequestChannelHandlers,
): RequestChannel {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;

  port.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (!isStorageResponse(message)) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
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
  port.onmessageerror = () => handlers.onUndeliverableMessage();
  port.onclose = () => handlers.onDisconnect();
  port.start?.();

  function request(build: (id: number) => StorageRequest): Promise<StorageResult> {
    const id = nextId++;
    const message = build(id);
    return new Promise<StorageResult>((resolve, reject) => {
      // `Infinity` asks for no deadline at all, so no timer is created.
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
      // A port can refuse the message itself, e.g. when
      // a value cannot be structured-cloned. The throw would otherwise escape
      // the executor and reject this promise while leaving the timer scheduled
      // and the entry in `pending`, so a request that never left the tab would
      // still be settled a second time at its deadline. Unwind it here instead,
      // and reject with the same error shape the rest of the transport uses so
      // a caller branching on `code` — or a read turning the failure into an
      // empty result — sees no special case.
      try {
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

  function rejectAll(error: SharedWorkerStorageError) {
    for (const entry of pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function close() {
    if (closed) return;
    closed = true;
    port.onmessage = null;
    port.onmessageerror = null;
    port.onclose = null;
    port.close?.();
  }

  return { request, rejectAll, close };
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
