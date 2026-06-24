import type { StorageRequest, StorageResponse } from "./protocol";
import type { CacheStore } from "./store";

/**
 * The minimal worker-side port surface: it receives {@link StorageRequest}s and
 * sends {@link StorageResponse}s (the mirror of the client's `PortAdapter`).
 * Modelled as an interface so the connection logic can be tested with a fake
 * port instead of a real `MessagePort`.
 */
export interface WorkerPort {
  postMessage: (message: StorageResponse) => void;
  onmessage: ((event: MessageEvent<StorageRequest>) => void) | null;
  start?: () => void;
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
 * Wire a freshly connected port to the shared store: every incoming request is
 * answered via {@link respond}. A no-op when the port is absent (a connect event
 * always carries its port; this guards the types).
 */
export function handleConnect(
  store: Pick<CacheStore, "handle">,
  port: WorkerPort | null | undefined,
): void {
  if (!port) return;
  port.onmessage = (event) => {
    port.postMessage(respond(store, event.data));
  };
  port.start?.();
}
