import { experimental_createQueryPersister } from "@tanstack/query-persist-client-core";
import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  type CreateSharedWorkerStorageOptions,
  createSharedWorkerStorage,
  isSharedWorkerSupported,
  type PortAdapter,
  type SharedWorkerStorage,
  SharedWorkerStorageError,
} from "./shared-worker-storage";
import { createFakePort, fakeSharedWorker, withSharedWorker } from "./test-utils";
import type { StorageRequest, StorageResponse } from "./worker/protocol";
import { CacheStore } from "./worker/store";

/** The fake worker instance {@link fakeSharedWorker} hands back. */
type FakeWorker = ReturnType<typeof fakeSharedWorker>["latest"];

/** A port that answers every request with the same worker-side error. */
function createErrorPort(error = "boom"): PortAdapter {
  const port: PortAdapter = {
    onmessage: null,
    postMessage(request: StorageRequest) {
      queueMicrotask(() => {
        port.onmessage?.({
          data: { kind: "response", id: request.id, ok: false, error },
        } as MessageEvent<StorageResponse>);
      });
    },
  };
  return port;
}

/** A port that never answers, so only the client itself can settle a request. */
function createDeadPort(): PortAdapter {
  return { onmessage: null, postMessage() {} };
}

/** The error a call rejected with, asserted to be one of ours. */
async function rejectionFrom(call: () => unknown): Promise<SharedWorkerStorageError> {
  const error = await Promise.resolve(call()).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SharedWorkerStorageError);
  return error as SharedWorkerStorageError;
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

  it("entries returns every pair held by the worker", async () => {
    const storage = createSharedWorkerStorage({ port: createFakePort() });
    await expect(storage.entries()).resolves.toEqual([]);
    await storage.setItem("a", "1");
    await storage.setItem("b", "2");
    await expect(storage.entries()).resolves.toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    await storage.removeItem("a");
    await expect(storage.entries()).resolves.toEqual([["b", "2"]]);
    storage.dispose();
  });

  it("rejects a write whose response carries the wrong result shape", async () => {
    // A same-origin sender - or a mismatched build sharing the worker - can
    // answer with a well-formed envelope carrying the other operation's result.
    const port: PortAdapter = {
      onmessage: null,
      postMessage(request: StorageRequest) {
        queueMicrotask(() => {
          port.onmessage?.({
            data: { kind: "response", id: request.id, ok: true, result: [["a", "1"]] },
          } as MessageEvent<StorageResponse>);
        });
      },
    };
    const storage = createSharedWorkerStorage({ port, timeoutMs: 60_000 });
    await expect(storage.setItem("k", "v")).rejects.toThrow(/unexpected setItem result/);
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

  it("rejects a write when the worker reports an error", async () => {
    const storage = createSharedWorkerStorage({ port: createErrorPort() });
    await expect(storage.setItem("k", "v")).rejects.toThrow("boom");
    storage.dispose();
  });

  it("rejects a write that times out", async () => {
    const storage = createSharedWorkerStorage({ port: createDeadPort(), timeoutMs: 20 });
    await expect(storage.setItem("k", "v")).rejects.toThrow(/timed out/);
    storage.dispose();
  });

  it("rejects in-flight writes when disposed", async () => {
    const storage = createSharedWorkerStorage({ port: createDeadPort() });
    const inflight = storage.setItem("k", "v");
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

  it("rejects writes issued after disposal without waiting out the timeout", async () => {
    const postMessage = vi.fn();
    // The timeout is far longer than the test could tolerate, so a rejection
    // arriving at all proves it came from the fast path rather than the timer.
    const port: PortAdapter = { onmessage: null, postMessage };
    const storage = createSharedWorkerStorage({ port, timeoutMs: 60_000 });
    storage.dispose();
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

  it("disposes through Symbol.dispose exactly as dispose does", async () => {
    const close = vi.fn();
    const port: PortAdapter = { onmessage: null, postMessage() {}, close };
    const storage = createSharedWorkerStorage({ port, timeoutMs: 60_000 });
    const inflight = storage.setItem("k", "v");
    storage[Symbol.dispose]();
    await expect(inflight).rejects.toThrow(/disposed/);
    expect(close).toHaveBeenCalledTimes(1);
    expect(port.onmessage).toBeNull();
    // The two names are one teardown, so the other is a no-op afterwards.
    storage.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("releases the storage when a `using` declaration goes out of scope", async () => {
    const close = vi.fn();
    const port: PortAdapter = { onmessage: null, postMessage() {}, close };
    let inflight: Promise<unknown>;
    {
      using storage = createSharedWorkerStorage({ port, timeoutMs: 60_000 });
      inflight = Promise.resolve(storage.setItem("k", "v"));
      expect(close).not.toHaveBeenCalled();
    }
    expect(close).toHaveBeenCalledTimes(1);
    await expect(inflight).rejects.toThrow(/disposed/);
  });

  it("settles in-flight requests and logs when the port reports a message error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deadPort = createDeadPort();
      const storage = createSharedWorkerStorage({ port: deadPort });
      const inflight = storage.setItem("k", "v");
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

  it.each([
    ["a message that is not a response", { kind: "broadcast", id: 1, payload: "hi" }],
    ["a response with no ok flag", { kind: "response", id: 1, result: "v" }],
    ["an ok response with no result", { kind: "response", id: 1, ok: true }],
    ["an error response with no message", { kind: "response", id: 1, ok: false }],
    ["a non-object payload", "hello"],
  ])("ignores %s and leaves the request pending", async (_label, data) => {
    const port = createDeadPort();
    const storage = createSharedWorkerStorage({ port, timeoutMs: 20 });
    const inflight = storage.setItem("k", "v");
    port.onmessage?.({ data } as MessageEvent<unknown>);
    // Only the timeout settles it, proving the stray message never matched the
    // pending id - it would otherwise have settled the request early.
    await expect(inflight).rejects.toThrow(/timed out/);
    storage.dispose();
  });

  it("still settles a real response delivered after a stray message", async () => {
    const store = new CacheStore();
    store.setItem("k", "v");
    const port = createFakePort(store);
    const storage = createSharedWorkerStorage({ port });
    const inflight = storage.getItem("k");
    port.onmessage?.({ data: { kind: "broadcast", id: 1 } } as MessageEvent<unknown>);
    await expect(inflight).resolves.toBe("v");
    storage.dispose();
  });

  it("disposes when the provided signal aborts", async () => {
    const controller = new AbortController();
    const storage = createSharedWorkerStorage({
      port: createDeadPort(),
      signal: controller.signal,
    });
    const inflight = storage.setItem("k", "v");
    controller.abort();
    await expect(inflight).rejects.toThrow(/disposed/);
  });

  it("never takes up its port when given an already-aborted signal", async () => {
    const reported: SharedWorkerStorageError[] = [];
    const port = createFakePort();
    const storage = createSharedWorkerStorage({
      port,
      signal: AbortSignal.abort(),
      onError: (error) => void reported.push(error),
    });

    // The port was never taken up: no handler was installed on it, so nothing
    // it says is ever processed and it is still the caller's to use. Nothing is
    // reported either, for a storage nobody asked to keep.
    expect(port.onmessage).toBeNull();
    expect(reported).toEqual([]);
    // In every other way it is the storage a `dispose()` on the next line would
    // have left: writes reject, reads resolve empty, disposal has nothing to do.
    expect(storage.mode).toBe("shared-worker");
    expect((await rejectionFrom(() => storage.setItem("k", "v"))).code).toBe("disposed");
    await expect(storage.getItem("k")).resolves.toBeNull();
    await expect(storage.entries()).resolves.toEqual([]);
    expect(() => {
      storage.dispose();
    }).not.toThrow();
  });

  it("constructs no SharedWorker when the signal has already aborted", async () => {
    const reported: SharedWorkerStorageError[] = [];
    const worker = fakeSharedWorker();
    await withSharedWorker(worker.FakeSharedWorker, async () => {
      const storage = createSharedWorkerStorage({
        signal: AbortSignal.abort(),
        onError: (error) => void reported.push(error),
      });
      // No worker process is spawned, and no connection opened, for a storage
      // that is over before it begins.
      expect(worker.constructions).toEqual([]);
      expect(reported).toEqual([]);
      expect((await rejectionFrom(() => storage.setItem("k", "v"))).code).toBe("disposed");
    });
  });

  it("says nothing about an environment it was aborted out of", async () => {
    const reported: SharedWorkerStorageError[] = [];
    await withSharedWorker(undefined, () => {
      const storage = createSharedWorkerStorage({
        signal: AbortSignal.abort(),
        onError: (error) => void reported.push(error),
      });
      // The no-op fallback is still all there was to give, and `mode` still says
      // so; there is just nobody left to warn about it.
      expect(storage.mode).toBe("noop");
      expect(reported).toEqual([]);
    });
  });

  it("detaches its abort listener when disposed by hand", () => {
    // One controller can outlive many storages, and every listener left on it
    // holds its storage - pending map and port included - alive with it.
    const controller = new AbortController();
    const { signal } = controller;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    const storage = createSharedWorkerStorage({ port: createFakePort(), signal });

    storage.dispose();

    // Every listener the storage attached was handed back, so nothing of it is
    // still reachable from a signal that may never abort.
    const attached = add.mock.calls.map(([, listener]) => listener);
    const detached = remove.mock.calls.map(([, listener]) => listener);
    expect(attached).toHaveLength(1);
    expect(detached).toEqual(attached);
    // Aborting a signal the storage has let go of is still a no-op for it.
    expect(() => {
      controller.abort();
    }).not.toThrow();
  });
});

/**
 * Every value rejected here is one `setTimeout` accepts and then fires on
 * immediately, so without validation the option would look honoured while every
 * request failed on the next tick - a cache that is simply always cold.
 */
describe("the timeoutMs option", () => {
  const invalid: Array<[label: string, value: number]> = [
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    // One past the largest delay a 32-bit timer can hold, which overflows to 0.
    ["above the timer limit", 2_147_483_648],
  ];

  for (const [label, value] of invalid) {
    it(`throws for a ${label} timeout, naming the option and the range`, () => {
      expect(() => createSharedWorkerStorage({ port: createFakePort(), timeoutMs: value })).toThrow(
        RangeError,
      );
      expect(() => createSharedWorkerStorage({ port: createFakePort(), timeoutMs: value })).toThrow(
        /timeoutMs must be a number greater than 0 and at most 2147483647/,
      );
    });
  }

  it("throws even where SharedWorker is unavailable, so the option is checked everywhere", async () => {
    await withSharedWorker(undefined, () => {
      expect(() => createSharedWorkerStorage({ timeoutMs: 0 })).toThrow(RangeError);
    });
  });

  it("accepts the largest delay a timer can hold", () => {
    const storage = createSharedWorkerStorage({
      port: createFakePort(),
      timeoutMs: 2_147_483_647,
    });
    expect(storage.mode).toBe("shared-worker");
    storage.dispose();
  });

  it("leaves a request pending forever when given Infinity", async () => {
    const storage = createSharedWorkerStorage({
      port: createDeadPort(),
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    const write = Promise.resolve(storage.setItem("k", "v"));
    const settled = vi.fn();
    void write.then(settled, settled);
    // Long enough that any timer the overflow would have created - the 0ms one a
    // raw `setTimeout(fn, Infinity)` produces - would have fired several times.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).not.toHaveBeenCalled();

    // Only disposal settles it, and the write rejects rather than hanging on.
    storage.dispose();
    await expect(write).rejects.toThrow(/disposed/);
  });

  it("still answers a request normally when given Infinity", async () => {
    using storage = createSharedWorkerStorage({
      port: createFakePort(),
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    await storage.setItem("k", "v");
    await expect(storage.getItem("k")).resolves.toBe("v");
  });
});

/**
 * `persistQueryClient` reads a rejected restore as a corrupt cache and answers
 * it by calling `removeClient()` - which, on a store the worker shares, deletes
 * the entry every other tab is using. A tab that was merely slow would take the
 * whole cache down with it, so reads resolve empty instead of rejecting.
 */
describe("a read the worker cannot answer", () => {
  /** What both reads produced, and how many warnings they logged. */
  async function readFrom(storage: SharedWorkerStorage) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      return {
        item: await storage.getItem("k"),
        entries: await storage.entries(),
        warnings: warn.mock.calls.length,
      };
    } finally {
      warn.mockRestore();
    }
  }

  it("resolves empty and warns when the worker never answers", async () => {
    const storage = createSharedWorkerStorage({ port: createDeadPort(), timeoutMs: 20 });
    await expect(readFrom(storage)).resolves.toEqual({ item: null, entries: [], warnings: 2 });
    storage.dispose();
  });

  it("resolves empty and warns when the worker reports an error", async () => {
    const storage = createSharedWorkerStorage({ port: createErrorPort() });
    await expect(readFrom(storage)).resolves.toEqual({ item: null, entries: [], warnings: 2 });
    storage.dispose();
  });

  it("resolves empty once the storage is disposed", async () => {
    // Far longer a timeout than the test could tolerate, so resolving at all
    // proves the answer came from the fast path rather than the timer.
    const storage = createSharedWorkerStorage({ port: createFakePort(), timeoutMs: 60_000 });
    storage.dispose();
    await expect(readFrom(storage)).resolves.toEqual({ item: null, entries: [], warnings: 2 });
  });

  it("leaves writes rejecting, so a failed save still reaches the caller", async () => {
    const storage = createSharedWorkerStorage({ port: createDeadPort(), timeoutMs: 20 });
    await expect(storage.setItem("k", "v")).rejects.toThrow(/timed out/);
    await expect(storage.removeItem("k")).rejects.toThrow(/timed out/);
    storage.dispose();
  });
});

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
        await expect(storage.entries()).resolves.toEqual([]);
        await storage.removeItem("k");
        expect(() => storage.dispose()).not.toThrow();
        // The fallback carries the same disposal surface, so a caller using
        // `using` or `dispose()` needs no branch on which storage it was given.
        expect(() => storage[Symbol.dispose]()).not.toThrow();
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
        await expect(storage.entries()).resolves.toEqual([]);
        await storage.removeItem("k");
        expect(() => storage.dispose()).not.toThrow();
        // The fallback carries the same disposal surface, so a caller using
        // `using` or `dispose()` needs no branch on which storage it was given.
        expect(() => storage[Symbol.dispose]()).not.toThrow();
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

describe("the SharedWorker it constructs", () => {
  /** Construct a storage over a recording fake and hand back what it asked for. */
  async function constructionFor(options?: CreateSharedWorkerStorageOptions) {
    const { FakeSharedWorker, constructions } = fakeSharedWorker({ dead: true });
    await withSharedWorker(FakeSharedWorker, () => {
      createSharedWorkerStorage(options).dispose();
    });
    const construction = constructions[0];
    if (!construction) throw new Error("no SharedWorker was constructed");
    return construction;
  }

  it("defaults to the cache.worker.js published beside this module", async () => {
    // Resolved against this module's own URL, which is what the consumer's
    // bundler has to trace in order to copy the asset into its output.
    const { url } = await constructionFor();
    expect(url).toEqual(new URL("./cache.worker.js", import.meta.url));
  });

  it("uses workerUrl instead when one is given", async () => {
    await expect(constructionFor({ workerUrl: "/static/cache.worker.js" })).resolves.toMatchObject({
      url: "/static/cache.worker.js",
    });
    const absolute = new URL("https://example.test/w.js");
    await expect(constructionFor({ workerUrl: absolute })).resolves.toMatchObject({
      url: absolute,
    });
  });

  it("loads the worker as a module", async () => {
    // The worker source imports its store and its connection handling, so it
    // can only run as a module worker; a classic one would fail to parse.
    const { options } = await constructionFor();
    expect(options?.type).toBe("module");
  });

  it("names the worker so every tab reaches the same one", async () => {
    // The name is half the worker's identity, so it has to be spelled the same
    // in every tab, and stay stable across releases - changing it would strand
    // already-open tabs on a worker that nothing new connects to.
    const { options } = await constructionFor();
    expect(options?.name).toBe("TANSTACK_QUERY_SHARED_CACHE_WORKER");
  });

  it("appends a namespace to that name, giving the app a worker of its own", async () => {
    const { options } = await constructionFor({ namespace: "MY_APP" });
    expect(options?.name).toBe("TANSTACK_QUERY_SHARED_CACHE_WORKER:MY_APP");
  });
});

describe("when the SharedWorker itself fails", () => {
  /** Build a storage over a fresh fake worker and hand back both. */
  async function withFailingWorker(
    fn: (worker: FakeWorker, storage: SharedWorkerStorage) => Promise<void>,
  ) {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const worker = fakeSharedWorker({ dead: true });
      await withSharedWorker(worker.FakeSharedWorker, async () => {
        // Far longer than the test could tolerate, so any rejection that arrives
        // proves it came from the fast path rather than the timer.
        const storage = createSharedWorkerStorage({ timeoutMs: 60_000 });
        await fn(worker.latest, storage);
        storage.dispose();
      });
    } finally {
      error.mockRestore();
    }
  }

  it("rejects the in-flight writes with the transport error", async () => {
    await withFailingWorker(async (worker, storage) => {
      const inflight = storage.setItem("k", "v");
      worker.fail("404");
      await expect(inflight).rejects.toThrow(/SharedWorker failed: 404/);
    });
  });

  it("settles later requests immediately instead of waiting out the timeout", async () => {
    await withFailingWorker(async (worker, storage) => {
      worker.fail();
      await expect(storage.setItem("k", "v")).rejects.toThrow(/SharedWorker failed/);
      await expect(storage.removeItem("k")).rejects.toThrow(/SharedWorker failed/);
      // Reads answer just as promptly, but as an empty cache rather than an error.
      await expect(storage.getItem("k")).resolves.toBeNull();
      await expect(storage.entries()).resolves.toEqual([]);
    });
  });

  it("stops posting to the dead port and closes it", async () => {
    await withFailingWorker(async (worker, storage) => {
      worker.fail();
      expect(worker.close).toHaveBeenCalledTimes(1);
      expect(worker.port.onmessage).toBeNull();
      worker.postMessage.mockClear();
      await expect(storage.setItem("k", "v")).rejects.toThrow(/SharedWorker failed/);
      expect(worker.postMessage).not.toHaveBeenCalled();
    });
  });

  it("logs the failure once however many requests follow", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const worker = fakeSharedWorker({ dead: true });
      await withSharedWorker(worker.FakeSharedWorker, async () => {
        const storage = createSharedWorkerStorage({ timeoutMs: 60_000 });
        worker.latest.fail();
        await expect(
          Promise.allSettled([
            storage.getItem("a"),
            storage.setItem("b", "1"),
            storage.removeItem("c"),
          ]),
        ).resolves.toHaveLength(3);
        expect(error).toHaveBeenCalledTimes(1);
        // The read fell back to an empty result without repeating the report.
        expect(warn).not.toHaveBeenCalled();
        storage.dispose();
      });
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("when the port refuses the message", () => {
  /**
   * A port whose `postMessage` throws, as a real `MessagePort` does for a value
   * that cannot be structured-cloned.
   */
  function createRefusingPort(cause: unknown): PortAdapter {
    return {
      onmessage: null,
      postMessage() {
        throw cause;
      },
    };
  }

  /** What a real port throws for an unclonable value. */
  function cloneError() {
    return new DOMException("a function could not be cloned", "DataCloneError");
  }

  it("rejects a write as a transport failure, keeping the refusal as the cause", async () => {
    const cause = cloneError();
    const storage = createSharedWorkerStorage({ port: createRefusingPort(cause) });
    const error = await rejectionFrom(() => storage.setItem("k", "v"));
    expect(error.code).toBe("transport");
    expect(error.message).toContain("a function could not be cloned");
    expect(error.cause).toBe(cause);
    storage.dispose();
  });

  it("leaves no timer scheduled for a request that never left the tab", async () => {
    vi.useFakeTimers();
    try {
      const storage = createSharedWorkerStorage({
        port: createRefusingPort(cloneError()),
        // Long enough that a surviving timer would still be scheduled here.
        timeoutMs: 60_000,
      });
      await expect(storage.setItem("k", "v")).rejects.toThrow(/Could not post a request/);
      expect(vi.getTimerCount()).toBe(0);
      // The pending entry is gone with it, so this has nothing left to settle.
      expect(() => storage.dispose()).not.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a read empty and reports it once, under transport", async () => {
    const reported: SharedWorkerStorageError[] = [];
    const storage = createSharedWorkerStorage({
      port: createRefusingPort(cloneError()),
      onError: (error) => void reported.push(error),
    });
    await expect(storage.getItem("k")).resolves.toBeNull();
    storage.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("transport");
    expect((reported[0]?.cause as SharedWorkerStorageError | undefined)?.code).toBe("transport");
  });

  it("leaves the port usable, since one value it refused condemns nothing", async () => {
    const port = createFakePort();
    const send = port.postMessage.bind(port);
    let refuse = true;
    port.postMessage = (request: StorageRequest) => {
      if (refuse) throw cloneError();
      send(request);
    };
    const storage = createSharedWorkerStorage({ port });
    await expect(storage.setItem("k", "v")).rejects.toThrow(/Could not post a request/);
    refuse = false;
    await storage.setItem("k", "v");
    await expect(storage.getItem("k")).resolves.toBe("v");
    storage.dispose();
  });
});

describe("per-query persistence", () => {
  /**
   * `experimental_createQueryPersister` stores one key per query hash and needs
   * `entries()` to find them again. Two storages over one `CacheStore` stand in
   * for two tabs sharing a worker.
   */
  it("persists a query under its own key and restores it in another tab", async () => {
    const store = new CacheStore();
    const writer = createSharedWorkerStorage({ port: createFakePort(store) });

    const source = new QueryClient();
    source.setQueryData(["user", 1], { name: "Ada" });
    const query = source.getQueryCache().find({ queryKey: ["user", 1] });
    if (!query) throw new Error("the query was not created");
    await experimental_createQueryPersister({ storage: writer }).persistQuery(query);

    await expect(writer.entries()).resolves.toEqual([
      [`tanstack-query-${query.queryHash}`, expect.any(String)],
    ]);

    const reader = createSharedWorkerStorage({ port: createFakePort(store) });
    const target = new QueryClient();
    await experimental_createQueryPersister({ storage: reader }).restoreQueries(target);
    expect(target.getQueryData(["user", 1])).toEqual({ name: "Ada" });

    writer.dispose();
    reader.dispose();
  });

  it("leaves the other tab's queries alone when one removes its own", async () => {
    const store = new CacheStore();
    const storage = createSharedWorkerStorage({ port: createFakePort(store) });
    const persister = experimental_createQueryPersister({ storage });

    const client = new QueryClient();
    client.setQueryData(["user", 1], { name: "Ada" });
    client.setQueryData(["user", 2], { name: "Grace" });
    const cache = client.getQueryCache();
    for (const query of cache.getAll()) await persister.persistQuery(query);

    await persister.removeQueries({ queryKey: ["user", 1], exact: true });

    const restored = new QueryClient();
    await persister.restoreQueries(restored);
    expect(restored.getQueryData(["user", 1])).toBeUndefined();
    expect(restored.getQueryData(["user", 2])).toEqual({ name: "Grace" });

    storage.dispose();
  });
});

/**
 * Nothing here is decoration: an application with structured logging, an error
 * reporter, or a rule against console output in production has to be able to
 * take these reports, and a cache that has quietly degraded to no-op has to be
 * something code can notice rather than a string in a devtools panel.
 */
describe("diagnostics", () => {
  /** A callback that records what it was given, plus the list it records into. */
  function recorder() {
    const reported: SharedWorkerStorageError[] = [];
    return { reported, onError: (error: SharedWorkerStorageError) => void reported.push(error) };
  }

  /** Run `fn` with both console channels spied on, and hand it the spies. */
  async function withSilentConsole(
    fn: (console: {
      warn: ReturnType<typeof vi.spyOn>;
      error: ReturnType<typeof vi.spyOn>;
    }) => Promise<void>,
  ) {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fn({ warn, error });
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  }

  it("reports the unsupported fallback to onError instead of the console", async () => {
    const { reported, onError } = recorder();
    await withSilentConsole(async (spies) => {
      await withSharedWorker(undefined, () => {
        const storage = createSharedWorkerStorage({ onError });
        expect(storage.mode).toBe("noop");
      });
      expect(spies.warn).not.toHaveBeenCalled();
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("unsupported");
    expect(reported[0]?.message).toContain("no-op storage");
  });

  it("reports a constructor that refuses the call, keeping the refusal as the cause", async () => {
    class ThrowingSharedWorker {
      constructor() {
        throw new DOMException("access denied", "SecurityError");
      }
    }
    const { reported, onError } = recorder();
    await withSilentConsole(async (spies) => {
      await withSharedWorker(ThrowingSharedWorker, () => {
        expect(createSharedWorkerStorage({ onError }).mode).toBe("noop");
      });
      expect(spies.warn).not.toHaveBeenCalled();
    });
    expect(reported[0]?.code).toBe("unsupported");
    expect((reported[0]?.cause as Error | undefined)?.message).toBe("access denied");
  });

  it("reports a worker that fails after construction once, and rejects with that error", async () => {
    const { reported, onError } = recorder();
    await withSilentConsole(async (spies) => {
      const worker = fakeSharedWorker({ dead: true });
      await withSharedWorker(worker.FakeSharedWorker, async () => {
        // Longer a timeout than the test could tolerate, so anything that
        // settles proves it came from the failure rather than the timer.
        const storage = createSharedWorkerStorage({ onError, timeoutMs: 60_000 });
        expect(storage.mode).toBe("shared-worker");
        worker.latest.fail("404");
        // The report and the rejection are the same error, so a reporter and a
        // `retry` hook are looking at one failure rather than two descriptions.
        await expect(storage.setItem("k", "v")).rejects.toBe(reported[0]);
        // A read that fell back to empty because of that same failure is not
        // reported again - one dead worker, one report.
        await expect(storage.getItem("k")).resolves.toBeNull();
        storage.dispose();
      });
      expect(spies.error).not.toHaveBeenCalled();
      expect(spies.warn).not.toHaveBeenCalled();
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("transport");
    expect(reported[0]?.message).toContain("404");
  });

  it("reports an undeserializable message as a non-terminal transport failure", async () => {
    const { reported, onError } = recorder();
    await withSilentConsole(async (spies) => {
      const port = createFakePort();
      const storage = createSharedWorkerStorage({ port, onError });
      port.onmessageerror?.({} as MessageEvent);
      await storage.setItem("k", "v");
      expect(spies.error).not.toHaveBeenCalled();
      storage.dispose();
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("transport");
  });

  it("reports a read that resolved empty, under the code of what stopped it", async () => {
    const { reported, onError } = recorder();
    await withSilentConsole(async (spies) => {
      const storage = createSharedWorkerStorage({ port: createDeadPort(), timeoutMs: 20, onError });
      await expect(storage.getItem("k")).resolves.toBeNull();
      await expect(storage.entries()).resolves.toEqual([]);
      expect(spies.warn).not.toHaveBeenCalled();
      storage.dispose();
    });
    expect(reported).toHaveLength(2);
    expect(reported.map((error) => error.code)).toEqual(["timeout", "timeout"]);
    // The read that gave up is described, and the failure it gave up on is kept.
    expect(reported[0]?.message).toContain("continuing as though it were empty");
    expect((reported[0]?.cause as SharedWorkerStorageError | undefined)?.code).toBe("timeout");
  });

  it("leaves the console alone in the paths that report nothing", async () => {
    const { reported, onError } = recorder();
    const storage = createSharedWorkerStorage({ port: createFakePort(), onError });
    await storage.setItem("k", "v");
    await expect(storage.getItem("k")).resolves.toBe("v");
    storage.dispose();
    expect(reported).toEqual([]);
  });

  it("tags a write the worker never answered as a timeout", async () => {
    const storage = createSharedWorkerStorage({ port: createDeadPort(), timeoutMs: 20 });
    expect((await rejectionFrom(() => storage.setItem("k", "v"))).code).toBe("timeout");
    storage.dispose();
  });

  it("tags a write the worker answered with an error as a protocol failure", async () => {
    const storage = createSharedWorkerStorage({ port: createErrorPort() });
    expect((await rejectionFrom(() => storage.setItem("k", "v"))).code).toBe("protocol");
    storage.dispose();
  });

  it("tags a request made after dispose", async () => {
    const storage = createSharedWorkerStorage({ port: createFakePort() });
    storage.dispose();
    expect((await rejectionFrom(() => storage.setItem("k", "v"))).code).toBe("disposed");
  });

  it("reports mode so a caller can tell a live storage from a no-op one", async () => {
    expect(createSharedWorkerStorage({ port: createFakePort() }).mode).toBe("shared-worker");
    await withSharedWorker(undefined, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(createSharedWorkerStorage().mode).toBe("noop");
      } finally {
        warn.mockRestore();
      }
    });
  });
});

/**
 * A reporter is the caller's code running inside ours, at the exact moments
 * something is being promised: a read on its way to resolving empty, a dead
 * worker halfway through being shut down. A logger that is itself broken has to
 * stay a logging problem, and be loud about it.
 */
describe("an onError handler that throws", () => {
  const thrown = new Error("logger down");
  const throwingOnError = () => {
    throw thrown;
  };

  /** Run `fn` with `console.error` spied on, and hand it the spy. */
  async function withSpiedConsoleError(fn: (spy: ReturnType<typeof vi.spyOn>) => Promise<void>) {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fn(spy);
    } finally {
      spy.mockRestore();
    }
  }

  it("still resolves a failed read empty, and puts the throw on the console", async () => {
    await withSpiedConsoleError(async (spy) => {
      const storage = createSharedWorkerStorage({
        port: createDeadPort(),
        timeoutMs: 20,
        onError: throwingOnError,
      });
      await expect(storage.getItem("k")).resolves.toBeNull();
      await expect(storage.entries()).resolves.toEqual([]);
      storage.dispose();
      // One report per read, each one logged with the throw and the error the
      // handler was given, so neither failure is lost.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("onError handler threw"),
        thrown,
        expect.any(SharedWorkerStorageError),
      );
    });
  });

  it("leaves a failed write rejecting with its own error", async () => {
    const storage = createSharedWorkerStorage({
      port: createErrorPort(),
      onError: throwingOnError,
    });
    expect((await rejectionFrom(() => storage.setItem("k", "v"))).code).toBe("protocol");
    storage.dispose();
  });

  it("still shuts down a worker that failed after construction", async () => {
    await withSpiedConsoleError(async (spy) => {
      const worker = fakeSharedWorker({ dead: true });
      const failure = await withSharedWorker(worker.FakeSharedWorker, async () => {
        // Longer a timeout than the test could tolerate, so anything that
        // settles proves it came from the failure rather than the timer.
        const storage = createSharedWorkerStorage({ onError: throwingOnError, timeoutMs: 60_000 });
        const inFlight = storage.setItem("k", "v");
        worker.latest.fail("404");
        const failure = await rejectionFrom(() => inFlight);
        expect(failure.code).toBe("transport");
        expect(failure.message).toContain("404");
        // The bookkeeping the report interrupted all happened: the port is
        // closed, later writes fail fast on the recorded error rather than
        // waiting out the timeout, and later reads still resolve empty.
        expect(worker.latest.close).toHaveBeenCalled();
        await expect(storage.setItem("k", "v")).rejects.toBe(failure);
        await expect(storage.getItem("k")).resolves.toBeNull();
        storage.dispose();
        return failure;
      });
      // One dead worker, one report, and one log of the handler that threw on it.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("onError handler threw"),
        thrown,
        failure,
      );
    });
  });

  it("does not escape construction of an unsupported storage", async () => {
    await withSpiedConsoleError(async (spy) => {
      await withSharedWorker(undefined, () => {
        expect(createSharedWorkerStorage({ onError: throwingOnError }).mode).toBe("noop");
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("onError handler threw"),
        thrown,
        expect.any(SharedWorkerStorageError),
      );
    });
  });
});
