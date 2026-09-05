import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import type { SharedWorkerStorage } from "./shared-worker-storage";

/**
 * The one suite that runs against a genuine `SharedWorker` in a real browser.
 *
 * Everything else in this package is tested in Node against fake ports, which
 * cannot show the two properties the package exists for: that a single worker
 * process backs every connection to it, and that the worker is identified by
 * `(scriptURL, name)` so a different name means a different store. Both are
 * browser behaviour, not ours, so they are only ever exercised here.
 *
 * It also runs against the *built* bundle rather than the sources, which makes
 * it the only check on the packaging contract: `dist/index.js` reaches its
 * worker through `new URL("./cache.worker.js", import.meta.url)`, so the pack
 * step has to keep emitting that sibling file and leave the reference alone. A
 * change to the entry list, the module format, or the worker's name would pass
 * every Node test and fail here.
 */

/** Where the built bundle lives, relative to this file. */
const BUNDLE_PATH = "../dist/index.js";

/**
 * The built bundle's exports. Imported by URL at runtime, not by specifier,
 * because `dist/` is a build product: a static import would make type checking
 * and the Node suite depend on a build having happened first. The types still
 * come from the sources, which is what the declarations are generated from.
 */
type Bundle = typeof import("./index");
let bundle: Bundle;

/** Storages opened by the current test, closed again when it ends. */
const opened: SharedWorkerStorage[] = [];

/** Open a storage against the built worker and dispose it after the test. */
function open(options: Parameters<Bundle["createSharedWorkerStorage"]>[0] = {}) {
  // Well under the 5s test timeout, so a worker that never answers fails with
  // this package's own timeout message instead of an anonymous hung test.
  const storage = bundle.createSharedWorkerStorage({ timeoutMs: 2_000, ...options });
  opened.push(storage);
  return storage;
}

/**
 * A key nothing else uses. The worker outlives each test — that is the point of
 * it — so every test has to name its own keys rather than start from an empty
 * store.
 */
let keySeq = 0;
function uniqueKey(name: string) {
  keySeq += 1;
  return `${name}-${String(keySeq)}`;
}

beforeAll(async () => {
  const url = new URL(BUNDLE_PATH, import.meta.url).href;
  try {
    bundle = (await import(/* @vite-ignore */ url)) as Bundle;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Could not load the built bundle from ${BUNDLE_PATH} (${reason}). This suite runs ` +
        "against the package as it is published, so build it first (npm run build).",
    );
  }
});

afterEach(() => {
  for (const storage of opened.splice(0)) storage.dispose();
});

describe("a real SharedWorker", () => {
  it("is available in this browser", () => {
    expect(bundle.isSharedWorkerSupported()).toBe(true);
  });

  it("gives two connections the same store", async () => {
    const key = uniqueKey("shared");
    const writer = open();
    const reader = open();

    await writer.setItem(key, "written by the first tab");

    await expect(reader.getItem(key)).resolves.toBe("written by the first tab");
  });

  it("shows a removal made through one connection to the other", async () => {
    const key = uniqueKey("removed");
    const writer = open();
    const reader = open();
    await writer.setItem(key, "v");
    await expect(reader.getItem(key)).resolves.toBe("v");

    await writer.removeItem(key);

    await expect(reader.getItem(key)).resolves.toBeNull();
  });

  it("lists another connection's writes in entries", async () => {
    const key = uniqueKey("listed");
    const writer = open();
    const reader = open();

    await writer.setItem(key, "v");

    await expect(reader.entries()).resolves.toContainEqual([key, "v"]);
  });

  it("keeps a namespaced worker's store separate from the default one", async () => {
    const key = uniqueKey("namespaced");
    const shared = open();
    const isolated = open({ namespace: "separate-app" });
    await shared.setItem(key, "only in the default worker");

    await expect(isolated.getItem(key)).resolves.toBeNull();

    // ...and the isolated store is a working store, not simply an unreachable
    // worker whose reads all resolve empty.
    await isolated.setItem(key, "only in the namespaced worker");
    await expect(isolated.getItem(key)).resolves.toBe("only in the namespaced worker");
    await expect(shared.getItem(key)).resolves.toBe("only in the default worker");
  });

  it("stops answering once disposed, without waiting out the timeout", async () => {
    const key = uniqueKey("disposed");
    const storage = open();
    await storage.setItem(key, "v");

    storage.dispose();

    await expect(storage.setItem(key, "later")).rejects.toThrow(/disposed/);
    await expect(storage.getItem(key)).resolves.toBeNull();
    // The value is still in the worker; only this connection went away.
    await expect(open().getItem(key)).resolves.toBe("v");
  });

  it("survives a disposed connection while another is still open", async () => {
    const key = uniqueKey("survivor");
    const first = open();
    const second = open();
    await first.setItem(key, "v");

    first.dispose();

    await expect(second.getItem(key)).resolves.toBe("v");
    await second.setItem(key, "still writable");
    await expect(second.getItem(key)).resolves.toBe("still writable");
  });
});
