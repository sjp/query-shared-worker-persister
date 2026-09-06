import { describeValue } from "./describe-value";
import type { StorageEntries, StorageRequest, StorageResult } from "./protocol";

/**
 * The cache itself is a plain in-memory string store, exactly the shape
 * `createAsyncStoragePersister` expects (values are already-serialized strings).
 *
 * When the SharedWorker process is torn down (last tab closed),
 * this Map is garbage-collected with it.
 */
export class CacheStore {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  /**
   * The key/value pairs currently held, as a snapshot array so later writes can't
   * mutate what a caller is still reading.
   *
   * The filter is in the worker to prevent a potentially large amount of
   * messaging over the port.
   */
  entries(prefix?: string): StorageEntries {
    const pairs = Array.from(this.map.entries());
    return prefix === undefined ? pairs : pairs.filter(([key]) => key.startsWith(prefix));
  }

  /**
   * Apply a decoded {@link StorageRequest} and return the result value.
   * `setItem`/`removeItem` resolve to `null`; `getItem` returns the stored
   * string or `null` when absent; `entries` returns the pairs under its
   * `prefix`, or every pair when it carries none. Kept here
   * (rather than in the worker) so the request -> result mapping is covered by
   * unit tests.
   *
   * An operation this store doesn't implement throws, which the caller turns
   * into an error response. Returning `undefined` instead would leave the
   * client resolving a value the protocol says can't occur.
   */
  handle(request: StorageRequest): StorageResult {
    switch (request.op) {
      case "getItem":
        return this.getItem(request.key);
      case "setItem":
        this.setItem(request.key, request.value);
        return null;
      case "removeItem":
        this.removeItem(request.key);
        return null;
      case "entries":
        return this.entries(request.prefix);
      default: {
        // `request` is `never` here, so read the operation back off the
        // unnarrowed value to name it in the error.
        const { op } = request as StorageRequest;
        throw new Error(`Unknown storage operation: ${describeValue(op)}`);
      }
    }
  }
}
