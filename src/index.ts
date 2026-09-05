export {
  type CreateSharedWorkerPersisterOptions,
  createSharedWorkerPersister,
  type SharedWorkerPersister,
} from "./create-shared-worker-persister";
export {
  type CreateSharedWorkerStorageOptions,
  createSharedWorkerStorage,
  isSharedWorkerSupported,
  type PortAdapter,
  type SharedWorkerStorage,
  SharedWorkerStorageError,
  type SharedWorkerStorageErrorCode,
} from "./shared-worker-storage";
// The wire contract between the storage and the worker. Public because a caller
// supplying its own `PortAdapter` has to speak it; named one by one rather than
// re-exported wholesale so a type added to the protocol module later is a
// deliberate addition to this package's surface, not an automatic one.
export type {
  StorageEntries,
  StorageRequest,
  StorageResponse,
  StorageResult,
} from "./worker/protocol";
