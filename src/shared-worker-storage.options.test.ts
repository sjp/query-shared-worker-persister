import { describe, expect, it, vi } from "vite-plus/test";
import {
  type CreateSharedWorkerStorageOptions,
  createSharedWorkerStorage,
  type SharedWorkerStorage,
} from "./shared-worker-storage";
import {
  createDeadPort,
  createFakePort,
  fakeSharedWorker,
  withConsoleSpies,
  withLocation,
  withSharedWorker,
} from "./test-utils";

/**
 * The options that decide how long a request may take and which worker it is
 * sent to, and what the client makes of them: what it rejects up front, and what
 * it hands the `SharedWorker` constructor.
 */

/**
 * Every value rejected here is one `setTimeout` accepts and then fires on
 * immediately, so without validation the option would look honoured while every
 * request failed on the next tick - a cache that is simply always cold.
 */
describe("the timeoutMs option", () => {
  const invalid: Array<[label: string, value: number]> = [
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    // One past the largest delay a 32-bit timer can hold, which overflows to 0.
    ["above the timer limit", 2_147_483_648],
  ];

  for (const [label, value] of invalid) {
    it(`throws for a ${label} timeout, naming the option and the range`, () => {
      expect(() => createSharedWorkerStorage({ port: createFakePort(), timeoutMs: value })).toThrow(
        RangeError,
      );
      expect(() => createSharedWorkerStorage({ port: createFakePort(), timeoutMs: value })).toThrow(
        /timeoutMs must be a number greater than 0 and at most 2147483647/,
      );
    });
  }

  it("throws even where SharedWorker is unavailable, so the option is checked everywhere", async () => {
    await withSharedWorker(undefined, () => {
      expect(() => createSharedWorkerStorage({ timeoutMs: 0 })).toThrow(RangeError);
    });
  });

  it("accepts the largest delay a timer can hold", () => {
    const storage = createSharedWorkerStorage({
      port: createFakePort(),
      timeoutMs: 2_147_483_647,
    });
    expect(storage.mode).toBe("shared-worker");
    storage.dispose();
  });

  it("leaves a request pending forever when given Infinity", async () => {
    const storage = createSharedWorkerStorage({
      port: createDeadPort(),
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    const write = Promise.resolve(storage.setItem("k", "v"));
    const settled = vi.fn();
    void write.then(settled, settled);
    // Long enough that any timer the overflow would have created - the 0ms one a
    // raw `setTimeout(fn, Infinity)` produces - would have fired several times.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).not.toHaveBeenCalled();

    // Only disposal settles it, and the write rejects rather than hanging on.
    storage.dispose();
    await expect(write).rejects.toThrow(/disposed/);
  });

  it("still answers a request normally when given Infinity", async () => {
    using storage = createSharedWorkerStorage({
      port: createFakePort(),
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    await storage.setItem("k", "v");
    await expect(storage.getItem("k")).resolves.toBe("v");
  });
});

/**
 * A worker script has to be served from the page's own origin, so a URL on
 * another one can only be a mistake in the option - and the browser's answer to
 * it, a SecurityError out of the constructor, is the same answer it gives an
 * environment that refuses workers outright. Caught here instead, where the
 * option can be named.
 */
describe("the workerUrl option", () => {
  const page = { href: "https://app.test/index.html" };

  it("throws for a cross-origin URL, naming the option and both origins", async () => {
    await withLocation(page, () => {
      const cdn = "https://cdn.test/cache.worker.js";
      expect(() => createSharedWorkerStorage({ workerUrl: cdn })).toThrow(TypeError);
      expect(() => createSharedWorkerStorage({ workerUrl: cdn })).toThrow(
        /workerUrl must be on the page's own origin: the page is https:\/\/app\.test and https:\/\/cdn\.test\/cache\.worker\.js resolves to https:\/\/cdn\.test/,
      );
      // A URL object is the same mistake in the other accepted type.
      expect(() => createSharedWorkerStorage({ workerUrl: new URL(cdn) })).toThrow(TypeError);
    });
  });

  it("accepts a URL on the page's own origin, however it is written", async () => {
    const { FakeSharedWorker } = fakeSharedWorker({ dead: true });
    await withLocation(page, () =>
      withSharedWorker(FakeSharedWorker, () => {
        for (const workerUrl of [
          "/static/cache.worker.js",
          "cache.worker.js",
          "https://app.test/static/cache.worker.js",
          new URL("https://app.test/static/cache.worker.js"),
        ]) {
          const storage = createSharedWorkerStorage({ workerUrl });
          expect(storage.mode).toBe("shared-worker");
          storage.dispose();
        }
      }),
    );
  });

  it("throws even where SharedWorker is unavailable, so the option is checked everywhere", async () => {
    await withLocation(page, () =>
      withSharedWorker(undefined, () => {
        expect(() => createSharedWorkerStorage({ workerUrl: "https://cdn.test/w.js" })).toThrow(
          TypeError,
        );
      }),
    );
  });

  it("holds it against nothing where there is no page", async () => {
    // A server evaluating the module that builds the persister: no origin to
    // compare against, and no worker being constructed either way.
    let storage!: SharedWorkerStorage;
    expect(() => {
      storage = createSharedWorkerStorage({ workerUrl: "https://cdn.test/w.js" });
    }).not.toThrow();
    expect(storage.mode).toBe("noop");
  });

  it("leaves it alone on an opaque origin, where no URL would have worked", async () => {
    // A sandboxed iframe or a `file:` page has no origin to match, and the
    // constructor refuses every worker there. That refusal is the no-op
    // fallback, which serves the caller better than a throw.
    const { FakeSharedWorker } = fakeSharedWorker({ dead: true });
    await withLocation({ href: "file:///app/index.html" }, () =>
      withSharedWorker(FakeSharedWorker, () => {
        expect(() =>
          createSharedWorkerStorage({ workerUrl: "https://cdn.test/w.js" }).dispose(),
        ).not.toThrow();
      }),
    );
  });

  it("leaves a value that is not a URL at all to the constructor", async () => {
    // `new URL("http://[")` throws whatever base it is given, so there is no
    // resolved origin to hold against the page's and nothing this check can say.
    // The browser refuses the same value a moment later, and its refusal already
    // names the option, so the caller is told either way.
    await withConsoleSpies(async ({ warn }) => {
      class ThrowingSharedWorker {
        constructor() {
          throw new DOMException("the URL is invalid", "SyntaxError");
        }
      }
      await withLocation(page, () =>
        withSharedWorker(ThrowingSharedWorker, () => {
          let storage!: SharedWorkerStorage;
          expect(() => {
            storage = createSharedWorkerStorage({ workerUrl: "http://[" });
          }).not.toThrow();
          expect(storage.mode).toBe("noop");
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0]?.[0]).toContain("workerUrl http://[");
        }),
      );
    });
  });

  it("is not checked when a port is injected, since no worker is constructed", async () => {
    await withLocation(page, async () => {
      using storage = createSharedWorkerStorage({
        port: createFakePort(),
        workerUrl: "https://cdn.test/cache.worker.js",
      });
      await storage.setItem("k", "v");
      await expect(storage.getItem("k")).resolves.toBe("v");
    });
  });
});

/**
 * The option's only job is to change the worker's name, and the empty string is
 * the one value that cannot do it: it leaves the storage on the default worker,
 * sharing the store it was passed to stay out of. That reads as a working cache
 * holding somebody else's entries, so it is refused where it is passed.
 */
describe("the namespace option", () => {
  it("throws for an empty namespace, naming the option", () => {
    expect(() => createSharedWorkerStorage({ port: createFakePort(), namespace: "" })).toThrow(
      TypeError,
    );
    expect(() => createSharedWorkerStorage({ port: createFakePort(), namespace: "" })).toThrow(
      /namespace must not be empty/,
    );
  });

  it("throws even where SharedWorker is unavailable, so the option is checked everywhere", async () => {
    await withSharedWorker(undefined, () => {
      expect(() => createSharedWorkerStorage({ namespace: "" })).toThrow(TypeError);
    });
  });

  it("takes an explicit undefined as no namespace at all", async () => {
    // What a caller passing the option conditionally hands over, which asks for
    // the default worker rather than for a name that isn't one.
    using storage = createSharedWorkerStorage({ port: createFakePort(), namespace: undefined });
    expect(storage.mode).toBe("shared-worker");
    await storage.setItem("k", "v");
    await expect(storage.getItem("k")).resolves.toBe("v");
  });
});

describe("the SharedWorker it constructs", () => {
  /** Construct a storage over a recording fake and hand back what it asked for. */
  async function constructionFor(options?: CreateSharedWorkerStorageOptions) {
    const { FakeSharedWorker, constructions } = fakeSharedWorker({ dead: true });
    await withSharedWorker(FakeSharedWorker, () => {
      createSharedWorkerStorage(options).dispose();
    });
    const construction = constructions[0];
    if (!construction) throw new Error("no SharedWorker was constructed");
    return construction;
  }

  it("defaults to the cache.worker.js published beside this module", async () => {
    // Resolved against this module's own URL, which is what the consumer's
    // bundler has to trace in order to copy the asset into its output.
    const { url } = await constructionFor();
    expect(url).toEqual(new URL("./cache.worker.js", import.meta.url));
  });

  it("uses workerUrl instead when one is given", async () => {
    await expect(constructionFor({ workerUrl: "/static/cache.worker.js" })).resolves.toMatchObject({
      url: "/static/cache.worker.js",
    });
    const absolute = new URL("https://example.test/w.js");
    await expect(constructionFor({ workerUrl: absolute })).resolves.toMatchObject({
      url: absolute,
    });
  });

  it("loads the worker as a module", async () => {
    // The worker source imports its store and its connection handling, so it
    // can only run as a module worker; a classic one would fail to parse.
    const { options } = await constructionFor();
    expect(options?.type).toBe("module");
  });

  it("names the worker so every tab reaches the same one", async () => {
    // The name is half the worker's identity, so it has to be spelled the same
    // in every tab, and stay stable across releases - changing it would strand
    // already-open tabs on a worker that nothing new connects to.
    const { options } = await constructionFor();
    expect(options?.name).toBe("TANSTACK_QUERY_SHARED_CACHE_WORKER");
  });

  it("appends a namespace to that name, giving the app a worker of its own", async () => {
    const { options } = await constructionFor({ namespace: "MY_APP" });
    expect(options?.name).toBe("TANSTACK_QUERY_SHARED_CACHE_WORKER:MY_APP");
  });
});
