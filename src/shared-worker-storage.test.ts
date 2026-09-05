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

  it("closes the port and detaches handlers when disposed", () => {
    const close = vi.fn();
    const port: PortAdapter = { onmessage: null, postMessage() {}, close };
    const storage = createSharedWorkerStorage({ port });
    storage.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    expect(port.onmessage).toBeNull();
    expect(port.onmessageerror).toBeNull();
  });

  it("rejects requests issued after disposal without waiting out the timeout", async () => {
    const postMessage = vi.fn();
    // The timeout is far longer than the test could tolerate, so a rejection
    // arriving at all proves it came from the fast path rather than the timer.
    const port: PortAdapter = { onmessage: null, postMessage };
    const storage = createSharedWorkerStorage({ port, timeoutMs: 60_000 });
    storage.dispose();
    await expect(storage.getItem("k")).rejects.toThrow(/disposed/);
    await expect(storage.setItem("k", "v")).rejects.toThrow(/disposed/);
    await expect(storage.removeItem("k")).rejects.toThrow(/disposed/);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("is idempotent: disposing twice does not close the port twice or throw", () => {
    const close = vi.fn();
    const port: PortAdapter = { onmessage: null, postMessage() {}, close };
    const storage = createSharedWorkerStorage({ port });
    storage.dispose();
    expect(() => storage.dispose()).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects in-flight requests and logs when the port reports a message error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deadPort: PortAdapter = { onmessage: null, postMessage() {} };
      const storage = createSharedWorkerStorage({ port: deadPort });
      const inflight = storage.getItem("k");
      deadPort.onmessageerror?.({} as MessageEvent);
      await expect(inflight).rejects.toThrow(/deserialized/);
      expect(error).toHaveBeenCalledTimes(1);
      storage.dispose();
    } finally {
      error.mockRestore();
    }
  });

  it("keeps the port usable after a single undeserializable message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const port = createFakePort();
      const storage = createSharedWorkerStorage({ port });
      port.onmessageerror?.({} as MessageEvent);
      // The worker is still there, so the next round trip must go through.
      await storage.setItem("k", "v");
      await expect(storage.getItem("k")).resolves.toBe("v");
      expect(error).toHaveBeenCalledTimes(1);
      storage.dispose();
    } finally {
      error.mockRestore();
    }
  });

  it("disposes when the provided signal aborts", async () => {
    const deadPort: PortAdapter = { onmessage: null, postMessage() {} };
    const controller = new AbortController();
    const storage = createSharedWorkerStorage({ port: deadPort, signal: controller.signal });
    const inflight = storage.getItem("k");
    controller.abort();
    await expect(inflight).rejects.toThrow(/disposed/);
  });

  it("disposes immediately when given an already-aborted signal", () => {
    const port = createFakePort();
    createSharedWorkerStorage({ port, signal: AbortSignal.abort() });
    // Disposal detaches the port handler, so no responses are ever processed.
    expect(port.onmessage).toBeNull();
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

  it("falls back and warns once when the SharedWorker constructor throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // An opaque origin (sandboxed iframe, blob:/data:/file: document) exposes
      // the constructor and then rejects the call.
      class ThrowingSharedWorker {
        constructor() {
          throw new DOMException("access denied", "SecurityError");
        }
      }
      await withSharedWorker(ThrowingSharedWorker, async () => {
        let storage!: ReturnType<typeof createSharedWorkerStorage>;
        expect(() => {
          storage = createSharedWorkerStorage();
        }).not.toThrow();
        await storage.setItem("k", "v");
        await expect(storage.getItem("k")).resolves.toBeNull();
        await storage.removeItem("k");
        expect(() => storage.dispose()).not.toThrow();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("access denied");
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

/**
 * A `SharedWorker` stand-in whose port never replies, so the only thing that can
 * settle a request is the storage itself. `fail()` fires `onerror` the way the
 * browser does when the worker script can't be loaded.
 */
class FakeSharedWorker {
  static latest: FakeSharedWorker | undefined;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  port: PortAdapter;

  constructor() {
    this.port = { onmessage: null, postMessage: this.postMessage, close: this.close };
    FakeSharedWorker.latest = this;
  }

  fail(message = "boot failed") {
    this.onerror?.({ message });
  }
}

describe("when the SharedWorker itself fails", () => {
  /** Build a storage over a fresh {@link FakeSharedWorker} and hand back both. */
  async function withFailingWorker(
    fn: (
      worker: FakeSharedWorker,
      storage: ReturnType<typeof createSharedWorkerStorage>,
    ) => Promise<void>,
  ) {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withSharedWorker(FakeSharedWorker, async () => {
        // Far longer than the test could tolerate, so any rejection that arrives
        // proves it came from the fast path rather than the timer.
        const storage = createSharedWorkerStorage({ timeoutMs: 60_000 });
        const worker = FakeSharedWorker.latest;
        if (!worker) throw new Error("no SharedWorker was constructed");
        await fn(worker, storage);
        storage.dispose();
      });
    } finally {
      error.mockRestore();
    }
  }

  it("rejects the in-flight requests with the transport error", async () => {
    await withFailingWorker(async (worker, storage) => {
      const inflight = storage.getItem("k");
      worker.fail("404");
      await expect(inflight).rejects.toThrow(/SharedWorker failed: 404/);
    });
  });

  it("rejects later requests immediately instead of waiting out the timeout", async () => {
    await withFailingWorker(async (worker, storage) => {
      worker.fail();
      await expect(storage.getItem("k")).rejects.toThrow(/SharedWorker failed/);
      await expect(storage.setItem("k", "v")).rejects.toThrow(/SharedWorker failed/);
      await expect(storage.removeItem("k")).rejects.toThrow(/SharedWorker failed/);
    });
  });

  it("stops posting to the dead port and closes it", async () => {
    await withFailingWorker(async (worker, storage) => {
      worker.fail();
      expect(worker.close).toHaveBeenCalledTimes(1);
      expect(worker.port.onmessage).toBeNull();
      worker.postMessage.mockClear();
      await expect(storage.getItem("k")).rejects.toThrow(/SharedWorker failed/);
      expect(worker.postMessage).not.toHaveBeenCalled();
    });
  });

  it("logs the failure once however many requests follow", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withSharedWorker(FakeSharedWorker, async () => {
        const storage = createSharedWorkerStorage({ timeoutMs: 60_000 });
        FakeSharedWorker.latest?.fail();
        await expect(
          Promise.allSettled([
            storage.getItem("a"),
            storage.setItem("b", "1"),
            storage.removeItem("c"),
          ]),
        ).resolves.toHaveLength(3);
        expect(error).toHaveBeenCalledTimes(1);
        storage.dispose();
      });
    } finally {
      error.mockRestore();
    }
  });
});
