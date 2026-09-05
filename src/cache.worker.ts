/// <reference lib="webworker" />

import { handleConnect } from "./worker/connection";
import { CacheStore } from "./worker/store";

// A SharedWorker's global scope is a `SharedWorkerGlobalScope`, but this file is
// type checked alongside code that needs the DOM lib, where the ambient `self` is
// a `Window`. Declaring it here shadows that ambient binding for this module
// only; the declaration is erased, so at runtime this is still the real global.
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

// A connect event always carries the tab's port, but the index access can't say
// so; `handleConnect` treats a missing port as nothing to wire up.
self.onconnect = (event: MessageEvent) => handleConnect(store, event.ports[0]);
