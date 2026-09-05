import { QueryClient } from "@tanstack/query-core";
import {
  type PersistedClient,
  persistQueryClientRestore,
} from "@tanstack/query-persist-client-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSharedWorkerPersister,
  type CreateSharedWorkerPersisterOptions,
} from "./create-shared-worker-persister";
import { fakeSharedWorker, withSharedWorker } from "./test-utils";

/** A minimal client to persist; the persister only ever serializes it. */
function persistedClient(): PersistedClient {
  return { timestamp: 0, buster: "", clientState: { mutations: [], queries: [] } };
}

describe("createSharedWorkerPersister", () => {
  it("round-trips a client through the SharedWorker", async () => {
    const { FakeSharedWorker } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, async () => {
      const persister = createSharedWorkerPersister();
      const client = persistedClient();
      await persister.persistClient(client);
      await expect(persister.restoreClient()).resolves.toEqual(client);
    });
  });

  it("restores nothing when the worker holds no entry", async () => {
    const { FakeSharedWorker } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, async () => {
      await expect(createSharedWorkerPersister().restoreClient()).resolves.toBeUndefined();
    });
  });

  it("forwards timeoutMs to the storage", async () => {
    const { FakeSharedWorker } = fakeSharedWorker({ dead: true });
    await withSharedWorker(FakeSharedWorker, async () => {
      const persister = createSharedWorkerPersister({ timeoutMs: 20 });
      // The default is three orders of magnitude longer, so a rejection naming
      // 20ms can only have come from the option being passed through.
      await expect(persister.removeClient()).rejects.toThrow(/timed out after 20ms/);
    });
  });

  it("forwards namespace as a dedicated worker name", async () => {
    const { FakeSharedWorker, constructions } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, () => {
      createSharedWorkerPersister();
      createSharedWorkerPersister({ namespace: "MY_APP" });
    });
    const [shared, namespaced] = constructions;
    expect(shared?.options?.name).toBeTruthy();
    expect(namespaced?.options?.name).toBe(`${shared?.options?.name}:MY_APP`);
  });

  it("forwards workerUrl as the worker's script URL", async () => {
    const { FakeSharedWorker, constructions } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, () => {
      createSharedWorkerPersister({ workerUrl: "/static/cache.worker.js" });
    });
    expect(constructions.map((construction) => construction.url)).toEqual([
      "/static/cache.worker.js",
    ]);
  });

  it("forwards signal so aborting tears the storage down", async () => {
    const { FakeSharedWorker } = fakeSharedWorker({ dead: true });
    await withSharedWorker(FakeSharedWorker, async () => {
      const controller = new AbortController();
      const persister = createSharedWorkerPersister({ signal: controller.signal });
      const removing = persister.removeClient();
      controller.abort();
      await expect(removing).rejects.toThrow(/disposed/);
    });
  });

  it("removes the persisted client from the shared store", async () => {
    const { FakeSharedWorker, store } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, async () => {
      const persister = createSharedWorkerPersister({ key: "MY_APP" });
      await persister.persistClient(persistedClient());
      expect(store.getItem("MY_APP")).not.toBeNull();
      await persister.removeClient();
      expect(store.getItem("MY_APP")).toBeNull();
      await expect(persister.restoreClient()).resolves.toBeUndefined();
    });
  });

  it("restores nothing, instead of clearing the shared entry, when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const worker = fakeSharedWorker({ dead: true });
      await withSharedWorker(worker.FakeSharedWorker, async () => {
        const persister = createSharedWorkerPersister({ timeoutMs: 20, key: "MY_APP" });
        await persistQueryClientRestore({ queryClient: new QueryClient(), persister });
        // A restore that throws is answered with `removeClient()`, which would
        // empty the entry every other tab is reading. The read is all the
        // worker may hear about a tab that simply couldn't reach it.
        expect(worker.latest.postMessage.mock.calls.map(([request]) => request.op)).toEqual([
          "getItem",
        ]);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("still clears the shared entry when the restored cache is busted", async () => {
    const { FakeSharedWorker, store } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, async () => {
      const persister = createSharedWorkerPersister({ key: "MY_APP" });
      await persister.persistClient({ ...persistedClient(), timestamp: Date.now(), buster: "v1" });
      expect(store.getItem("MY_APP")).not.toBeNull();
      // A buster mismatch is a real invalidation rather than a failed read, so
      // it must go on removing the entry for everyone.
      await persistQueryClientRestore({
        queryClient: new QueryClient(),
        persister,
        buster: "v2",
      });
      expect(store.getItem("MY_APP")).toBeNull();
    });
  });

  it("passes key through, so the entry is namespaced within the shared store", async () => {
    const { FakeSharedWorker, store } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, async () => {
      await createSharedWorkerPersister({ key: "MY_APP" }).persistClient(persistedClient());
      expect(store.getItem("MY_APP")).not.toBeNull();
    });
  });

  it("passes serialize and deserialize through", async () => {
    const { FakeSharedWorker, store } = fakeSharedWorker();
    const restored = persistedClient();
    await withSharedWorker(FakeSharedWorker, async () => {
      const persister = createSharedWorkerPersister({
        key: "MY_APP",
        serialize: () => "serialized-by-the-caller",
        deserialize: () => restored,
      });
      await persister.persistClient(persistedClient());
      expect(store.getItem("MY_APP")).toBe("serialized-by-the-caller");
      await expect(persister.restoreClient()).resolves.toBe(restored);
    });
  });

  it("passes retry through, so a failed write reaches the caller's recovery hook", async () => {
    const { FakeSharedWorker } = fakeSharedWorker({ dead: true });
    await withSharedWorker(FakeSharedWorker, async () => {
      const errors: unknown[] = [];
      const persister = createSharedWorkerPersister({
        timeoutMs: 20,
        // Giving up (returning nothing) ends the retry loop after one attempt.
        retry: ({ error }) => {
          errors.push(error);
          return undefined;
        },
      });
      await persister.persistClient(persistedClient());
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(String(errors[0])).toMatch(/timed out/);
    });
  });
});

/**
 * Writes are throttled, so a burst of query-cache changes costs one round trip
 * to the worker rather than one per change. Timers are faked here because the
 * behaviour under test is entirely about when the second write is allowed
 * through; the port itself still answers on real microtasks.
 */
describe("throttling repeated writes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Persist twice under one key, and report what the store held in between. */
  async function persistTwice(options: CreateSharedWorkerPersisterOptions, waitMs: number) {
    const { FakeSharedWorker, store } = fakeSharedWorker();
    return await withSharedWorker(FakeSharedWorker, async () => {
      const persister = createSharedWorkerPersister({
        ...options,
        key: "K",
        serialize: (client) => client.buster,
      });
      await persister.persistClient({ ...persistedClient(), buster: "first" });
      const second = persister.persistClient({ ...persistedClient(), buster: "second" });
      await vi.advanceTimersByTimeAsync(waitMs);
      const afterWaiting = store.getItem("K");
      // Let the throttled write land however long it was held back, so no
      // pending timer outlives the test.
      await vi.advanceTimersByTimeAsync(60_000);
      await second;
      return { afterWaiting, afterSettling: store.getItem("K") };
    });
  }

  it("holds a second write back for a second by default", async () => {
    const { afterWaiting, afterSettling } = await persistTwice({}, 999);
    expect(afterWaiting).toBe("first");
    expect(afterSettling).toBe("second");
  });

  it("uses the caller's throttleTime instead when one is given", async () => {
    const { afterWaiting } = await persistTwice({ throttleTime: 50 }, 999);
    expect(afterWaiting).toBe("second");
  });
});
