import { experimental_createQueryPersister } from "@tanstack/query-persist-client-core";
import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it } from "vite-plus/test";
import { createSharedWorkerStorage, type PortAdapter } from "./shared-worker-storage";
import { createErrorPort, createFakePort, createRecordingPort } from "./test-utils";
import { PROTOCOL_VERSION, type StorageRequest, type StorageResponse } from "./worker/protocol";
import { CacheStore } from "./worker/store";

/**
 * One key per query, on a store other apps and other query clients are writing
 * to at the same time: what `entriesPrefix` narrows a listing to, and what
 * TanStack's per-query persister makes of the storage on top of it.
 */

describe("the entriesPrefix option", () => {
  /** A store holding one app's entries alongside another's. */
  function sharedStore() {
    const store = new CacheStore();
    store.setItem("APP-a", "1");
    store.setItem("OTHER-b", "2");
    store.setItem("APP-c", "3");
    return store;
  }

  it("asks the worker for only the entries under the prefix", async () => {
    const { port, sent } = createRecordingPort(sharedStore());
    const storage = createSharedWorkerStorage({ port, entriesPrefix: "APP-" });

    await expect(storage.entries()).resolves.toEqual([
      ["APP-a", "1"],
      ["APP-c", "3"],
    ]);
    expect(sent).toEqual([
      { kind: "request", version: PROTOCOL_VERSION, id: 1, op: "entries", prefix: "APP-" },
    ]);

    storage.dispose();
  });

  it("leaves the other operations addressing the whole store", async () => {
    const { port } = createRecordingPort(sharedStore());
    const storage = createSharedWorkerStorage({ port, entriesPrefix: "APP-" });

    await expect(storage.getItem("OTHER-b")).resolves.toBe("2");
    await storage.removeItem("OTHER-b");
    await expect(storage.getItem("OTHER-b")).resolves.toBeNull();

    storage.dispose();
  });

  it("returns the whole store, and asks for it, when the option is absent", async () => {
    const { port, sent } = createRecordingPort(sharedStore());
    const storage = createSharedWorkerStorage({ port });

    await expect(storage.entries()).resolves.toEqual([
      ["APP-a", "1"],
      ["OTHER-b", "2"],
      ["APP-c", "3"],
    ]);
    expect(sent[0]).toMatchObject({ op: "entries", prefix: undefined });

    storage.dispose();
  });

  it("filters the reply itself, so a worker that ignores the prefix still narrows", async () => {
    // The worker runs whichever build the first tab to connect loaded, so it may
    // predate the field and answer with the whole store; a build that predates
    // it names no protocol version either.
    const port: PortAdapter = {
      onmessage: null,
      postMessage(request: StorageRequest) {
        queueMicrotask(() => {
          port.onmessage?.({
            data: {
              kind: "response",
              id: request.id,
              ok: true,
              result: [
                ["APP-a", "1"],
                ["OTHER-b", "2"],
              ],
            },
          } as MessageEvent<StorageResponse>);
        });
      },
    };
    const storage = createSharedWorkerStorage({ port, entriesPrefix: "APP-" });

    await expect(storage.entries()).resolves.toEqual([["APP-a", "1"]]);

    storage.dispose();
  });

  it("resolves empty, not unfiltered, when the read fails", async () => {
    const storage = createSharedWorkerStorage({
      port: createErrorPort(),
      entriesPrefix: "APP-",
      onError: () => {},
    });

    await expect(storage.entries()).resolves.toEqual([]);

    storage.dispose();
  });

  it("keeps a per-query persister off another app's entries on the same worker", async () => {
    const store = new CacheStore();
    const other = createSharedWorkerStorage({ port: createFakePort(store) });
    await other.setItem("OTHER-tanstack-query-x", "not ours");

    const storage = createSharedWorkerStorage({
      port: createFakePort(store),
      entriesPrefix: "MY_APP-",
    });
    const persister = experimental_createQueryPersister({ storage, prefix: "MY_APP" });

    const source = new QueryClient();
    source.setQueryData(["user", 1], { name: "Ada" });
    for (const query of source.getQueryCache().getAll()) await persister.persistQuery(query);

    await expect(storage.entries()).resolves.toEqual([
      [expect.stringMatching(/^MY_APP-/) as unknown as string, expect.any(String)],
    ]);

    const restored = new QueryClient();
    await persister.restoreQueries(restored);
    expect(restored.getQueryData(["user", 1])).toEqual({ name: "Ada" });
    expect(await other.getItem("OTHER-tanstack-query-x")).toBe("not ours");

    storage.dispose();
    other.dispose();
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
