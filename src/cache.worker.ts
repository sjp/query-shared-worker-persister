/// <reference lib="webworker" />

import { handleConnect } from "./worker/connection";
import { CacheStore } from "./worker/store";

/**
 * The SharedWorker process. A single instance is shared by every same-origin
 * tab; the browser keeps it alive only while at least one tab is connected and
 * terminates it (dropping `store` with it) when the last tab closes. That is
 * what ties the cache's lifetime to the number of open tabs.
 *
 * Its sole job is to hold the one shared {@link CacheStore} and hand each newly
 * connected port to {@link handleConnect}, which answers storage requests on it.
 */

// `self` in a SharedWorker is a SharedWorkerGlobalScope. We cast rather than
// redeclare to avoid clashing with the ambient `self` from the DOM lib.
const ctx = self as unknown as SharedWorkerGlobalScope;

const store = new CacheStore();

ctx.onconnect = (event: MessageEvent) => handleConnect(store, event.ports[0]);
