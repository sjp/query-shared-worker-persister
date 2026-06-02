import type { StorageRequest } from "./protocol";

/**
 * The cache itself is a plain in-memory string store, exactly the shape
 * `createAsyncStoragePersister` expects (values are already-serialized strings).
 *
 * This is deliberately free of any `SharedWorker` / `MessagePort` globals so it
 * can be unit-tested directly, and so `cache.worker.ts` stays a thin transport
 * shell around it. When the SharedWorker process is torn down (last tab closed),
 * this Map is garbage-collected with it - that is the whole cleanup story.
 */
export class CacheStore {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    // biome-ignore lint/style/noNonNullAssertion: trust the underlying store
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  /**
   * Apply a decoded {@link StorageRequest} and return the result value.
   * `setItem`/`removeItem` resolve to `null`; `getItem` returns the stored
   * string or `null` when absent. Kept here (rather than in the worker) so the
   * request -> result mapping is covered by unit tests.
   */
  handle(request: StorageRequest): string | null {
    switch (request.op) {
      case "getItem":
        return this.getItem(request.key);
      case "setItem":
        this.setItem(request.key, request.value);
        return null;
      case "removeItem":
        this.removeItem(request.key);
        return null;
    }
  }
}
