import { describe, expect, it, vi } from "vite-plus/test";
import { handleConnect, respond, type WorkerPort } from "./connection";
import { PROTOCOL_VERSION, type StorageRequest, type StorageResponse } from "./protocol";
import { CacheStore } from "./store";

describe("respond", () => {
  it("wraps a successful getItem in an ok response, echoing the id", () => {
    const store = new CacheStore();
    store.setItem("k", "v");
    expect(respond(store, { kind: "request", id: 7, op: "getItem", key: "k" })).toEqual({
      kind: "response",
      version: PROTOCOL_VERSION,
      id: 7,
      ok: true,
      result: "v",
    });
  });

  it("returns ok with a null result for writes", () => {
    const store = new CacheStore();
    expect(respond(store, { kind: "request", id: 1, op: "setItem", key: "k", value: "v" })).toEqual(
      {
        kind: "response",
        version: PROTOCOL_VERSION,
        id: 1,
        ok: true,
        result: null,
      },
    );
    expect(store.getItem("k")).toBe("v");
  });

  it("answers an entries request with every stored pair", () => {
    const store = new CacheStore();
    store.setItem("a", "1");
    store.setItem("b", "2");
    expect(respond(store, { kind: "request", id: 9, op: "entries" })).toEqual({
      kind: "response",
      version: PROTOCOL_VERSION,
      id: 9,
      ok: true,
      result: [
        ["a", "1"],
        ["b", "2"],
      ],
    });
  });

  it("wraps a thrown Error as an ok:false response carrying its message", () => {
    const store = {
      handle: () => {
        throw new Error("kaboom");
      },
    };
    expect(respond(store, { kind: "request", id: 3, op: "getItem", key: "k" })).toEqual({
      kind: "response",
      version: PROTOCOL_VERSION,
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
      version: PROTOCOL_VERSION,
      id: 4,
      ok: false,
      error: "weird",
    });
  });
});

describe("handleConnect", () => {
  /** A port plus the messages it sent, wired to a fresh store. */
  function connect() {
    const sent: StorageResponse[] = [];
    const port: WorkerPort = {
      onmessage: null,
      postMessage: (message) => sent.push(message),
    };
    const store = new CacheStore();
    handleConnect(store, port);
    return {
      sent,
      store,
      deliver: (data: unknown) => port.onmessage?.({ data } as MessageEvent<unknown>),
      messageError: () => port.onmessageerror?.({} as MessageEvent),
    };
  }

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
    // `entries` carries no key, so it also proves validation doesn't demand one.
    deliver({ kind: "request", id: 3, op: "entries" });

    expect(sent).toEqual([
      { kind: "response", version: PROTOCOL_VERSION, id: 1, ok: true, result: null },
      { kind: "response", version: PROTOCOL_VERSION, id: 2, ok: true, result: "v" },
      { kind: "response", version: PROTOCOL_VERSION, id: 3, ok: true, result: [["k", "v"]] },
    ]);
  });

  describe("the protocol version", () => {
    it("is stamped on a failed response as well as a served one", () => {
      const { sent, deliver } = connect();
      deliver({ kind: "request", id: 1, version: PROTOCOL_VERSION, op: "entries" });
      // Malformed - no key - so this one is answered with an error envelope,
      // which a client has to be able to read the version off just the same.
      deliver({ kind: "request", id: 2, op: "getItem" });
      expect(sent.map((response) => response.version)).toEqual([
        PROTOCOL_VERSION,
        PROTOCOL_VERSION,
      ]);
    });

    it("answers a request that names no version at all", () => {
      const { sent, deliver } = connect();
      deliver({ kind: "request", id: 1, op: "setItem", key: "k", value: "v" });
      expect(sent).toEqual([
        { kind: "response", version: PROTOCOL_VERSION, id: 1, ok: true, result: null },
      ]);
    });

    it("answers a request naming a version it has never heard of", () => {
      // This worker is whichever build the first tab to connect loaded, so
      // turning away a version it doesn't recognise would turn away the very
      // tabs it should still be serving. It answers, and its own version on the
      // response is what lets the client decide the two don't match.
      const { sent, deliver } = connect();
      deliver({ kind: "request", id: 1, version: PROTOCOL_VERSION + 1, op: "getItem", key: "k" });
      expect(sent).toEqual([
        { kind: "response", version: PROTOCOL_VERSION, id: 1, ok: true, result: null },
      ]);
    });
  });

  describe("malformed messages", () => {
    /** An object that refers back to itself, as structured cloning permits. */
    function cyclic(): Record<string, unknown> {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }

    it.each([
      ["an unknown op", { kind: "request", id: 5, op: "clear", key: "k" }],
      ["a missing kind", { id: 5, op: "getItem", key: "k" }],
      ["a non-string key", { kind: "request", id: 5, op: "getItem", key: 42 }],
      ["a missing key", { kind: "request", id: 5, op: "getItem" }],
      ["a non-string setItem value", { kind: "request", id: 5, op: "setItem", key: "k", value: 1 }],
      // A bigint and a cycle both survive structured cloning and both defeat
      // `JSON.stringify`, so they reach validation and must not fault it.
      ["a bigint kind", { kind: 10n, id: 5, op: "getItem", key: "k" }],
      ["a bigint op", { kind: "request", id: 5, op: 10n, key: "k" }],
      ["a cyclic op", { kind: "request", id: 5, op: cyclic(), key: "k" }],
      ["a function op", { kind: "request", id: 5, op: () => "getItem", key: "k" }],
      ["a cyclic key", { kind: "request", id: 5, op: "getItem", key: cyclic() }],
    ])("replies ok:false for %s carrying an id", (_label, data) => {
      const { sent, deliver } = connect();
      deliver(data);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        kind: "response",
        version: PROTOCOL_VERSION,
        id: 5,
        ok: false,
      });
    });

    it("does not let a malformed request touch the store", () => {
      const { store, deliver } = connect();
      deliver({ kind: "request", id: 5, op: "setItem", key: "k", value: 1 });
      expect(store.getItem("k")).toBeNull();
    });

    it.each([
      ["no id", { kind: "request", op: "getItem", key: "k" }],
      ["a non-numeric id", { kind: "request", id: "5", op: "getItem", key: "k" }],
      ["a non-object payload", "hello"],
      ["a null payload", null],
      ["a bigint kind and no id", { kind: 10n, op: "getItem", key: "k" }],
      ["a bigint id", { kind: "request", id: 5n, op: "getItem", key: "k" }],
    ])("logs and drops a message with %s", (_label, data) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { sent, deliver } = connect();
        deliver(data);
        expect(sent).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it("names an unserializable operation in the error it replies with", () => {
      const { sent, deliver } = connect();
      deliver({ kind: "request", id: 5, op: 10n, key: "k" });
      expect(sent).toEqual([
        {
          kind: "response",
          version: PROTOCOL_VERSION,
          id: 5,
          ok: false,
          error: "Malformed request: unknown operation 10n",
        },
      ]);
    });

    it("answers rather than throwing when reading the message itself fails", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { sent, deliver } = connect();
        expect(() =>
          deliver({
            id: 5,
            get kind(): never {
              throw new Error("kaboom");
            },
          }),
        ).not.toThrow();
        expect(error).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([
          {
            kind: "response",
            version: PROTOCOL_VERSION,
            id: 5,
            ok: false,
            error: "Failed to handle request: kaboom",
          },
        ]);
      } finally {
        error.mockRestore();
      }
    });

    it("logs and drops a message that fails to read and carries no id", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { sent, deliver } = connect();
        expect(() =>
          deliver({
            get kind(): never {
              throw new Error("kaboom");
            },
          }),
        ).not.toThrow();
        expect(error).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([]);
      } finally {
        error.mockRestore();
      }
    });

    it("logs when a message cannot be deserialized", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { sent, messageError } = connect();
        messageError();
        expect(error).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([]);
      } finally {
        error.mockRestore();
      }
    });
  });
});
