import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import type { SharedWorkerStorage, SharedWorkerStorageError } from "./shared-worker-storage";

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
 *
 * The same goes for the two failure-shaped things a fake port has no way to
 * reproduce: what a browser does with a worker script it cannot load, and
 * whether a copy of that script served from somewhere else is a working worker.
 * Both are covered below against the real thing.
 */

/** Where the built bundle lives, relative to this file. */
const BUNDLE_PATH = "../dist/index.js";

/**
 * Where the built worker asset lives, relative to this file. The bundle reaches
 * it on its own; naming it again here is what the `workerUrl` tests need, since
 * their whole point is to load it from a URL the bundle did not choose.
 */
const WORKER_PATH = "../dist/cache.worker.js";

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

/** A recorder for `onError`, and the list it appends to. */
function recorder() {
  const reported: SharedWorkerStorageError[] = [];
  return { reported, onError: (error: SharedWorkerStorageError) => void reported.push(error) };
}

/** Await a call that must reject, and hand back the error it rejected with. */
async function rejectionFrom(call: () => unknown): Promise<SharedWorkerStorageError> {
  const error = await Promise.resolve(call()).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(bundle.SharedWorkerStorageError);
  return error as SharedWorkerStorageError;
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

describe("a worker whose script cannot be loaded", () => {
  it("fails every request straight away and reports the failure once", async () => {
    const { reported, onError } = recorder();
    const storage = open({
      workerUrl: "/definitely-missing/cache.worker.js",
      // Far above the test timeout, so nothing below can settle by timing out:
      // every assertion here is about the load failure itself. Chromium builds
      // the SharedWorker without complaint and only fires `error` once it has
      // failed to fetch the script, a few milliseconds later and after the
      // first request has already been posted — so the write is one of the
      // in-flight requests that failure rejects, not one refused up front.
      timeoutMs: 30_000,
      onError,
    });

    const error = await rejectionFrom(() => storage.setItem(uniqueKey("missing"), "v"));

    expect(error.code).toBe("transport");
    // The worker is gone for good, so a later read doesn't wait for a worker
    // that will never answer — and resolving it empty isn't reported a second
    // time, since the failure behind it was already reported.
    await expect(storage.getItem(uniqueKey("missing"))).resolves.toBeNull();
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe("transport");
  });

  it("reports nothing when the storage was disposed before the load failed", async () => {
    const { reported, onError } = recorder();
    const storage = open({
      workerUrl: "/definitely-missing/cache.worker.js",
      timeoutMs: 30_000,
      onError,
    });

    // Disposed in the same tick the worker was constructed, as a component
    // that mounts and unmounts immediately does, and well before Chromium has
    // finished failing to fetch the script.
    storage.dispose();

    // Long enough for that fetch to fail and fire the event this connection no
    // longer listens for.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(reported).toEqual([]);
    const error = await rejectionFrom(() => storage.setItem(uniqueKey("missing"), "v"));
    expect(error.code).toBe("disposed");
  });
});

describe("a worker hosted at an explicit workerUrl", () => {
  /**
   * The built asset under a URL of the caller's choosing. The bundle's own
   * reference already resolves to this file, so the query string is what makes
   * these a different worker from the default one: a connection that quietly
   * ignored `workerUrl` would land on the default worker and be caught by the
   * separation the last test asserts, rather than pass unnoticed.
   */
  function hostedAt(copy: string) {
    return new URL(`${WORKER_PATH}?${copy}`, import.meta.url).href;
  }

  it("round-trips through a copy served from another URL", async () => {
    const key = uniqueKey("hosted");
    const { reported, onError } = recorder();
    const storage = open({ workerUrl: hostedAt("hosted-copy"), onError });

    await storage.setItem(key, "v");

    await expect(storage.getItem(key)).resolves.toBe("v");
    expect(reported).toEqual([]);
  });

  it("gives two connections to the same workerUrl one store", async () => {
    const key = uniqueKey("hosted-shared");
    const writer = open({ workerUrl: hostedAt("hosted-copy") });
    const reader = open({ workerUrl: hostedAt("hosted-copy") });

    await writer.setItem(key, "written through the hosted copy");

    await expect(reader.getItem(key)).resolves.toBe("written through the hosted copy");
  });

  it("keeps two URLs for the same worker file on separate stores", async () => {
    const key = uniqueKey("by-url");
    const first = open({ workerUrl: hostedAt("one-copy") });
    const second = open({ workerUrl: hostedAt("another-copy") });
    await first.setItem(key, "only behind the first URL");

    await expect(second.getItem(key)).resolves.toBeNull();

    // ...and the second URL is a worker of its own, not one whose reads merely
    // resolve empty. This is what a deployment that changes the asset's URL
    // does to tabs that are already open: nothing is shared across the change.
    await second.setItem(key, "only behind the second URL");
    await expect(second.getItem(key)).resolves.toBe("only behind the second URL");
    await expect(first.getItem(key)).resolves.toBe("only behind the first URL");
  });

  it("refuses a URL on another origin", () => {
    // Against the page's real origin, which is the comparison the browser
    // itself would make: it answers a cross-origin worker script with a
    // SecurityError, so there is nothing here to degrade into.
    expect(() => open({ workerUrl: "https://cdn.example.test/cache.worker.js" })).toThrow(
      TypeError,
    );
  });
});
