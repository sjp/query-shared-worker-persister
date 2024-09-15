// storage.ts
import { wrap } from "comlink";
import type {
  AsyncStorage,
  PersistedClient,
} from "@tanstack/react-query-persist-client";

export const createSharedStorage = (
  worker: SharedWorker
): AsyncStorage<PersistedClient> => {
  return wrap(worker.port);
};

export const createSharedWorker = (): SharedWorker => {
  return new SharedWorker(new URL("./storage.worker.ts", import.meta.url), {
    type: "module",
  });
};
