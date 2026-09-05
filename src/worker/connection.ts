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
 * package. Spelled out again here rather than shared with the client so the
 * worker entry stays a self-contained bundle for consumers to copy.
 */
const PACKAGE_NAME = "@sjpnz/query-shared-worker-persister";

/** The operations a request may name; used to reject anything else up front. */
const OPERATIONS = new Set<StorageRequest["op"]>(["getItem", "setItem", "removeItem", "entries"]);

/** Narrow an arbitrary value to an object so its fields can be probed safely. */
function asRecord(data: unknown): Record<string, unknown> | undefined {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
}

/**
 * Explain why `data` isn't a request this worker can serve, or return
 * `undefined` when it is one. Every field the store reads is checked, so past
 * this point `data` can be treated as a {@link StorageRequest}: an unchecked
 * field would otherwise reach `CacheStore` as `undefined` and be stored or
 * looked up under a bogus key.
 */
function describeInvalidRequest(data: unknown): string | undefined {
  const message = asRecord(data);
  if (!message) return `expected an object, received ${data === null ? "null" : typeof data}`;
  if (message.kind !== "request") {
    return `expected kind "request", received ${JSON.stringify(message.kind)}`;
  }
  if (typeof message.id !== "number") return `id must be a number, received ${typeof message.id}`;
  if (!OPERATIONS.has(message.op as StorageRequest["op"])) {
    return `unknown operation ${JSON.stringify(message.op)}`;
  }
  // `entries` addresses the whole store, so it is the one operation with no key
  // to check; requiring one would reject a well-formed request.
  if (message.op === "entries") return undefined;
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
    return { kind: "response", id: request.id, ok: true, result: store.handle(request) };
  } catch (err) {
    return {
      kind: "response",
      id: request.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Wire a freshly connected port to the shared store: every incoming message is
 * validated and, if it is a well-formed request, answered via {@link respond}.
 * A no-op when the port is absent (a connect event always carries its port; this
 * guards the types).
 *
 * A message that isn't a well-formed request still gets an `ok: false` reply
 * whenever it carries a usable `id`, so the sender fails immediately instead of
 * waiting out its timeout. Without an `id` there is nothing to correlate a reply
 * to, so it is logged and dropped.
 */
export function handleConnect(
  store: Pick<CacheStore, "handle">,
  port: WorkerPort | null | undefined,
): void {
  if (!port) return;
  port.onmessage = (event) => {
    const data = event.data;
    const reason = describeInvalidRequest(data);
    if (reason === undefined) {
      port.postMessage(respond(store, data as StorageRequest));
      return;
    }
    const id = asRecord(data)?.id;
    if (typeof id === "number") {
      port.postMessage({ kind: "response", id, ok: false, error: `Malformed request: ${reason}` });
    } else {
      // Most likely another same-origin script talking to this worker rather
      // than a fault of ours, so warn instead of erroring - but say so, since
      // the alternative is a message vanishing without trace.
      console.warn(`[${PACKAGE_NAME}] Ignoring an unrecognized message: ${reason}`);
    }
  };
  port.onmessageerror = () => {
    // The request is gone and its `id` with it, so the client can only find out
    // by timing out. Log so the cause is visible in the worker's console.
    console.error(`[${PACKAGE_NAME}] Received a message that could not be deserialized`);
  };
  port.start?.();
}
