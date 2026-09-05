import { describe, expect, it, vi } from "vite-plus/test";
import { createSharedWorkerStorage, type PortAdapter } from "./shared-worker-storage";
import {
  createDeadPort,
  createErrorPort,
  createFakePort,
  createRecordingPort,
  fakeSharedWorker,
  recorder,
  rejectionFrom,
  withConsoleSpies,
  withDocument,
  withSharedWorker,
} from "./test-utils";
import { respond } from "./worker/connection";
import { PROTOCOL_VERSION, type StorageRequest, type StorageResponse } from "./worker/protocol";
import { CacheStore } from "./worker/store";

/**
 * The client half's own behaviour over a port: round trips, correlating
 * responses to the requests that asked for them, disposal, and the version
 * every message is stamped with.
 *
 * The rest of the client's tests are in the sibling
 * `shared-worker-storage.*.test.ts` files, one concern to a file.
 */

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

  it("clears the timer of a request the worker answered, leaving nothing scheduled", async () => {
    vi.useFakeTimers();
    try {
      // Far longer than the test runs, so a timer that outlived its request
      // would still be scheduled at the end of it. A request settles on the
      // worker's reply, which arrives on a microtask and so is unaffected by
      // the clock being faked.
      const storage = createSharedWorkerStorage({ port: createFakePort(), timeoutMs: 60_000 });
      await storage.setItem("k", "v");
      await expect(storage.getItem("k")).resolves.toBe("v");
      // Hundreds of requests over a page's life would otherwise each leave a
      // timer to fire long after the request it was meant to bound.
      expect(vi.getTimerCount()).toBe(0);
      storage.dispose();
    } finally {
      vi.useRealTimers();
    }
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

  it("logs a message error and leaves the requests in flight to their own fate", async () => {
    await withConsoleSpies(async ({ error }) => {
      const deadPort = createDeadPort();
      const storage = createSharedWorkerStorage({ port: deadPort, timeoutMs: 20 });
      const inflight = storage.setItem("k", "v");
      deadPort.onmessageerror?.({} as MessageEvent);
      // The event names no request, so this one is not settled by it: it fails
      // on its own deadline, and says so rather than blaming the bad message.
      await expect(inflight).rejects.toThrow(/timed out/);
      expect(error).toHaveBeenCalledTimes(1);
      storage.dispose();
    });
  });

  it("keeps the port usable after a single undeserializable message", async () => {
    await withConsoleSpies(async ({ error }) => {
      const port = createFakePort();
      const storage = createSharedWorkerStorage({ port });
      port.onmessageerror?.({} as MessageEvent);
      // The worker is still there, so the next round trip must go through.
      await storage.setItem("k", "v");
      await expect(storage.getItem("k")).resolves.toBe("v");
      expect(error).toHaveBeenCalledTimes(1);
      storage.dispose();
    });
  });

  it.each([
    ["a message that is not a response", { kind: "broadcast", id: 1, payload: "hi" }],
    ["a response with no ok flag", { kind: "response", id: 1, result: "v" }],
    ["an ok response with no result", { kind: "response", id: 1, ok: true }],
    ["an error response with no message", { kind: "response", id: 1, ok: false }],
    [
      "a response whose version is not a number",
      { kind: "response", id: 1, version: "1", ok: true, result: "v" },
    ],
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
    const { reported, onError } = recorder();
    const port = createFakePort();
    const storage = createSharedWorkerStorage({ port, signal: AbortSignal.abort(), onError });

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
    const { reported, onError } = recorder();
    const worker = fakeSharedWorker();
    await withSharedWorker(worker.FakeSharedWorker, async () => {
      const storage = createSharedWorkerStorage({ signal: AbortSignal.abort(), onError });
      // No worker process is spawned, and no connection opened, for a storage
      // that is over before it begins.
      expect(worker.constructions).toEqual([]);
      expect(reported).toEqual([]);
      expect((await rejectionFrom(() => storage.setItem("k", "v"))).code).toBe("disposed");
    });
  });

  it("says nothing about an environment it was aborted out of", async () => {
    const { reported, onError } = recorder();
    // In a browser, so the silence can only come from the abort.
    await withDocument({}, () =>
      withSharedWorker(undefined, () => {
        const storage = createSharedWorkerStorage({ signal: AbortSignal.abort(), onError });
        // The no-op fallback is still all there was to give, and `mode` still says
        // so; there is just nobody left to warn about it.
        expect(storage.mode).toBe("noop");
        expect(reported).toEqual([]);
      }),
    );
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

describe("the protocol version", () => {
  /**
   * A port answering as a worker on some other build would: the reply is the
   * real one this package produces, restamped with `version` — or with the
   * field removed entirely, which is what a worker predating it sends.
   */
  function createPortSpeaking(version: number | undefined): PortAdapter {
    const store = new CacheStore();
    const port: PortAdapter = {
      onmessage: null,
      postMessage(request: StorageRequest) {
        const response: Record<string, unknown> = { ...respond(store, request) };
        if (version === undefined) delete response.version;
        else response.version = version;
        queueMicrotask(() => {
          port.onmessage?.({ data: response } as MessageEvent<unknown>);
        });
      },
    };
    return port;
  }

  it("travels out on every request", async () => {
    const { port, sent } = createRecordingPort();
    const storage = createSharedWorkerStorage({ port });
    await storage.setItem("k", "v");
    await storage.getItem("k");
    await storage.entries();
    await storage.removeItem("k");
    storage.dispose();
    expect(sent).toHaveLength(4);
    for (const request of sent) expect(request.version).toBe(PROTOCOL_VERSION);
  });

  it("comes back on every response the worker sends", async () => {
    const sent: StorageResponse[] = [];
    const port: PortAdapter = {
      onmessage: null,
      postMessage(request: StorageRequest) {
        const response = respond(new CacheStore(), request);
        sent.push(response);
        queueMicrotask(() => port.onmessage?.({ data: response } as MessageEvent<unknown>));
      },
    };
    const storage = createSharedWorkerStorage({ port });
    await storage.getItem("k");
    storage.dispose();
    expect(sent).toEqual([
      { kind: "response", version: PROTOCOL_VERSION, id: 1, ok: true, result: null },
    ]);
  });

  it("is assumed to be 1 when a response carries none, so an older worker still answers", async () => {
    const storage = createSharedWorkerStorage({ port: createPortSpeaking(undefined) });
    await expect(storage.setItem("k", "v")).resolves.toBeUndefined();
    await expect(storage.getItem("k")).resolves.toBe("v");
    await expect(storage.entries()).resolves.toEqual([["k", "v"]]);
    storage.dispose();
  });

  it("fails a write answered in another version, naming both", async () => {
    const storage = createSharedWorkerStorage({ port: createPortSpeaking(PROTOCOL_VERSION + 1) });
    const failure = await rejectionFrom(() => storage.setItem("k", "v"));
    expect(failure.code).toBe("protocol");
    expect(failure.message).toContain(`version ${PROTOCOL_VERSION + 1}`);
    expect(failure.message).toContain(`this build speaks ${PROTOCOL_VERSION}`);
    storage.dispose();
  });

  it("resolves a read answered in another version empty, and reports why", async () => {
    const { reported, onError } = recorder();
    const storage = createSharedWorkerStorage({
      port: createPortSpeaking(PROTOCOL_VERSION + 1),
      onError,
    });
    await expect(storage.getItem("k")).resolves.toBeNull();
    storage.dispose();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("protocol");
    expect(reported[0]?.message).toContain(`version ${PROTOCOL_VERSION + 1}`);
  });
});
