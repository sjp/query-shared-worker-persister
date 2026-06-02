/// <reference lib="webworker" />

import type { StorageRequest, StorageResponse } from "./worker/protocol";
import { CacheStore } from "./worker/store";

/**
 * The SharedWorker process. A single instance is shared by every same-origin
 * tab; the browser keeps it alive only while at least one tab is connected and
 * terminates it (dropping `store` with it) when the last tab closes. That is
 * what ties the cache's lifetime to the number of open tabs.
 *
 * Its sole job is to hold the one shared {@link CacheStore} and answer storage
 * requests on each connected port, echoing the request `id` so the client can
 * match responses to calls.
 */

// `self` in a SharedWorker is a SharedWorkerGlobalScope. We cast rather than
// redeclare to avoid clashing with the ambient `self` from the DOM lib.
const ctx = self as unknown as SharedWorkerGlobalScope;

const store = new CacheStore();

ctx.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return; // a connect event always carries its port; guard for the types

  port.onmessage = (e: MessageEvent<StorageRequest>) => {
    const request = e.data;
    let response: StorageResponse;
    try {
      response = { kind: "response", id: request.id, ok: true, result: store.handle(request) };
    } catch (err) {
      response = {
        kind: "response",
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    port.postMessage(response);
  };

  port.start();
};
