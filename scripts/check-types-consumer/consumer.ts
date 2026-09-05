// A stand-in for a consumer of the published package: it type checks the built
// declarations in `dist/` under the lib set a typical app has, with
// `skipLibCheck: false` so the declarations are checked rather than trusted.
//
// The point of the exercise is `Symbol.dispose`, which the public types name but
// `lib: ["ES2022", "DOM"]` does not declare. Compilation only succeeds because
// `dist/index.d.ts` references the `esnext.disposable` lib itself. Drop that
// reference and this file stops compiling.
import { createSharedWorkerPersister, createSharedWorkerStorage } from "../../dist/index.js";

const storage = createSharedWorkerStorage({ timeoutMs: 5_000 });
await storage.setItem("key", "value");
storage[Symbol.dispose]();

const persister = createSharedWorkerPersister({ namespace: "consumer" });
persister.dispose();
