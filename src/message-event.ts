/**
 * Builders for the events a `PortAdapter` (or a worker-side `WorkerPort`) hands
 * to its handlers. Tests use these instead of casting an object literal into the
 * shape of an event, so what a handler receives is the genuine article.
 *
 * Deliberately free of any DOM dependency: `MessageEvent` exists in both the
 * page and the worker global scopes, which lets the worker's own tests use these
 * without dragging the tab-side (and its `document`) into the worker tsconfig.
 */

/** A real `message` event carrying `data`, as a port delivers it. */
export function messageEvent<T>(data: T): MessageEvent<T> {
  return new MessageEvent<T>("message", { data });
}

/**
 * A real `messageerror` event, the one a port fires when an incoming message
 * cannot be deserialized. It carries no useful `data`, which is the point: the
 * handler only learns that delivery failed.
 */
export function messageErrorEvent(): MessageEvent {
  return new MessageEvent("messageerror");
}
