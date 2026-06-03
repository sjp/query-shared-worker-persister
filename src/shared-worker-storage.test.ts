import { describe, expect, it } from "vite-plus/test";
import { createSharedWorkerStorage, type PortAdapter } from "./shared-worker-storage";
import type { StorageRequest, StorageResponse } from "./worker/protocol";
import { CacheStore } from "./worker/store";

/**
 * A fake `MessagePort` that stands in for the SharedWorker connection: it pipes
 * client requests through a real {@link CacheStore} and replies asynchronously,
 * echoing the request `id` — exactly like `cache.worker.ts` does. This lets us
 * test the client-side request/response correlation without a real worker.
 */
function createFakePort(store = new CacheStore()): PortAdapter {
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

describe("createSharedWorkerStorage", () => {
  it("returns null for a missing key", async () => {
    const storage = createSharedWorkerStorage({ port: createFakePort() });
    await expect(storage.getItem("missing")).resolves.toBeNull();
    storage.dispose();
  });

  it("round-trips setItem -> getItem through the worker protocol", async () => {
    const storage = createSharedWorkerStorage({ port: createFakePort() });
    await storage.setItem("k", "v");
    await expect(storage.getItem("k")).resolves.toBe("v");
    storage.dispose();
  });

  it("removeItem clears a stored value", async () => {
    const storage = createSharedWorkerStorage({ port: createFakePort() });
    await storage.setItem("k", "v");
    await storage.removeItem("k");
    await expect(storage.getItem("k")).resolves.toBeNull();
    storage.dispose();
  });

  it("correlates concurrent requests to the correct responses", async () => {
    const storage = createSharedWorkerStorage({ port: createFakePort() });
    await Promise.all([storage.setItem("a", "1"), storage.setItem("b", "2")]);
    const [a, b] = await Promise.all([storage.getItem("a"), storage.getItem("b")]);
    expect(a).toBe("1");
    expect(b).toBe("2");
    storage.dispose();
  });

  it("rejects when the worker reports an error", async () => {
    const errorPort: PortAdapter = {
      onmessage: null,
      postMessage(request: StorageRequest) {
        queueMicrotask(() => {
          errorPort.onmessage?.({
            data: { kind: "response", id: request.id, ok: false, error: "boom" },
          } as MessageEvent<StorageResponse>);
        });
      },
    };
    const storage = createSharedWorkerStorage({ port: errorPort });
    await expect(storage.getItem("k")).rejects.toThrow("boom");
    storage.dispose();
  });

  it("rejects when a request times out", async () => {
    const deadPort: PortAdapter = { onmessage: null, postMessage() {} }; // never replies
    const storage = createSharedWorkerStorage({ port: deadPort, timeoutMs: 20 });
    await expect(storage.getItem("k")).rejects.toThrow(/timed out/);
    storage.dispose();
  });

  it("rejects in-flight requests when disposed", async () => {
    const deadPort: PortAdapter = { onmessage: null, postMessage() {} };
    const storage = createSharedWorkerStorage({ port: deadPort });
    const inflight = storage.getItem("k");
    storage.dispose();
    await expect(inflight).rejects.toThrow(/disposed/);
  });
});
