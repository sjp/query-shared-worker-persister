import type { PortAdapter } from "./shared-worker-storage";
import type { StorageRequest, StorageResponse } from "./worker/protocol";
import { CacheStore } from "./worker/store";

/**
 * Helpers shared by the test suites in this directory. Not one of the packaged
 * entries, so nothing here ships in `dist`.
 */

/**
 * A fake `MessagePort` that stands in for the SharedWorker connection: it pipes
 * client requests through a real {@link CacheStore} and replies asynchronously,
 * echoing the request `id` — exactly like `cache.worker.ts` does. This lets us
 * test the client-side request/response correlation without a real worker.
 */
export function createFakePort(store = new CacheStore()): PortAdapter {
  const port: PortAdapter = {
    onmessage: null,
    postMessage(request: StorageRequest) {
      // Reply on a microtask to mimic the async hop to the worker and back.
      queueMicrotask(() => {
        let response: StorageResponse;
        try {
          response = { kind: "response", id: request.id, ok: true, result: store.handle(request) };
        } catch (err) {
          response = { kind: "response", id: request.id, ok: false, error: String(err) };
        }
        port.onmessage?.({ data: response } as MessageEvent<StorageResponse>);
      });
    },
  };
  return port;
}

/** Run `fn` with `globalThis.SharedWorker` forced present/absent, then restore. */
export async function withSharedWorker(value: unknown, fn: () => void | Promise<void>) {
  const g = globalThis as { SharedWorker?: unknown };
  const had = "SharedWorker" in g;
  const original = g.SharedWorker;
  if (value === undefined) delete g.SharedWorker;
  else g.SharedWorker = value;
  try {
    await fn();
  } finally {
    if (had) g.SharedWorker = original;
    else delete g.SharedWorker;
  }
}
