import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { describe, expect, it } from "vite-plus/test";
import { createSharedWorkerPersister } from "./create-shared-worker-persister";
import type { PortAdapter } from "./shared-worker-storage";
import { createFakePort, withSharedWorker } from "./test-utils";
import { CacheStore } from "./worker/store";

/** A minimal client to persist; the persister only ever serializes it. */
function persistedClient(): PersistedClient {
  return { timestamp: 0, buster: "", clientState: { mutations: [], queries: [] } };
}

/**
 * A `SharedWorker` stand-in whose port answers from `store` — or, when `dead`,
 * never replies at all, so nothing but the storage's own timeout (or disposal)
 * can settle a request. `names` and `urls` collect the worker identity each
 * construction asked for, which is how `namespace` and `workerUrl` forwarding is
 * observed.
 */
function fakeSharedWorker({ store = new CacheStore(), dead = false } = {}) {
  const names: (string | undefined)[] = [];
  const urls: (string | URL)[] = [];
  class FakeSharedWorker {
    port: PortAdapter = dead ? { onmessage: null, postMessage() {} } : createFakePort(store);
    onerror: ((event: { message: string }) => void) | null = null;

    constructor(url: string | URL, options?: { name?: string }) {
      names.push(options?.name);
      urls.push(url);
    }
  }
  return { FakeSharedWorker, names, urls, store };
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
      await expect(persister.restoreClient()).rejects.toThrow(/timed out after 20ms/);
    });
  });

  it("forwards namespace as a dedicated worker name", async () => {
    const { FakeSharedWorker, names } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, () => {
      createSharedWorkerPersister();
      createSharedWorkerPersister({ namespace: "MY_APP" });
    });
    const [sharedName, namespacedName] = names;
    expect(sharedName).toBeTruthy();
    expect(namespacedName).toBe(`${sharedName}:MY_APP`);
  });

  it("forwards workerUrl as the worker's script URL", async () => {
    const { FakeSharedWorker, urls } = fakeSharedWorker();
    await withSharedWorker(FakeSharedWorker, () => {
      createSharedWorkerPersister({ workerUrl: "/static/cache.worker.js" });
    });
    expect(urls).toEqual(["/static/cache.worker.js"]);
  });

  it("forwards signal so aborting tears the storage down", async () => {
    const { FakeSharedWorker } = fakeSharedWorker({ dead: true });
    await withSharedWorker(FakeSharedWorker, async () => {
      const controller = new AbortController();
      const persister = createSharedWorkerPersister({ signal: controller.signal });
      const restoring = persister.restoreClient();
      controller.abort();
      await expect(restoring).rejects.toThrow(/disposed/);
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
