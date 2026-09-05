import { vi } from "vite-plus/test";
import type { PortAdapter } from "./shared-worker-storage";
import { respond } from "./worker/connection";
import type { StorageRequest } from "./worker/protocol";
import { CacheStore } from "./worker/store";

/**
 * Helpers shared by the test suites in this directory. Not one of the packaged
 * entries, so nothing here ships in `dist`.
 */

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
 * Run `fn` with `globalThis.SharedWorker` forced present/absent, then restore,
 * handing back whatever `fn` returned.
 */
export async function withSharedWorker<T>(value: unknown, fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as { SharedWorker?: unknown };
  const had = "SharedWorker" in g;
  const original = g.SharedWorker;
  if (value === undefined) delete g.SharedWorker;
  else g.SharedWorker = value;
  try {
    return await fn();
  } finally {
    if (had) g.SharedWorker = original;
    else delete g.SharedWorker;
  }
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
export async function withDocument<T>(value: unknown, fn: () => T | Promise<T>): Promise<T> {
  const g = globalThis as { document?: unknown };
  const had = "document" in g;
  const original = g.document;
  if (value === undefined) delete g.document;
  else g.document = value;
  try {
    return await fn();
  } finally {
    if (had) g.document = original;
    else delete g.document;
  }
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

  /**
   * A port that both records what was posted and forwards it to a real
   * answering port, so a single fake serves the tests that assert on traffic and
   * those that need genuine responses.
   */
  function createRecordingPort(post: (request: StorageRequest) => void, close: () => void) {
    const answering = dead ? undefined : createFakePort(store);
    const port: PortAdapter = {
      onmessage: null,
      postMessage: (request) => {
        post(request);
        answering?.postMessage(request);
      },
      close,
    };
    // The answering port replies through its own handler, so point that at
    // whichever handler the client has installed on the port it was given.
    if (answering) answering.onmessage = (event) => port.onmessage?.(event);
    return port;
  }

  class FakeSharedWorker {
    readonly postMessage = vi.fn<(request: StorageRequest) => void>();
    readonly close = vi.fn<() => void>();
    readonly port = createRecordingPort(this.postMessage, this.close);
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
