import { describe, expect, it } from "vite-plus/test";
import {
  createSharedWorkerStorage,
  type PortAdapter,
  type SharedWorkerStorage,
  SharedWorkerStorageError,
} from "./shared-worker-storage";
import {
  createDeadPort,
  createErrorPort,
  createFakePort,
  fakeSharedWorker,
  recorder,
  rejectionFrom,
  withConsoleSpies,
  withDocument,
  withSharedWorker,
} from "./test-utils";
import type { StorageRequest, StorageResponse, StorageResult } from "./worker/protocol";

/**
 * How a failure reaches the caller: an empty read rather than a rejection, an
 * `onError` report rather than a line on the console, and what is left of either
 * when the handler itself is broken.
 */

/**
 * `persistQueryClient` reads a rejected restore as a corrupt cache and answers
 * it by calling `removeClient()` - which, on a store the worker shares, deletes
 * the entry every other tab is using. A tab that was merely slow would take the
 * whole cache down with it, so reads resolve empty instead of rejecting.
 */
describe("a read the worker cannot answer", () => {
  /** What both reads produced, and how many warnings they logged. */
  async function readFrom(storage: SharedWorkerStorage) {
    return await withConsoleSpies(async ({ warn }) => ({
      item: await storage.getItem("k"),
      entries: await storage.entries(),
      warnings: warn.mock.calls.length,
    }));
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

  it("resolves empty once the storage is disposed, saying so once", async () => {
    // Far longer a timeout than the test could tolerate, so resolving at all
    // proves the answer came from the fast path rather than the timer.
    const storage = createSharedWorkerStorage({ port: createFakePort(), timeoutMs: 60_000 });
    storage.dispose();
    // Two reads, one warning: the caller asked for the disposal, so hearing
    // that a released storage is still being read from is worth saying once
    // and no more - a persister reads on every query mount.
    await expect(readFrom(storage)).resolves.toEqual({ item: null, entries: [], warnings: 1 });
    await expect(readFrom(storage)).resolves.toEqual({ item: null, entries: [], warnings: 0 });
  });

  it("leaves writes rejecting, so a failed save still reaches the caller", async () => {
    const storage = createSharedWorkerStorage({ port: createDeadPort(), timeoutMs: 20 });
    await expect(storage.setItem("k", "v")).rejects.toThrow(/timed out/);
    await expect(storage.removeItem("k")).rejects.toThrow(/timed out/);
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
  it("reports the unsupported fallback to onError instead of the console", async () => {
    const { reported, onError } = recorder();
    await withConsoleSpies(async (spies) => {
      await withDocument({}, () =>
        withSharedWorker(undefined, () => {
          const storage = createSharedWorkerStorage({ onError });
          expect(storage.mode).toBe("noop");
        }),
      );
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
    await withConsoleSpies(async (spies) => {
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
    await withConsoleSpies(async (spies) => {
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
    await withConsoleSpies(async (spies) => {
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

  it("costs only the request whose answer was lost, and reports the loss once", async () => {
    const { reported, onError } = recorder();
    const requests: StorageRequest[] = [];
    // Answered by hand, so a response can be withheld from exactly one request
    // the way a message that failed to deserialize withholds it.
    const port: PortAdapter = {
      onmessage: null,
      onmessageerror: null,
      postMessage(request) {
        requests.push(request);
      },
    };
    const answer = (request: StorageRequest, result: StorageResult) => {
      port.onmessage?.({
        data: { kind: "response", id: request.id, ok: true, result },
      } as MessageEvent<StorageResponse>);
    };

    await withConsoleSpies(async (spies) => {
      const storage = createSharedWorkerStorage({ port, timeoutMs: 20, onError });
      const lost = storage.getItem("lost");
      const read = storage.getItem("k");
      const write = storage.setItem("k", "v");
      expect(requests).toHaveLength(3);

      // The event carries no id, so the two requests whose responses are still
      // on their way have to settle on them as though nothing had happened.
      port.onmessageerror?.({} as MessageEvent);
      answer(requests[1] as StorageRequest, "v");
      answer(requests[2] as StorageRequest, null);
      await expect(read).resolves.toBe("v");
      await expect(write).resolves.toBeUndefined();

      // Only the request that lost its answer pays, and it pays at its own
      // deadline: a read, so it resolves empty.
      await expect(lost).resolves.toBeNull();
      expect(spies.error).not.toHaveBeenCalled();
      expect(spies.warn).not.toHaveBeenCalled();
      storage.dispose();
    });

    // The bad message, then the read that gave up on it. Neither is reported
    // twice, and the two requests that settled normally are reported not at all.
    expect(reported.map((error) => error.code)).toEqual(["transport", "timeout"]);
    expect(reported[0]?.message).toContain("deserialized");
    expect(reported[1]?.message).toContain("continuing as though it were empty");
  });

  it("reports a read that resolved empty, under the code of what stopped it", async () => {
    const { reported, onError } = recorder();
    await withConsoleSpies(async (spies) => {
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

  it("reports reads made after disposal once per storage", async () => {
    const { reported, onError } = recorder();
    await withConsoleSpies(async (spies) => {
      const storage = createSharedWorkerStorage({ port: createFakePort(), onError });
      storage.dispose();
      await expect(storage.getItem("k")).resolves.toBeNull();
      await expect(storage.entries()).resolves.toEqual([]);
      expect(spies.warn).not.toHaveBeenCalled();

      // A second storage has its own say: what has been reported already is
      // remembered per storage, not for the module.
      const other = createSharedWorkerStorage({ port: createFakePort(), onError });
      other.dispose();
      await expect(other.getItem("k")).resolves.toBeNull();
    });
    expect(reported.map((error) => error.code)).toEqual(["disposed", "disposed"]);
    expect(reported[0]?.message).toContain("continuing as though it were empty");
    expect((reported[0]?.cause as SharedWorkerStorageError | undefined)?.code).toBe("disposed");
  });

  it("keeps a worker-side error as the cause of the read that gave up on it", async () => {
    const { reported, onError } = recorder();
    await withConsoleSpies(async (spies) => {
      const storage = createSharedWorkerStorage({ port: createErrorPort(), onError });
      await expect(storage.getItem("k")).resolves.toBeNull();
      expect(spies.warn).not.toHaveBeenCalled();
      storage.dispose();
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("protocol");
    expect(reported[0]?.message).toContain("continuing as though it were empty");
    // The worker's own error is kept whole, so a caller can look past the
    // description of the empty read to what the worker actually said.
    const cause = reported[0]?.cause as SharedWorkerStorageError | undefined;
    expect(cause?.code).toBe("protocol");
    expect(cause?.message).toBe("boom");
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

  it("names its errors, so a console or a reporter shows what kind of failure it is", async () => {
    const storage = createSharedWorkerStorage({ port: createErrorPort() });
    const error = await rejectionFrom(() => storage.setItem("k", "v"));
    expect(error.name).toBe("SharedWorkerStorageError");
    // The name is what prefixes the message wherever an error is stringified.
    expect(String(error)).toBe("SharedWorkerStorageError: boom");
    storage.dispose();
  });

  it("reports mode so a caller can tell a live storage from a no-op one", async () => {
    expect(createSharedWorkerStorage({ port: createFakePort() }).mode).toBe("shared-worker");
    await withSharedWorker(undefined, () => {
      expect(createSharedWorkerStorage().mode).toBe("noop");
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

  it("still resolves a failed read empty, and puts the throw on the console", async () => {
    await withConsoleSpies(async ({ error }) => {
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
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
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
    await withConsoleSpies(async ({ error }) => {
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
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("onError handler threw"),
        thrown,
        failure,
      );
    });
  });

  it("does not escape construction of an unsupported storage", async () => {
    await withConsoleSpies(async ({ error }) => {
      await withDocument({}, () =>
        withSharedWorker(undefined, () => {
          expect(createSharedWorkerStorage({ onError: throwingOnError }).mode).toBe("noop");
        }),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("onError handler threw"),
        thrown,
        expect.any(SharedWorkerStorageError),
      );
    });
  });
});
