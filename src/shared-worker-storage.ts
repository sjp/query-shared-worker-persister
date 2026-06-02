import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import type { StorageRequest, StorageResponse } from "./worker/protocol";

/** The minimal `MessagePort` surface we use — lets tests inject a fake port. */
export interface PortAdapter {
  postMessage: (message: StorageRequest) => void;
  onmessage: ((event: MessageEvent<StorageResponse>) => void) | null;
  start?: () => void;
}

export interface SharedWorkerStorage extends AsyncStorage {
  /** Detach the port handler and reject any in-flight requests. */
  dispose: () => void;
}

export interface CreateSharedWorkerStorageOptions {
  /** Reject a pending request after this many ms. Default 10s. */
  timeoutMs?: number;
  /**
   * Inject a port instead of creating a real `SharedWorker`. Used by tests to
   * pipe messages through an in-process store; not needed in app code.
   */
  port?: PortAdapter;
}

/** `Omit` that distributes over a union, preserving per-variant fields like `value`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A request awaiting its matching response, plus the timer that will reject it. */
interface Pending {
  resolve: (value: string | null) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Build a SharedWorker-backed {@link AsyncStorage}. All three storage methods
 * round-trip a {@link StorageRequest} to the worker and await the response with
 * the matching `id`, so concurrent calls never cross wires.
 *
 * With no `port` injected this spins up the shared `cache.worker.ts`. Per the
 * project's no-fallback decision, it throws if `SharedWorker` is unavailable
 * rather than silently degrading.
 */
export function createSharedWorkerStorage(
  options: CreateSharedWorkerStorageOptions = {},
): SharedWorkerStorage {
  const { timeoutMs = 10_000 } = options;

  const port = options.port ?? connectSharedWorker();

  const pending = new Map<number, Pending>();
  let nextId = 1;

  port.onmessage = (event: MessageEvent<StorageResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return; // already timed out, or a stray message — ignore
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(message.error));
    }
  };
  port.start?.();

  function request(message: DistributiveOmit<StorageRequest, "id">): Promise<string | null> {
    const id = nextId++;
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`SharedWorker storage request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ ...message, id } as StorageRequest);
    });
  }

  return {
    getItem: (key) => request({ kind: "request", op: "getItem", key }),
    setItem: async (key, value) => {
      await request({ kind: "request", op: "setItem", key, value });
    },
    removeItem: async (key) => {
      await request({ kind: "request", op: "removeItem", key });
    },
    dispose: () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("SharedWorker storage disposed"));
      }
      pending.clear();
      port.onmessage = null;
    },
  };
}

/** Instantiate the shared `cache.worker.ts` and return its port. */
function connectSharedWorker(): PortAdapter {
  if (typeof SharedWorker === "undefined") {
    throw new Error(
      "SharedWorker is not available in this environment. " +
        "This persister targets modern desktop browsers only and has no fallback.",
    );
  }
  // Reference the *built* sibling (`dist/cache.worker.js`) by a plain relative
  // URL. tsc leaves this expression verbatim, so the consumer's bundler sees the
  // standard `new SharedWorker(new URL('./…', import.meta.url), { type: 'module' })`
  // pattern and re-emits the worker at a stable, same-origin URL — which is what
  // makes the SharedWorker actually shared across tabs.
  const worker = new SharedWorker(new URL("./cache.worker.js", import.meta.url), {
    type: "module",
    name: "TANSTACK_QUERY_SHARED_CACHE_WORKER",
  });
  return worker.port;
}
