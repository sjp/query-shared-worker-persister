import { describe, expect, it, vi } from "vite-plus/test";
import { handleConnect, respond, type WorkerPort } from "./connection";
import type { StorageRequest, StorageResponse } from "./protocol";
import { CacheStore } from "./store";

describe("respond", () => {
  it("wraps a successful getItem in an ok response, echoing the id", () => {
    const store = new CacheStore();
    store.setItem("k", "v");
    expect(respond(store, { kind: "request", id: 7, op: "getItem", key: "k" })).toEqual({
      kind: "response",
      id: 7,
      ok: true,
      result: "v",
    });
  });

  it("returns ok with a null result for writes", () => {
    const store = new CacheStore();
    expect(respond(store, { kind: "request", id: 1, op: "setItem", key: "k", value: "v" })).toEqual({
      kind: "response",
      id: 1,
      ok: true,
      result: null,
    });
    expect(store.getItem("k")).toBe("v");
  });

  it("wraps a thrown Error as an ok:false response carrying its message", () => {
    const store = {
      handle: () => {
        throw new Error("kaboom");
      },
    };
    expect(respond(store, { kind: "request", id: 3, op: "getItem", key: "k" })).toEqual({
      kind: "response",
      id: 3,
      ok: false,
      error: "kaboom",
    });
  });

  it("stringifies a non-Error throw", () => {
    const store = {
      handle: () => {
        throw "weird";
      },
    };
    expect(respond(store, { kind: "request", id: 4, op: "getItem", key: "k" })).toEqual({
      kind: "response",
      id: 4,
      ok: false,
      error: "weird",
    });
  });
});

describe("handleConnect", () => {
  it("does nothing when no port is supplied", () => {
    expect(() => handleConnect(new CacheStore(), undefined)).not.toThrow();
    expect(() => handleConnect(new CacheStore(), null)).not.toThrow();
  });

  it("starts the port and answers requests against the store", () => {
    const store = new CacheStore();
    const sent: StorageResponse[] = [];
    const start = vi.fn();
    const port: WorkerPort = {
      onmessage: null,
      postMessage: (message) => sent.push(message),
      start,
    };

    handleConnect(store, port);

    expect(start).toHaveBeenCalledTimes(1);
    expect(port.onmessage).not.toBeNull();

    const deliver = (request: StorageRequest) =>
      port.onmessage?.({ data: request } as MessageEvent<StorageRequest>);
    deliver({ kind: "request", id: 1, op: "setItem", key: "k", value: "v" });
    deliver({ kind: "request", id: 2, op: "getItem", key: "k" });

    expect(sent).toEqual([
      { kind: "response", id: 1, ok: true, result: null },
      { kind: "response", id: 2, ok: true, result: "v" },
    ]);
  });
});
