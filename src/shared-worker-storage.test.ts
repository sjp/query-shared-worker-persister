import { describe, expect, it, vi } from "vite-plus/test";
import {
  createSharedWorkerStorage,
  isSharedWorkerSupported,
  type PortAdapter,
} from "./shared-worker-storage";
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

/** Run `fn` with `globalThis.SharedWorker` forced present/absent, then restore. */
async function withSharedWorker(value: unknown, fn: () => void | Promise<void>) {
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

describe("isSharedWorkerSupported", () => {
  it("is false when SharedWorker is absent", async () => {
    await withSharedWorker(undefined, () => {
      expect(isSharedWorkerSupported()).toBe(false);
    });
  });

  it("is true when SharedWorker is present", async () => {
    await withSharedWorker(class FakeSharedWorker {}, () => {
      expect(isSharedWorkerSupported()).toBe(true);
    });
  });
});

describe("no-op fallback when SharedWorker is unavailable", () => {
  it("returns a no-op storage (never persists) and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withSharedWorker(undefined, async () => {
        const storage = createSharedWorkerStorage();
        await storage.setItem("k", "v");
        await expect(storage.getItem("k")).resolves.toBeNull();
        await storage.removeItem("k");
        expect(() => storage.dispose()).not.toThrow();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn or fall back when a port is injected", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withSharedWorker(undefined, async () => {
        const storage = createSharedWorkerStorage({ port: createFakePort() });
        await storage.setItem("k", "v");
        await expect(storage.getItem("k")).resolves.toBe("v");
        expect(warn).not.toHaveBeenCalled();
        storage.dispose();
      });
    } finally {
      warn.mockRestore();
    }
  });
});
