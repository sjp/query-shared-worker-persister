import { QueryClient } from "@tanstack/query-core";
import { describe, expect, it } from "vite-plus/test";
import { experimental_createSharedWorkerQueryPersister } from "./create-shared-worker-query-persister";
import {
  createFakePort,
  createRecordingPort,
  fakeSharedWorker,
  withSharedWorker,
} from "./test-utils";
import { CacheStore } from "./worker/store";

/**
 * The one-call wrapper around TanStack's per-query persister: what it derives
 * from `prefix`, and that the storage it built stays reachable through it.
 */

/** The prefixes the `entries` requests on a port carried, in order. */
function entriesPrefixes(sent: Array<{ op: string; prefix?: string | undefined }>) {
  return sent.filter((request) => request.op === "entries").map((request) => request.prefix);
}

describe("experimental_createSharedWorkerQueryPersister", () => {
  it("persists a query in one tab and restores it in another", async () => {
    // Two storages over one CacheStore stand in for two tabs sharing a worker.
    const store = new CacheStore();
    const writer = experimental_createSharedWorkerQueryPersister({
      port: createFakePort(store),
      prefix: "MY_APP",
    });

    const source = new QueryClient();
    source.setQueryData(["user", 1], { name: "Ada" });
    const query = source.getQueryCache().find({ queryKey: ["user", 1] });
    if (!query) throw new Error("the query was not created");
    await writer.persistQuery(query);

    const reader = experimental_createSharedWorkerQueryPersister({
      port: createFakePort(store),
      prefix: "MY_APP",
    });
    const target = new QueryClient();
    await reader.restoreQueries(target);
    expect(target.getQueryData(["user", 1])).toEqual({ name: "Ada" });

    writer.dispose();
    reader.dispose();
  });

  it("narrows the worker's listing to the persister's own keys", async () => {
    const store = new CacheStore();
    store.setItem("OTHER-y", "someone else's");
    const { port, sent } = createRecordingPort(store);
    const persister = experimental_createSharedWorkerQueryPersister({ port, prefix: "MY_APP" });

    const source = new QueryClient();
    source.setQueryData(["user", 1], { name: "Ada" });
    for (const query of source.getQueryCache().getAll()) await persister.persistQuery(query);
    await persister.restoreQueries(new QueryClient());

    // The `-` TanStack joins `prefix` to a query hash with is part of the
    // filter, and the caller never had to know that.
    expect(entriesPrefixes(sent)).toEqual(["MY_APP-"]);
    await expect(persister.storage.entries()).resolves.toEqual([
      [expect.stringMatching(/^MY_APP-/) as unknown as string, expect.any(String)],
    ]);

    persister.dispose();
  });

  it("derives the filter from TanStack's default prefix when none is given", async () => {
    const store = new CacheStore();
    store.setItem("tanstack-query-x", "ours");
    store.setItem("OTHER-y", "someone else's");
    const { port, sent } = createRecordingPort(store);
    const persister = experimental_createSharedWorkerQueryPersister({ port });

    await expect(persister.storage.entries()).resolves.toEqual([["tanstack-query-x", "ours"]]);
    expect(entriesPrefixes(sent)).toEqual(["tanstack-query-"]);

    persister.dispose();
  });

  it("keeps one app's per-query entries out of another's restore", async () => {
    const store = new CacheStore();
    const ours = experimental_createSharedWorkerQueryPersister({
      port: createFakePort(store),
      prefix: "MY_APP",
    });
    const theirs = experimental_createSharedWorkerQueryPersister({
      port: createFakePort(store),
      prefix: "OTHER_APP",
    });

    const source = new QueryClient();
    source.setQueryData(["user", 1], { name: "Ada" });
    for (const query of source.getQueryCache().getAll()) await theirs.persistQuery(query);

    const target = new QueryClient();
    await ours.restoreQueries(target);
    expect(target.getQueryData(["user", 1])).toBeUndefined();

    ours.dispose();
    theirs.dispose();
  });

  it("disposes the storage it created", async () => {
    const worker = fakeSharedWorker();
    await withSharedWorker(worker.FakeSharedWorker, async () => {
      const persister = experimental_createSharedWorkerQueryPersister();
      expect(persister.mode).toBe("shared-worker");

      persister.dispose();
      expect(worker.latest.close).toHaveBeenCalledTimes(1);
      await expect(persister.storage.setItem("k", "v")).rejects.toThrow(/disposed/);
      // Idempotent, like the storage's own disposal.
      expect(() => persister.dispose()).not.toThrow();
      expect(worker.latest.close).toHaveBeenCalledTimes(1);
    });
  });

  it("disposes the storage at the end of a `using` block", async () => {
    const worker = fakeSharedWorker();
    await withSharedWorker(worker.FakeSharedWorker, () => {
      {
        using persister = experimental_createSharedWorkerQueryPersister();
        expect(persister.mode).toBe("shared-worker");
      }
      expect(worker.latest.close).toHaveBeenCalledTimes(1);
    });
  });

  it("reports mode `noop`, and persists nothing, where there is no SharedWorker", async () => {
    await withSharedWorker(undefined, async () => {
      const persister = experimental_createSharedWorkerQueryPersister({ onError: () => {} });
      expect(persister.mode).toBe("noop");

      const source = new QueryClient();
      source.setQueryData(["user", 1], { name: "Ada" });
      for (const query of source.getQueryCache().getAll()) await persister.persistQuery(query);

      const target = new QueryClient();
      await persister.restoreQueries(target);
      expect(target.getQueryData(["user", 1])).toBeUndefined();
    });
  });
});
