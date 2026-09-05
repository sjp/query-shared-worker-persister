import { describe, expect, it, vi } from "vite-plus/test";
import {
  createSharedWorkerStorage,
  isSharedWorkerSupported,
  type PortAdapter,
  type SharedWorkerStorage,
  SharedWorkerStorageError,
} from "./shared-worker-storage";
import {
  createFakePort,
  fakeSharedWorker,
  recorder,
  rejectionFrom,
  withConsoleSpies,
  withDocument,
  withSharedWorker,
} from "./test-utils";
import type { StorageRequest } from "./worker/protocol";

/**
 * What the client does when there is no worker to talk to: none in this
 * environment, one whose script never loaded, or a port that won't carry the
 * message. Every one of these ends in a cache that isn't there, so what matters
 * is that the caller is told plainly and once.
 */

/** The fake worker instance {@link fakeSharedWorker} hands back. */
type FakeWorker = ReturnType<typeof fakeSharedWorker>["latest"];

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
    await withConsoleSpies(async ({ warn }) => {
      await withDocument({}, () =>
        withSharedWorker(undefined, async () => {
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
        }),
      );
    });
  });

  it("says nothing where there is no document, since a server never had a worker", async () => {
    const { reported, onError } = recorder();
    await withConsoleSpies(async ({ warn }) => {
      // A server or edge runtime evaluating the module that builds the
      // persister: the fallback is the only thing to give, and there is nothing
      // for anyone to do about it, so it is handed over in silence.
      await withSharedWorker(undefined, async () => {
        const storage = createSharedWorkerStorage({ onError });
        expect(storage.mode).toBe("noop");
        await storage.setItem("k", "v");
        await expect(storage.getItem("k")).resolves.toBeNull();
        storage.dispose();
      });
      expect(warn).not.toHaveBeenCalled();
      expect(reported).toEqual([]);
    });
  });

  it("falls back and warns once when the SharedWorker constructor throws", async () => {
    await withConsoleSpies(async ({ warn }) => {
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
        // The message is first so log filters keep matching, and the error
        // itself follows, so devtools can expand its `code` and its `cause`.
        const reported = warn.mock.calls[0]?.[1];
        expect(reported).toBeInstanceOf(SharedWorkerStorageError);
        expect((reported as SharedWorkerStorageError).code).toBe("unsupported");
        expect((reported as SharedWorkerStorageError).cause).toBeInstanceOf(DOMException);
      });
    });
  });

  it("names the workerUrl when the constructor refuses that instead", async () => {
    await withConsoleSpies(async ({ warn }) => {
      // What a URL the page can't load gets: same code path as the opaque
      // origin above, but the caller chose the URL, so that is what the report
      // puts first - a mistyped or unhosted path is their configuration, not
      // this browser's limits.
      class ThrowingSharedWorker {
        constructor() {
          throw new DOMException("the URL is invalid", "SyntaxError");
        }
      }
      await withSharedWorker(ThrowingSharedWorker, () => {
        const storage = createSharedWorkerStorage({ workerUrl: "/static/cache.worker.js" });
        expect(storage.mode).toBe("noop");
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("workerUrl /static/cache.worker.js");
        expect(warn.mock.calls[0]?.[0]).toContain("the URL is invalid");
      });
    });
  });

  it("does not warn or fall back when a port is injected", async () => {
    await withConsoleSpies(async ({ warn }) => {
      // In a browser, so the silence can only come from the injected port.
      await withDocument({}, () =>
        withSharedWorker(undefined, async () => {
          const storage = createSharedWorkerStorage({ port: createFakePort() });
          await storage.setItem("k", "v");
          await expect(storage.getItem("k")).resolves.toBe("v");
          expect(warn).not.toHaveBeenCalled();
          storage.dispose();
        }),
      );
    });
  });
});

describe("when the SharedWorker itself fails", () => {
  /** Build a storage over a fresh fake worker and hand back both. */
  async function withFailingWorker(
    fn: (worker: FakeWorker, storage: SharedWorkerStorage) => Promise<void>,
  ) {
    await withConsoleSpies(async () => {
      const worker = fakeSharedWorker({ dead: true });
      await withSharedWorker(worker.FakeSharedWorker, async () => {
        // Far longer than the test could tolerate, so any rejection that arrives
        // proves it came from the fast path rather than the timer.
        const storage = createSharedWorkerStorage({ timeoutMs: 60_000 });
        await fn(worker.latest, storage);
        storage.dispose();
      });
    });
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
    await withConsoleSpies(async ({ warn, error }) => {
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
    });
  });

  it("says nothing when the worker fails after the storage was disposed", async () => {
    const { reported, onError } = recorder();
    await withConsoleSpies(async ({ warn, error }) => {
      const worker = fakeSharedWorker({ dead: true });
      await withSharedWorker(worker.FakeSharedWorker, async () => {
        const storage = createSharedWorkerStorage({ timeoutMs: 60_000, onError });
        const instance = worker.latest;

        storage.dispose();

        // Nothing of ours is left on the worker, so the failure the browser is
        // about to report has no handler to reach and the storage it would
        // have referenced is free.
        expect(instance.onerror).toBeNull();
        instance.fail("404");
        expect(reported).toEqual([]);
        // The storage still fails for the reason the caller gave it, rather
        // than for the worker that died after they let go of it.
        const failure = await rejectionFrom(() => storage.setItem("k", "v"));
        expect(failure.code).toBe("disposed");
        await expect(storage.getItem("k")).resolves.toBeNull();
      });
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
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
    const { reported, onError } = recorder();
    const storage = createSharedWorkerStorage({
      port: createRefusingPort(cloneError()),
      onError,
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

describe("when the worker connection closes", () => {
  /**
   * A port that never answers and can report, as a real `MessagePort` does, that
   * the port it was entangled with has gone: the worker terminated, crashed or
   * closed itself. Nothing else settles a request through it, so a rejection
   * that arrives can only have come from the close.
   */
  function createClosingPort() {
    const postMessage = vi.fn<(request: StorageRequest) => void>();
    const close = vi.fn<() => void>();
    const port: PortAdapter = { onmessage: null, onclose: null, postMessage, close };
    return { port, postMessage, close, closeFromWorker: () => port.onclose?.(new Event("close")) };
  }

  /** Build a storage over a fresh closing port and hand back both. */
  async function withClosingPort(
    fn: (
      connection: ReturnType<typeof createClosingPort>,
      storage: SharedWorkerStorage,
      onError: (error: SharedWorkerStorageError) => void,
    ) => Promise<void>,
  ) {
    const { reported, onError } = recorder();
    const connection = createClosingPort();
    // Far longer than the test could tolerate, so any rejection that arrives
    // proves it came from the close rather than the timer.
    const storage = createSharedWorkerStorage({
      port: connection.port,
      timeoutMs: 60_000,
      onError,
    });
    await fn(connection, storage, onError);
    storage.dispose();
    return reported;
  }

  it("rejects the in-flight writes with the transport error", async () => {
    await withClosingPort(async ({ closeFromWorker }, storage) => {
      const inflight = storage.setItem("k", "v");
      closeFromWorker();
      const error = await rejectionFrom(() => inflight);
      expect(error.code).toBe("transport");
      expect(error.message).toMatch(/SharedWorker connection was closed/);
    });
  });

  it("settles later requests immediately instead of waiting out the timeout", async () => {
    await withClosingPort(async ({ closeFromWorker }, storage) => {
      closeFromWorker();
      await expect(storage.setItem("k", "v")).rejects.toThrow(/connection was closed/);
      await expect(storage.removeItem("k")).rejects.toThrow(/connection was closed/);
      // Reads answer just as promptly, but as an empty cache rather than an error.
      await expect(storage.getItem("k")).resolves.toBeNull();
      await expect(storage.entries()).resolves.toEqual([]);
    });
  });

  it("stops posting to the closed port and closes this end of it", async () => {
    await withClosingPort(async ({ port, postMessage, close, closeFromWorker }, storage) => {
      closeFromWorker();
      expect(close).toHaveBeenCalledTimes(1);
      expect(port.onmessage).toBeNull();
      // Nothing of ours is left on the port, so a second close event — or one
      // fired while the browser tears the port down — has nothing to reach.
      expect(port.onclose).toBeNull();
      postMessage.mockClear();
      await expect(storage.setItem("k", "v")).rejects.toThrow(/connection was closed/);
      expect(postMessage).not.toHaveBeenCalled();
    });
  });

  it("reports the close once however many requests follow", async () => {
    const reported = await withClosingPort(async ({ closeFromWorker }, storage) => {
      closeFromWorker();
      await expect(
        Promise.allSettled([storage.getItem("a"), storage.setItem("b", "1"), storage.entries()]),
      ).resolves.toHaveLength(3);
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("transport");
  });

  it("says nothing when the port closes after the storage was disposed", async () => {
    const { reported, onError } = recorder();
    const { port, closeFromWorker } = createClosingPort();
    const storage = createSharedWorkerStorage({ port, timeoutMs: 60_000, onError });

    storage.dispose();
    closeFromWorker();

    expect(reported).toEqual([]);
    // The storage still fails for the reason the caller gave it, rather than
    // for a port that closed after they let go of it.
    const failure = await rejectionFrom(() => storage.setItem("k", "v"));
    expect(failure.code).toBe("disposed");
    await expect(storage.getItem("k")).resolves.toBeNull();
  });

  it("leaves a port with no close hook working as it always did", async () => {
    // Every other fake in these suites omits the hook, so this is what a
    // browser without the event gets too: the transport stays live and only a
    // timeout, a failure or disposal can settle a request.
    const port = createFakePort();
    expect(port).not.toHaveProperty("onclose");
    const storage = createSharedWorkerStorage({ port });
    await storage.setItem("k", "v");
    await expect(storage.getItem("k")).resolves.toBe("v");
    storage.dispose();
  });
});
