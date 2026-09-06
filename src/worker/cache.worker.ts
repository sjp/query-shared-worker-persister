import { handleConnect } from "./connection";
import { CacheStore } from "./store";

declare const self: SharedWorkerGlobalScope;

/**
 * The SharedWorker process. A single instance is shared by every same-origin
 * tab; the browser keeps it alive only while at least one tab is connected and
 * terminates it (dropping `store` with it) when the last tab closes. That is
 * what ties the cache's lifetime to the number of open tabs.
 *
 * Its sole job is to hold the one shared {@link CacheStore} and hand each newly
 * connected port to {@link handleConnect}, which answers storage requests on it.
 */
const store = new CacheStore();

self.onconnect = (event: MessageEvent) => handleConnect(store, event.ports[0]);
