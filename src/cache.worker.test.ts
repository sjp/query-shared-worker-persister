import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkerPort } from "./worker/connection";
import type { StorageRequest, StorageResponse } from "./worker/protocol";

/**
 * The worker entry installs its `onconnect` handler on the global scope as a
 * side effect of being imported, so each test needs a fresh module instance over
 * a fresh fake scope. `self` is absent outside a browser, which is why it has to
 * be stubbed before the import rather than after.
 */
async function loadWorker() {
  const scope: { onconnect: ((event: MessageEvent) => void) | null } = { onconnect: null };
  vi.resetModules();
  vi.stubGlobal("self", scope);
  try {
    await import("./cache.worker");
  } finally {
    vi.unstubAllGlobals();
  }
  const { onconnect } = scope;
  if (!onconnect) throw new Error("the worker installed no onconnect handler");

  /** Connect a tab, as the browser does when a page opens the shared worker. */
  return function connect() {
    const responses: StorageResponse[] = [];
    const port: WorkerPort = { onmessage: null, postMessage: (message) => responses.push(message) };
    // A real connect event carries the tab's end of the channel in `ports`.
    onconnect({ ports: [port] } as unknown as MessageEvent);
    return {
      responses,
      /** Post a request the way a connected tab would, and read the reply. */
      send(request: StorageRequest) {
        port.onmessage?.({ data: request } as MessageEvent<StorageRequest>);
        return responses[responses.length - 1];
      },
    };
  };
}

describe("the SharedWorker entry", () => {
  it("answers requests on a newly connected port", async () => {
    const connect = await loadWorker();
    const tab = connect();
    expect(tab.send({ kind: "request", id: 1, op: "setItem", key: "k", value: "v" })).toEqual({
      kind: "response",
      id: 1,
      ok: true,
      result: null,
    });
    expect(tab.send({ kind: "request", id: 2, op: "getItem", key: "k" })).toEqual({
      kind: "response",
      id: 2,
      ok: true,
      result: "v",
    });
  });

  it("gives every connected tab the same store", async () => {
    const connect = await loadWorker();
    const writer = connect();
    const reader = connect();
    writer.send({ kind: "request", id: 1, op: "setItem", key: "k", value: "v" });
    expect(reader.send({ kind: "request", id: 1, op: "entries" })).toEqual({
      kind: "response",
      id: 1,
      ok: true,
      result: [["k", "v"]],
    });
  });

  it("does not answer a malformed message that carries no id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tab = (await loadWorker())();
      tab.send({ kind: "hello" } as unknown as StorageRequest);
      expect(tab.responses).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
