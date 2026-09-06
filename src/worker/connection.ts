import { describeValue } from "./describe-value";
import type { StorageRequest, StorageResponse } from "./protocol";
import type { CacheStore } from "./store";

/**
 * The minimal worker-side port surface: it sends {@link StorageResponse}s (the
 * mirror of the client's `PortAdapter`). What arrives on `onmessage` is typed as
 * `unknown` on purpose - a `SharedWorker` is addressable by `(scriptURL, name)`
 * from any same-origin script, so nothing guarantees the sender speaks this
 * protocol. Modelled as an interface so the connection logic can be tested with
 * a fake port instead of a real `MessagePort`.
 */
export interface WorkerPort {
  postMessage: (message: StorageResponse) => void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  /** Fired when an incoming message can't be deserialized. Real `MessagePort` has this. */
  onmessageerror?: ((event: MessageEvent) => void) | null;
  start?: () => void;
}

/**
 * Prefixes this file's console output so a log line is traceable to this
 * package. Spelled out again here rather than imported from the client half: a
 * module both entries import is emitted as a chunk the two of them load, and
 * the worker entry has to stay one file, because that file is all a consumer's
 * bundler copies out of the package.
 */
const PACKAGE_NAME = "@sjpnz/query-shared-worker-persister";

/**
 * The wire version this build stamps its responses with, spelled out here for
 * the same reason as {@link PACKAGE_NAME}: the client half reads the one in
 * `./protocol` and the package re-exports it, so importing that value here would
 * make the module a chunk both entries load. The annotation is the link between
 * the two copies - it is the type of the constant over there, which is the
 * literal number, so a bump that isn't matched here fails to compile.
 */
const PROTOCOL_VERSION: typeof import("./protocol").PROTOCOL_VERSION = 1;

/** The operations a request may name; used to reject anything else up front. */
const OPERATIONS = new Set<StorageRequest["op"]>(["getItem", "setItem", "removeItem", "entries"]);

/** Narrow an arbitrary value to an object so its fields can be probed safely. */
function asRecord(data: unknown): Record<string, unknown> | undefined {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

/**
 * The `id` a reply can be correlated to, or `undefined` when the message hasn't
 * got a usable one. Reading the field is guarded because this is what the
 * failure path uses to answer a message it could not otherwise make sense of:
 * if the read itself threw, that path would have nothing left to fall back on.
 */
function readId(data: unknown): number | undefined {
  try {
    const id = asRecord(data)?.id;
    return typeof id === "number" ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Explain why `data` isn't a request this worker can serve, or return
 * `undefined` when it is one. Every field the store reads is checked, so past
 * this point `data` can be treated as a {@link StorageRequest}: an unchecked
 * field would otherwise reach `CacheStore` as `undefined` and be stored or
 * looked up under a bogus key.
 *
 * A request's `version` is deliberately not one of them. This worker is
 * whichever build the first tab to connect loaded, so it may well be the older
 * of the two, and rejecting a version it doesn't recognise would refuse exactly
 * the clients it should go on serving. Its own version travels back on every
 * response instead, for the client to compare against the one it speaks.
 */
function describeInvalidRequest(data: unknown): string | undefined {
  const message = asRecord(data);
  if (!message) return `expected an object, received ${data === null ? "null" : typeof data}`;
  if (message.kind !== "request") {
    return `expected kind "request", received ${describeValue(message.kind)}`;
  }
  if (typeof message.id !== "number") return `id must be a number, received ${typeof message.id}`;
  if (!OPERATIONS.has(message.op as StorageRequest["op"])) {
    return `unknown operation ${describeValue(message.op)}`;
  }
  // `entries` addresses the store as a whole, so it is the one operation with no
  // key to check; requiring one would reject a well-formed request. Its optional
  // `prefix` narrows which pairs come back, and is absent on every request from
  // a client older than the field.
  if (message.op === "entries") {
    return message.prefix === undefined || typeof message.prefix === "string"
      ? undefined
      : `entries prefix must be a string, received ${typeof message.prefix}`;
  }
  if (typeof message.key !== "string")
    return `key must be a string, received ${typeof message.key}`;
  if (message.op === "setItem" && typeof message.value !== "string") {
    return `setItem value must be a string, received ${typeof message.value}`;
  }
  return undefined;
}

/**
 * Apply a request to the store and wrap the outcome in a response envelope,
 * echoing the request `id` so the client can correlate it. A throw from the
 * store becomes an `ok: false` response rather than crashing the port. Kept here
 * (out of `cache.worker.ts`) so this success/error mapping is unit-tested.
 */
export function respond(
  store: Pick<CacheStore, "handle">,
  request: StorageRequest,
): StorageResponse {
  try {
    return {
      kind: "response",
      version: PROTOCOL_VERSION,
      id: request.id,
      ok: true,
      result: store.handle(request),
    };
  } catch (err) {
    return {
      kind: "response",
      version: PROTOCOL_VERSION,
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Wire a freshly connected port to the shared store: every incoming message is
 * validated and, if it is a well-formed request, answered via {@link respond}.
 * A no-op when the port is absent: a connect event always carries one in
 * practice, but the caller reaches it through `event.ports[0]`, which under
 * `noUncheckedIndexedAccess` is `MessagePort | undefined`, so the absence has to
 * be handled somewhere and here is the one place that has a port to wire.
 *
 * A message that isn't a well-formed request still gets an `ok: false` reply
 * whenever it carries a usable `id`, so the sender fails immediately instead of
 * waiting out its timeout. Without an `id` there is nothing to correlate a reply
 * to, so it is logged and dropped. Handling a message never throws back out to
 * the port: an unexpected failure is logged and answered the same way, so one
 * hostile or unlucky message cannot silence a request that was owed an answer.
 */
export function handleConnect(
  store: Pick<CacheStore, "handle">,
  port: WorkerPort | null | undefined,
): void {
  if (!port) return;
  port.onmessage = (event) => {
    const data = event.data;
    try {
      const reason = describeInvalidRequest(data);
      if (reason === undefined) {
        port.postMessage(respond(store, data as StorageRequest));
        return;
      }
      const id = readId(data);
      if (id !== undefined) {
        port.postMessage({
          kind: "response",
          version: PROTOCOL_VERSION,
          id,
          ok: false,
          error: `Malformed request: ${reason}`,
        });
      } else {
        // Most likely another same-origin script talking to this worker rather
        // than a fault of ours, so warn instead of erroring - but say so, since
        // the alternative is a message vanishing without trace.
        console.warn(`[${PACKAGE_NAME}] Ignoring an unrecognized message: ${reason}`);
      }
    } catch (err) {
      // Nothing above is meant to throw - validation is written not to, and
      // `respond` already turns a failing store into an error response - but an
      // escaping throw would leave a sender that carried a usable `id` waiting
      // out its whole timeout for a reply that is never coming, which is the
      // outcome answering a bad message exists to avoid. So answer it anyway,
      // and log, because reaching here at all is a fault worth seeing.
      const error = err instanceof Error ? err.message : describeValue(err);
      console.error(`[${PACKAGE_NAME}] Failed to handle an incoming message: ${error}`);
      const id = readId(data);
      if (id !== undefined) {
        port.postMessage({
          kind: "response",
          version: PROTOCOL_VERSION,
          id,
          ok: false,
          error: `Failed to handle request: ${error}`,
        });
      }
    }
  };
  port.onmessageerror = () => {
    // The request is gone and its `id` with it, so the client can only find out
    // by timing out. Log so the cause is visible in the worker's console.
    console.error(`[${PACKAGE_NAME}] Received a message that could not be deserialized`);
  };
  port.start?.();
}
