export {
  type CreateSharedWorkerPersisterOptions,
  createSharedWorkerPersister,
  type SharedWorkerPersister,
} from "./create-shared-worker-persister";
export {
  type CreateSharedWorkerQueryPersisterOptions,
  experimental_createSharedWorkerQueryPersister,
  type SharedWorkerQueryPersister,
} from "./create-shared-worker-query-persister";
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
//
// `PROTOCOL_VERSION` is exported for the same reason the shapes are: a port that
// answers on its own has to stamp the version it was built against, or its
// replies are read as version 1 and rejected the moment the protocol moves on.
// `UNVERSIONED_PROTOCOL_VERSION` stays internal — it is what this build assumes
// of a peer too old to say, not something a port should ever send.
export {
  PROTOCOL_VERSION,
  type StorageEntries,
  type StorageRequest,
  type StorageResponse,
  type StorageResult,
} from "./worker/protocol";
