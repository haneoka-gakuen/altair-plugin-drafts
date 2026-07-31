import type {
  AltairDraftPersistedSession,
  AltairDraftPersistence,
  AltairDraftPersistenceMutationRequest,
  AltairDraftPersistenceRequest,
  AltairIndexedDbDraftPersistenceOptions,
} from "./contracts.js";
import {
  AltairDraftPersistenceConflictError,
  AltairDraftPersistenceError,
  AltairDraftPersistenceUnavailableError,
  normalizeAltairDraftPersistenceError,
} from "./persistence.js";

const DEFAULT_DATABASE_NAME = "haneoka-altair-drafts";
const DEFAULT_STORE_NAME = "sessions";
const DATABASE_VERSION = 1;

const requireStorageName = (value: string, label: string): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(
      `Altair IndexedDB ${label} must contain 1 to 128 visible characters`,
    );
  }
  return value.trim();
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ??
  new DOMException("Altair draft persistence was aborted", "AbortError");

const attachAbort = (
  transaction: IDBTransaction,
  signal: AbortSignal | undefined,
  setFailure: (error: unknown) => void,
): (() => void) => {
  if (!signal) return () => undefined;
  const abort = () => {
    setFailure(abortReason(signal));
    try {
      transaction.abort();
    } catch {
      // The transaction may already be complete.
    }
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
};

const persistedRevision = (value: unknown): number | null => {
  if (value === undefined) return null;
  if (
    !value ||
    typeof value !== "object" ||
    !("revision" in value) ||
    !Number.isSafeInteger(
      (value as { readonly revision?: unknown }).revision,
    ) ||
    Number(
      (value as { readonly revision?: unknown }).revision,
    ) < 1
  ) {
    throw new AltairDraftPersistenceError(
      "invalid-data",
      "Altair IndexedDB contains an invalid draft revision",
    );
  }
  return Number(
    (value as { readonly revision: number }).revision,
  );
};

const assertExpectedRevision = (
  value: unknown,
  expectedRevision: number | null,
  name: string,
): void => {
  const actualRevision = persistedRevision(value);
  if (actualRevision !== expectedRevision) {
    throw new AltairDraftPersistenceConflictError(
      `Altair draft ${JSON.stringify(name)} changed in another writer`,
      expectedRevision,
      actualRevision,
    );
  }
};

class IndexedDbDraftPersistence implements AltairDraftPersistence {
  readonly id: string;
  readonly durable = true;

  readonly #factory: IDBFactory;
  readonly #databaseName: string;
  readonly #storeName: string;
  readonly #pending = new Set<Promise<unknown>>();
  #databasePromise: Promise<IDBDatabase> | undefined;
  #invalidated: AltairDraftPersistenceUnavailableError | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(
    factory: IDBFactory,
    databaseName: string,
    storeName: string,
  ) {
    this.#factory = factory;
    this.#databaseName = databaseName;
    this.#storeName = storeName;
    this.id = `indexeddb:${databaseName}/${storeName}`;
  }

  load(
    name: string,
    request: AltairDraftPersistenceRequest = {},
  ): Promise<AltairDraftPersistedSession | undefined> {
    return this.#track(`loading ${JSON.stringify(name)}`, async () => {
      const database = await this.#database();
      return await new Promise<AltairDraftPersistedSession | undefined>(
        (resolve, reject) => {
          let result: AltairDraftPersistedSession | undefined;
          let failure: unknown;
          let settled = false;
          const transaction = database.transaction(
            this.#storeName,
            "readonly",
          );
          const detachAbort = attachAbort(
            transaction,
            request.signal,
            (error) => {
              failure = error;
            },
          );
          const finish = (
            action: () => void,
          ) => {
            if (settled) return;
            settled = true;
            detachAbort();
            action();
          };
          const loadRequest = transaction
            .objectStore(this.#storeName)
            .get(name);
          loadRequest.onsuccess = () => {
            result = loadRequest.result as
              | AltairDraftPersistedSession
              | undefined;
          };
          transaction.oncomplete = () =>
            finish(() => resolve(result));
          const fail = () =>
            finish(() =>
              reject(
                failure ??
                  transaction.error ??
                  loadRequest.error ??
                  new Error("IndexedDB load transaction aborted"),
              ),
            );
          transaction.onerror = fail;
          transaction.onabort = fail;
        },
      );
    });
  }

  save(
    record: AltairDraftPersistedSession,
    request: AltairDraftPersistenceMutationRequest,
  ): Promise<void> {
    return this.#track(
      `saving ${JSON.stringify(record.name)}`,
      async () => {
        const database = await this.#database();
        await new Promise<void>((resolve, reject) => {
          let failure: unknown;
          let settled = false;
          const transaction = database.transaction(
            this.#storeName,
            "readwrite",
          );
          const detachAbort = attachAbort(
            transaction,
            request.signal,
            (error) => {
              failure = error;
            },
          );
          const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            detachAbort();
            action();
          };
          const store = transaction.objectStore(this.#storeName);
          const currentRequest = store.get(record.name);
          currentRequest.onsuccess = () => {
            try {
              assertExpectedRevision(
                currentRequest.result,
                request.expectedRevision,
                record.name,
              );
              store.put(record);
            } catch (error) {
              failure = error;
              transaction.abort();
            }
          };
          transaction.oncomplete = () => finish(resolve);
          const fail = () =>
            finish(() =>
              reject(
                failure ??
                  transaction.error ??
                  currentRequest.error ??
                  new Error("IndexedDB save transaction aborted"),
              ),
            );
          transaction.onerror = fail;
          transaction.onabort = fail;
        });
      },
    );
  }

  remove(
    name: string,
    request: AltairDraftPersistenceMutationRequest,
  ): Promise<void> {
    return this.#track(`removing ${JSON.stringify(name)}`, async () => {
      const database = await this.#database();
      await new Promise<void>((resolve, reject) => {
        let failure: unknown;
        let settled = false;
        const transaction = database.transaction(
          this.#storeName,
          "readwrite",
        );
        const detachAbort = attachAbort(
          transaction,
          request.signal,
          (error) => {
            failure = error;
          },
        );
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          detachAbort();
          action();
        };
        const store = transaction.objectStore(this.#storeName);
        const currentRequest = store.get(name);
        currentRequest.onsuccess = () => {
          try {
            assertExpectedRevision(
              currentRequest.result,
              request.expectedRevision,
              name,
            );
            if (currentRequest.result !== undefined) store.delete(name);
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        };
        transaction.oncomplete = () => finish(resolve);
        const fail = () =>
          finish(() =>
            reject(
              failure ??
                transaction.error ??
                currentRequest.error ??
                new Error("IndexedDB remove transaction aborted"),
            ),
          );
        transaction.onerror = fail;
        transaction.onabort = fail;
      });
    });
  }

  async flush(): Promise<void> {
    this.#assertActive();
    await this.#waitForPending();
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      let failure: unknown;
      try {
        await this.#waitForPending();
      } catch (error) {
        failure = error;
      }
      if (this.#databasePromise) {
        try {
          (await this.#databasePromise).close();
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) {
        throw normalizeAltairDraftPersistenceError(
          failure,
          "disposing IndexedDB",
        );
      }
    })();
    return this.#disposePromise;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new AltairDraftPersistenceUnavailableError(
        "Altair IndexedDB draft persistence is disposed",
      );
    }
    if (this.#invalidated) throw this.#invalidated;
  }

  #database(): Promise<IDBDatabase> {
    this.#assertActive();
    this.#databasePromise ??= new Promise<IDBDatabase>(
      (resolve, reject) => {
        let settled = false;
        const request = this.#factory.open(
          this.#databaseName,
          DATABASE_VERSION,
        );
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(this.#storeName)) {
            database.createObjectStore(this.#storeName, {
              keyPath: "name",
            });
          }
        };
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          const database = request.result;
          database.onversionchange = () => {
            database.close();
            this.#invalidated =
              new AltairDraftPersistenceUnavailableError(
                "Altair IndexedDB draft database changed version",
              );
          };
          resolve(database);
        };
        request.onerror = () => {
          if (settled) return;
          settled = true;
          reject(
            request.error ??
              new Error("IndexedDB database open failed"),
          );
        };
        request.onblocked = () => {
          if (settled) return;
          settled = true;
          reject(
            new AltairDraftPersistenceUnavailableError(
              "Altair IndexedDB draft database open is blocked",
            ),
          );
        };
      },
    ).catch((error: unknown) => {
      throw normalizeAltairDraftPersistenceError(
        error,
        "opening IndexedDB",
      );
    });
    return this.#databasePromise;
  }

  #track<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    this.#assertActive();
    const promise = Promise.resolve()
      .then(run)
      .catch((error: unknown) => {
        throw normalizeAltairDraftPersistenceError(error, operation);
      });
    this.#pending.add(promise);
    void promise.then(
      () => this.#pending.delete(promise),
      () => this.#pending.delete(promise),
    );
    return promise;
  }

  async #waitForPending(): Promise<void> {
    const pending = [...this.#pending];
    if (pending.length === 0) return;
    const results = await Promise.allSettled(pending);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Multiple Altair IndexedDB draft operations failed",
      );
    }
  }
}

export const createAltairIndexedDbDraftPersistence = (
  options: AltairIndexedDbDraftPersistenceOptions = {},
): AltairDraftPersistence => {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new AltairDraftPersistenceUnavailableError(
      "IndexedDB is unavailable in this environment",
    );
  }
  const databaseName = requireStorageName(
    options.databaseName ?? DEFAULT_DATABASE_NAME,
    "database name",
  );
  const storeName = requireStorageName(
    options.storeName ?? DEFAULT_STORE_NAME,
    "store name",
  );
  return new IndexedDbDraftPersistence(
    factory,
    databaseName,
    storeName,
  );
};
