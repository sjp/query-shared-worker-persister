import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkerPort } from "./connection";
import { PROTOCOL_VERSION, type StorageRequest, type StorageResponse } from "./protocol";

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

  /** Fire a connect event, as the browser does, carrying the ports it names. */
  const fire = (ports: WorkerPort[]) => onconnect({ ports } as unknown as MessageEvent);

  /** Connect a tab, as the browser does when a page opens the shared worker. */
  const connect = () => {
    const responses: StorageResponse[] = [];
    const port: WorkerPort = { onmessage: null, postMessage: (message) => responses.push(message) };
    // A real connect event carries the tab's end of the channel in `ports`.
    fire([port]);
    return {
      responses,
      /** Post a request the way a connected tab would, and read the reply. */
      send(request: StorageRequest) {
        port.onmessage?.({ data: request } as MessageEvent<StorageRequest>);
        return responses[responses.length - 1];
      },
    };
  };

  return Object.assign(connect, {
    /** Fire a connect event carrying no port at all, which `ports` allows for. */
    withoutPort: () => fire([]),
  });
}

describe("the SharedWorker entry", () => {
  it("answers requests on a newly connected port", async () => {
    const connect = await loadWorker();
    const tab = connect();
    expect(tab.send({ kind: "request", id: 1, op: "setItem", key: "k", value: "v" })).toEqual({
      kind: "response",
      version: PROTOCOL_VERSION,
      id: 1,
      ok: true,
      result: null,
    });
    expect(tab.send({ kind: "request", id: 2, op: "getItem", key: "k" })).toEqual({
      kind: "response",
      version: PROTOCOL_VERSION,
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
      version: PROTOCOL_VERSION,
      id: 1,
      ok: true,
      result: [["k", "v"]],
    });
  });

  it("has nothing to wire up for a connect event carrying no port", async () => {
    const connect = await loadWorker();
    // Indexing `ports` cannot promise a port is there, and a handler that threw
    // on the absence would take down the event the browser has no answer for.
    expect(() => connect.withoutPort()).not.toThrow();
    // The store the worker holds is untouched by it, so the next tab to arrive
    // is served as though the empty event had never happened.
    const tab = connect();
    expect(tab.send({ kind: "request", id: 1, op: "setItem", key: "k", value: "v" })?.ok).toBe(
      true,
    );
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
