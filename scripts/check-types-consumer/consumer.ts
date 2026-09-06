// A stand-in for a consumer of the published package: it type checks the built
// declarations in `dist/` under the lib set a typical app has, with
// `skipLibCheck: false` so the declarations are checked rather than trusted.
//
// Chiefly it is here for `Symbol.dispose`, which the public types name but
// `lib: ["ES2022", "DOM"]` does not declare. Compilation only succeeds because
// `dist/index.d.ts` references the `esnext.disposable` lib itself. Drop that
// reference and this file stops compiling.
import {
  createSharedWorkerPersister,
  createSharedWorkerStorage,
  PROTOCOL_VERSION,
} from "../../dist/index.js";

// A value export, not a type: a port implementation stamps its replies with it,
// so it has to reach `dist/` as something a consumer can read at run time rather
// than a type that vanishes. The annotation is the check.
const version: number = PROTOCOL_VERSION;

const storage = createSharedWorkerStorage({ timeoutMs: 5_000 });
await storage.setItem("key", "value");
await storage.setItem("version", String(version));
storage[Symbol.dispose]();

const persister = createSharedWorkerPersister({ namespace: "consumer" });
persister.dispose();
