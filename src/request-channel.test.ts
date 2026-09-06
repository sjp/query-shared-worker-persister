import { describe, expect, it, vi } from "vite-plus/test";
import { createRequestChannel, type PortAdapter } from "./request-channel";
import { SharedWorkerStorageError } from "./storage-error";
import {
  createDeadPort,
  createFakePort,
  createRecordingPort,
  createResultPort,
} from "./test-utils";
import { PROTOCOL_VERSION, type StorageRequest } from "./worker/protocol";
import { CacheStore } from "./worker/store";

/**
 * The request channel on its own: ids, timers, and matching each response to
 * the request that asked for it. Everything here needs a port and a deadline
 * and nothing else — there is no storage, no disposal and no reporting in this
 * file, which is the point of the split. The same behaviours seen from the
 * outside, through a storage, are in the `shared-worker-storage.*.test.ts`
 * files.
 */

/** The handlers a channel is given, as spies, plus the channel itself. */
function channelOver(port: PortAdapter, timeoutMs = 10_000) {
  const onUndeliverableMessage = vi.fn();
  const onDisconnect = vi.fn();
  const channel = createRequestChannel(port, timeoutMs, {
    onUndeliverableMessage,
    onDisconnect,
  });
  return { channel, onUndeliverableMessage, onDisconnect };
}

/** The `getItem` request the tests below use when only the round trip matters. */
function getItem(key: string) {
  return (id: number): StorageRequest => ({ kind: "request", id, op: "getItem", key });
}

function setItem(key: string, value: string) {
  return (id: number): StorageRequest => ({ kind: "request", id, op: "setItem", key, value });
}

/** A port that answers every request with `data`, whatever was asked. */
function createAnsweringPort(data: unknown): PortAdapter {
  const port: PortAdapter = {
    onmessage: null,
    postMessage(request: StorageRequest) {
      queueMicrotask(() => {
        port.onmessage?.({
          data: typeof data === "function" ? data(request) : data,
        } as MessageEvent<unknown>);
      });
    },
  };
  return port;
}

describe("createRequestChannel", () => {
  it("resolves each request with its own response", async () => {
    const store = new CacheStore();
    store.setItem("a", "1");
    store.setItem("b", "2");
    const { channel } = channelOver(createFakePort(store));
    await expect(
      Promise.all([channel.request(getItem("a")), channel.request(getItem("b"))]),
    ).resolves.toEqual(["1", "2"]);
    channel.close();
  });

  it("gives every request its own id and stamps the protocol version on it", async () => {
    const { port, sent } = createRecordingPort();
    const { channel } = channelOver(port);
    await Promise.all([channel.request(setItem("a", "1")), channel.request(setItem("b", "2"))]);
    expect(sent.map((request) => request.id)).toEqual([1, 2]);
    expect(sent.every((request) => request.version === PROTOCOL_VERSION)).toBe(true);
    channel.close();
  });

  it("starts a port that can be started", () => {
    const start = vi.fn();
    const { channel } = channelOver({ onmessage: null, postMessage() {}, start });
    expect(start).toHaveBeenCalledTimes(1);
    channel.close();
  });

  it("clears the timer of a request the port answered", async () => {
    vi.useFakeTimers();
    try {
      const { channel } = channelOver(createFakePort(), 60_000);
      await channel.request(setItem("k", "v"));
      expect(vi.getTimerCount()).toBe(0);
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a request the port never answers, naming the deadline", async () => {
    const { channel } = channelOver(createDeadPort(), 20);
    await expect(channel.request(getItem("k"))).rejects.toThrow(
      "SharedWorker storage request timed out after 20ms",
    );
    channel.close();
  });

  it("schedules no timer at all for an infinite deadline", async () => {
    vi.useFakeTimers();
    try {
      const { channel } = channelOver(createDeadPort(), Number.POSITIVE_INFINITY);
      const inflight = channel.request(getItem("k"));
      expect(vi.getTimerCount()).toBe(0);
      // Nothing but the caller can settle it, which is what "no deadline" means.
      channel.rejectAll(new SharedWorkerStorageError("disposed", "let go of"));
      await expect(inflight).rejects.toThrow("let go of");
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a response written in a protocol version it does not speak, naming both", async () => {
    const port = createAnsweringPort((request: StorageRequest) => ({
      kind: "response",
      id: request.id,
      ok: true,
      result: "v",
      version: PROTOCOL_VERSION + 1,
    }));
    const { channel } = channelOver(port);
    await expect(channel.request(getItem("k"))).rejects.toThrow(
      `SharedWorker speaks protocol version ${PROTOCOL_VERSION + 1}, ` +
        `this build speaks ${PROTOCOL_VERSION}`,
    );
    channel.close();
  });

  it("reads a response carrying no version as the first one, so an older worker still answers", async () => {
    const port = createAnsweringPort((request: StorageRequest) => ({
      kind: "response",
      id: request.id,
      ok: true,
      result: "v",
    }));
    const { channel } = channelOver(port);
    await expect(channel.request(getItem("k"))).resolves.toBe("v");
    channel.close();
  });

  it("rejects a result that does not fit the operation the request named", async () => {
    const { channel } = channelOver(createResultPort([["k", "v"]]));
    await expect(channel.request(getItem("k"))).rejects.toThrow(
      "SharedWorker returned an unexpected getItem result",
    );
    channel.close();
  });

  it("rejects an entries result that is not a list of string pairs", async () => {
    const { channel } = channelOver(createResultPort("v"));
    await expect(channel.request((id) => ({ kind: "request", id, op: "entries" }))).rejects.toThrow(
      "SharedWorker returned an unexpected entries result",
    );
    channel.close();
  });

  it("rejects a request the worker answered with an error, carrying its message", async () => {
    const port = createAnsweringPort((request: StorageRequest) => ({
      kind: "response",
      id: request.id,
      ok: false,
      error: "no such operation",
    }));
    const { channel } = channelOver(port);
    await expect(channel.request(getItem("k"))).rejects.toThrow("no such operation");
    channel.close();
  });

  it.each([
    ["a message that is not a response", { kind: "broadcast", id: 1, payload: "hi" }],
    [
      "a response for an id nothing is waiting on",
      { kind: "response", id: 99, ok: true, result: "v" },
    ],
    ["a response with no ok flag", { kind: "response", id: 1, result: "v" }],
    ["an ok response with no result", { kind: "response", id: 1, ok: true }],
    ["an error response with no message", { kind: "response", id: 1, ok: false }],
    [
      "a response whose version is not a number",
      { kind: "response", id: 1, version: "1", ok: true, result: "v" },
    ],
    ["a non-object payload", "hello"],
  ])("leaves the request pending for %s", async (_label, data) => {
    const port = createDeadPort();
    const { channel } = channelOver(port, 20);
    const inflight = channel.request(getItem("k"));
    port.onmessage?.({ data } as MessageEvent<unknown>);
    // Only the deadline settles it, proving the message never matched.
    await expect(inflight).rejects.toThrow(/timed out/);
    channel.close();
  });

  it("rejects a request the port refused, leaving no timer behind it", async () => {
    vi.useFakeTimers();
    try {
      const cause = new DOMException("a function could not be cloned", "DataCloneError");
      const { channel } = channelOver(
        {
          onmessage: null,
          postMessage() {
            throw cause;
          },
        },
        60_000,
      );
      const error = await channel.request(getItem("k")).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ code: "transport", cause });
      expect(vi.getTimerCount()).toBe(0);
      // The pending entry went with the timer, so this has nothing left to settle.
      channel.rejectAll(new SharedWorkerStorageError("disposed", "let go of"));
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps answering after a refusal, since one value the port would not take condemns nothing", async () => {
    const port = createFakePort();
    const send = port.postMessage.bind(port);
    let refuse = true;
    port.postMessage = (request: StorageRequest) => {
      if (refuse) throw new Error("nope");
      send(request);
    };
    const { channel } = channelOver(port);
    await expect(channel.request(setItem("k", "v"))).rejects.toThrow(/Could not post a request/);
    refuse = false;
    await channel.request(setItem("k", "v"));
    await expect(channel.request(getItem("k"))).resolves.toBe("v");
    channel.close();
  });

  it("settles everything in flight through rejectAll and clears their timers", async () => {
    vi.useFakeTimers();
    try {
      const { channel } = channelOver(createDeadPort(), 60_000);
      const inflight = [channel.request(getItem("a")), channel.request(setItem("b", "1"))];
      expect(vi.getTimerCount()).toBe(2);
      const error = new SharedWorkerStorageError("disposed", "let go of");
      channel.rejectAll(error);
      await expect(Promise.allSettled(inflight)).resolves.toEqual([
        { status: "rejected", reason: error },
        { status: "rejected", reason: error },
      ]);
      expect(vi.getTimerCount()).toBe(0);
      channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a message the port could not deserialize, and nothing more", async () => {
    const port = createDeadPort();
    const { channel, onUndeliverableMessage } = channelOver(port, 20);
    const inflight = channel.request(getItem("k"));
    port.onmessageerror?.({} as MessageEvent);
    expect(onUndeliverableMessage).toHaveBeenCalledTimes(1);
    // The event named no request, so this one still falls to its own deadline.
    await expect(inflight).rejects.toThrow(/timed out/);
    channel.close();
  });

  it("passes on the port closing without settling anything itself", async () => {
    const port: PortAdapter = { onmessage: null, onclose: null, postMessage() {} };
    const { channel, onDisconnect } = channelOver(port, 20);
    const inflight = channel.request(getItem("k"));
    port.onclose?.(new Event("close"));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    await expect(inflight).rejects.toThrow(/timed out/);
    channel.close();
  });

  it("detaches every handler and closes the port, once however often it is asked", () => {
    const close = vi.fn();
    const port: PortAdapter = { onmessage: null, postMessage() {}, close };
    const { channel } = channelOver(port);
    channel.close();
    expect(port.onmessage).toBeNull();
    expect(port.onmessageerror).toBeNull();
    expect(port.onclose).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
    channel.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves a port with no close of its own alone", () => {
    const port: PortAdapter = { onmessage: null, postMessage() {} };
    const { channel } = channelOver(port);
    expect(() => channel.close()).not.toThrow();
  });
});
