// A stand-in for a consumer of the published package: it type checks the built
// declarations in `dist/` under the lib set a typical app has, with
// `skipLibCheck: false` so the declarations are checked rather than trusted.
// Nothing here runs — it is compiled with `noEmit` and never executed.
//
// Chiefly it is here for `Symbol.dispose`, which the public types name but
// `lib: ["ES2022", "DOM"]` does not declare. Compilation only succeeds because
// `dist/index.d.ts` references the `esnext.disposable` lib itself. Drop that
// reference and this file stops compiling.
//
// Beyond that it touches every named export at least once, in the way the
// README shows, so an export that is renamed or dropped fails here rather than
// in an application. It is compiled twice, under the two configurations beside
// it: once as an ordinary consumer, and once with `exactOptionalPropertyTypes`
// and `noUncheckedIndexedAccess` on, which is the pass that sees an option
// whose type stopped saying `| undefined`.
import {
  type CreateSharedWorkerPersisterOptions,
  type CreateSharedWorkerQueryPersisterOptions,
  type CreateSharedWorkerStorageOptions,
  createSharedWorkerPersister,
  createSharedWorkerStorage,
  experimental_createSharedWorkerQueryPersister,
  isSharedWorkerSupported,
  type PortAdapter,
  PROTOCOL_VERSION,
  type SharedWorkerPersister,
  type SharedWorkerQueryPersister,
  type SharedWorkerStorage,
  SharedWorkerStorageError,
  type SharedWorkerStorageErrorCode,
  type StorageEntries,
  type StorageRequest,
  type StorageResponse,
  type StorageResult,
} from "../../dist/index.js";

// A value export, not a type: a port implementation stamps its replies with it,
// so it has to reach `dist/` as something a consumer can read at run time rather
// than a type that vanishes. The annotation is the check.
const version: number = PROTOCOL_VERSION;

const supported: boolean = isSharedWorkerSupported();

// A port that answers on its own, as the README's does. Writing the request and
// response shapes out by hand is what pins them: a field renamed on either side
// of the wire contract stops this from being a `PortAdapter` at all.
const port: PortAdapter = {
  onmessage: null,
  postMessage(request: StorageRequest) {
    const entries: StorageEntries = [["key", "value"]];
    const result: StorageResult = request.op === "entries" ? entries : null;
    const response: StorageResponse = {
      kind: "response",
      id: request.id,
      ok: true,
      result,
      version,
    };
    port.onmessage?.({ data: response } as MessageEvent<StorageResponse>);
  },
  close() {},
};

// Reporting is where a consumer branches on the cause, so the narrowing on
// `code` has to survive a rebuild.
const report = (error: SharedWorkerStorageError) => {
  switch (error.code) {
    case "unsupported":
    case "transport":
      console.warn(error.message, error.cause);
      break;
    case "timeout":
    case "protocol":
    case "disposed":
      console.debug(error.message);
      break;
  }
};

declare const configured: boolean;

// Options an application assembles conditionally, which is the ordinary case:
// a namespace read from configuration, a signal only where there is a lifetime
// to hang on. Every value here is `T | undefined`, so under
// `exactOptionalPropertyTypes` these objects only stay assignable while each
// option's type spells out `| undefined` alongside its `?`.
const shared = {
  timeoutMs: configured ? 5_000 : undefined,
  namespace: configured ? "consumer" : undefined,
  workerUrl: configured ? new URL("cache.worker.js", location.href) : undefined,
  signal: configured ? AbortSignal.timeout(60_000) : undefined,
  port: configured ? port : undefined,
  onError: configured ? report : undefined,
};

const storageOptions: CreateSharedWorkerStorageOptions = {
  ...shared,
  entriesPrefix: configured ? "consumer-" : undefined,
};

const storage: SharedWorkerStorage = createSharedWorkerStorage(storageOptions);

if (storage.mode === "shared-worker") {
  const stored: string | null | undefined = await storage.getItem("key");
  for (const [key, value] of await storage.entries()) {
    console.debug(key, value, stored);
  }
  // Under `noUncheckedIndexedAccess` a listing read by position may be empty,
  // so the optional chaining is what a strict consumer has to write.
  const [first] = await storage.entries();
  console.debug(first?.[0]);
  await storage.removeItem("key");
}

// A failed write rejects with the error a report would have carried, so the
// `instanceof` narrowing a `retry` hook does has to reach `code` too.
try {
  await storage.setItem("key", "value");
} catch (error) {
  if (error instanceof SharedWorkerStorageError) {
    const code: SharedWorkerStorageErrorCode = error.code;
    console.debug(code);
  }
}

storage[Symbol.dispose]();

const persisterOptions: CreateSharedWorkerPersisterOptions = { ...shared };
const persister: SharedWorkerPersister = createSharedWorkerPersister(persisterOptions);
if (!supported || persister.mode === "noop") persister.dispose();

const queryPersisterOptions: CreateSharedWorkerQueryPersisterOptions = {
  ...shared,
  prefix: "consumer",
};

// A persister whose lifetime is a block, released on the way out by the
// well-known symbol rather than a call.
{
  using queryPersister: SharedWorkerQueryPersister =
    experimental_createSharedWorkerQueryPersister(queryPersisterOptions);
  const queryStorage: SharedWorkerStorage = queryPersister.storage;
  console.debug(queryPersister.mode, queryStorage.mode);
}
