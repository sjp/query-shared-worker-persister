import { expect, type Mock, vi } from "vite-plus/test";
import { type PortAdapter, SharedWorkerStorageError } from "./shared-worker-storage";
import { respond } from "./worker/connection";
import {
  PROTOCOL_VERSION,
  type StorageRequest,
  type StorageResponse,
  type StorageResult,
} from "./worker/protocol";
import { CacheStore } from "./worker/store";

/**
 * A fake `MessagePort` that stands in for the SharedWorker connection: it pipes
 * client requests through a real {@link CacheStore} and replies asynchronously,
 * echoing the request `id` — exactly like `cache.worker.ts` does.
 *
 * The reply is built by the worker's own {@link respond}, so the request ->
 * response mapping a client test exercises is the one that runs in production,
 * error envelopes included; only the transport is fake. This lets us test the
 * client-side request/response correlation without a real worker.
 */
export function createFakePort(store = new CacheStore()): PortAdapter {
  const port: PortAdapter = {
    onmessage: null,
    postMessage(request: StorageRequest) {
      // Reply on a microtask to mimic the async hop to the worker and back.
      queueMicrotask(() => {
        port.onmessage?.({ data: respond(store, request) } as MessageEvent<unknown>);
      });
    },
  };
  return port;
}

/**
 * A port that answers every request with the same worker-side error, standing in
 * for a worker that is there and cannot do what it was asked.
 */
export function createErrorPort(error = "boom"): PortAdapter {
  const port: PortAdapter = {
    onmessage: null,
    postMessage(request: StorageRequest) {
      queueMicrotask(() => {
        port.onmessage?.({
          data: { kind: "response", id: request.id, ok: false, error },
        } as MessageEvent<StorageResponse>);
      });
    },
  };
  return port;
}

/**
 * A port that answers every request with the same successful result, whatever
 * was asked for. Stands in for a sender whose envelope is well formed but whose
 * payload belongs to another operation — a script of someone else's on the
 * origin, or a build that reads the protocol differently — so the client's own
 * check of the result against the request it sent can be exercised in either
 * direction.
 */
export function createResultPort(result: StorageResult): PortAdapter {
  const port: PortAdapter = {
    onmessage: null,
    postMessage(request: StorageRequest) {
      queueMicrotask(() => {
        port.onmessage?.({
          data: { kind: "response", id: request.id, ok: true, result, version: PROTOCOL_VERSION },
        } as MessageEvent<StorageResponse>);
      });
    },
  };
  return port;
}

/** A port that never answers, so only the client itself can settle a request. */
export function createDeadPort(): PortAdapter {
  return { onmessage: null, postMessage() {} };
}

/**
 * A port that shows every request to `onPost` and then hands it to `answering`,
 * so one fake can serve both the tests that assert on what the client sent and
 * those that need genuine replies. Pass no `answering` port for a fake that
 * observes and never answers. Anything in `extra` — a `close` spy, say — is
 * merged onto the returned port.
 */
function createForwardingPort(
  answering: PortAdapter | undefined,
  onPost: (request: StorageRequest) => void,
  extra?: Partial<PortAdapter>,
): PortAdapter {
  const port: PortAdapter = {
    onmessage: null,
    postMessage: (request) => {
      onPost(request);
      answering?.postMessage(request);
    },
    ...extra,
  };
  // The answering port replies through its own handler, so point that at
  // whichever handler the client has installed on the port it was given.
  if (answering) answering.onmessage = (event) => port.onmessage?.(event);
  return port;
}

/**
 * A {@link createFakePort} that also keeps every request posted through it, for
 * the tests that assert on what the client asked as well as on what it got back.
 */
export function createRecordingPort(store = new CacheStore()) {
  const sent: StorageRequest[] = [];
  const port = createForwardingPort(createFakePort(store), (request) => void sent.push(request));
  return { port, sent, store };
}

/**
 * Run `fn` with `globalThis[name]` forced to `value` — or deleted, when that is
 * `undefined` — restore whatever was there before, and hand back whatever `fn`
 * returned. Restoring tells an absent global from one set to `undefined`, so a
 * test that deletes one leaves no trace of it behind.
 */
async function withGlobal<T>(name: string, value: unknown, fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = name in g;
  const original = g[name];
  if (value === undefined) delete g[name];
  else g[name] = value;
  try {
    return await fn();
  } finally {
    if (had) g[name] = original;
    else delete g[name];
  }
}

/**
 * Run `fn` with `globalThis.SharedWorker` forced present/absent, then restore,
 * handing back whatever `fn` returned.
 */
export function withSharedWorker<T>(value: unknown, fn: () => T | Promise<T>): Promise<T> {
  return withGlobal("SharedWorker", value, fn);
}

/**
 * Run `fn` with `globalThis.document` forced present/absent, then restore,
 * handing back whatever `fn` returned.
 *
 * The Node suite has no `document`, which is how the client tells a server from
 * a browser. Wrap a test in this to model a browser — one that may still be
 * missing `SharedWorker`, which is the environment the no-op fallback is meant
 * to be visible in.
 */
export function withDocument<T>(value: unknown, fn: () => T | Promise<T>): Promise<T> {
  return withGlobal("document", value, fn);
}

/**
 * Run `fn` with `globalThis.location` forced present/absent, then restore,
 * handing back whatever `fn` returned.
 *
 * The Node suite has no `location` either, so the client treats it as it does a
 * server: there is no page origin to hold a `workerUrl` against. Wrap a test in
 * this — `withLocation({ href: "https://app.test/" }, ...)` — to give it one.
 */
export function withLocation<T>(value: unknown, fn: () => T | Promise<T>): Promise<T> {
  return withGlobal("location", value, fn);
}

/** One `new SharedWorker(...)` call, as seen by {@link fakeSharedWorker}. */
export interface SharedWorkerConstruction {
  url: string | URL;
  options: WorkerOptions | undefined;
}

export interface FakeSharedWorkerOptions {
  /** The store the fake's port answers from. Share one to model two tabs. */
  store?: CacheStore;
  /** Give the port no answers at all, so only the client can settle a request. */
  dead?: boolean;
}

/**
 * A recording `SharedWorker` stand-in to hand to {@link withSharedWorker}, for
 * the paths that construct a real worker rather than taking an injected port.
 *
 * Every construction is recorded in `constructions` — the script URL and the
 * options object, which together are the worker's identity — and every instance
 * keeps spies on what the client posted and whether the port was closed. Call
 * `fail()` on one to fire `onerror` the way the browser does when the worker
 * script can't be loaded.
 *
 * The port answers from `store` exactly as the real worker would, unless `dead`
 * is set, in which case it never replies and the only thing that can settle a
 * request is the client's own timeout or disposal.
 */
export function fakeSharedWorker({
  store = new CacheStore(),
  dead = false,
}: FakeSharedWorkerOptions = {}) {
  const constructions: SharedWorkerConstruction[] = [];
  const instances: FakeSharedWorker[] = [];

  /** The fake's port: spies on what was posted, and answers unless `dead`. */
  function createSpiedPort(post: (request: StorageRequest) => void, close: () => void) {
    return createForwardingPort(dead ? undefined : createFakePort(store), post, { close });
  }

  class FakeSharedWorker {
    readonly postMessage = vi.fn<(request: StorageRequest) => void>();
    readonly close = vi.fn<() => void>();
    readonly port = createSpiedPort(this.postMessage, this.close);
    onerror: ((event: { message: string }) => void) | null = null;

    constructor(url: string | URL, options?: WorkerOptions) {
      constructions.push({ url, options });
      instances.push(this);
    }

    /** Report a worker that never started, as `onerror` does in the browser. */
    fail(message = "boot failed") {
      this.onerror?.({ message });
    }
  }

  return {
    FakeSharedWorker,
    constructions,
    store,
    /** The most recently constructed worker; fails the test if there is none. */
    get latest(): FakeSharedWorker {
      const worker = instances[instances.length - 1];
      if (!worker) throw new Error("no SharedWorker was constructed");
      return worker;
    },
  };
}

/** An `onError` handler that records what it was given, and the list it fills. */
export function recorder() {
  const reported: SharedWorkerStorageError[] = [];
  return { reported, onError: (error: SharedWorkerStorageError) => void reported.push(error) };
}

/**
 * The error a call rejected with, asserted to be one of ours.
 *
 * The class to check against is a parameter because the browser suite drives the
 * built bundle, whose `SharedWorkerStorageError` is a different class object from
 * the one the sources export; that suite hands in the bundle's.
 */
export async function rejectionFrom(
  call: () => unknown,
  errorClass: new (...args: never[]) => SharedWorkerStorageError = SharedWorkerStorageError,
): Promise<SharedWorkerStorageError> {
  const error = await Promise.resolve(call()).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(errorClass);
  return error as SharedWorkerStorageError;
}

/** The console channels {@link withConsoleSpies} silences, as spies. */
export interface ConsoleSpies {
  warn: Mock<typeof console.warn>;
  error: Mock<typeof console.error>;
}

/**
 * Run `fn` with both console channels silenced, restore them afterwards, and
 * hand back whatever `fn` returned.
 *
 * Both are taken whichever one the test goes on to assert about, so a report on
 * the other channel is silenced too rather than printed into the run's output.
 */
export async function withConsoleSpies<T>(fn: (spies: ConsoleSpies) => T | Promise<T>): Promise<T> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await fn({ warn, error });
  } finally {
    error.mockRestore();
    warn.mockRestore();
  }
}
