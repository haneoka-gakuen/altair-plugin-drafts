import type { JsonValue } from "@haneoka/altair/model";
import {
  defineAltairPlugin,
  defineAltairService,
  type AltairPluginV2,
} from "@haneoka/altair/plugins";
import type {
  AltairDraftBase,
  AltairDraftConflict,
  AltairDraftCurrentProject,
  AltairDraftPendingStatus,
  AltairDraftPersistedSession,
  AltairDraftPersistence,
  AltairDraftPersistenceInfo,
  AltairDraftRecord,
  AltairDraftService,
  AltairDraftServiceOptions,
  AltairDraftSession,
  AltairDraftSessionSeed,
  AltairDraftSessionSnapshot,
  AltairDraftStatus,
  AltairDraftsPluginOptions,
  AltairProjectDraftUpdate,
  AltairSceneDraftReconciliation,
  AltairSceneDraftRecord,
  AltairSceneDraftUpdate,
} from "./contracts.js";
import {
  AltairDraftPersistenceError,
  normalizeAltairDraftPersistenceError,
} from "./persistence.js";
import {
  altairDraftBaseForValue,
  altairDraftConflict,
  hasPendingAltairDrafts,
  hasPendingStoryCodeDrafts,
  reconcileAltairSceneDraft,
  reconcileStorySceneCodeDraft,
  storyJsonDraftBaseForValue,
  storyJsonDraftConflict,
} from "./reconciliation.js";

export * from "./contracts.js";
export * from "./indexeddb.js";
export * from "./persistence.js";
export * from "./reconciliation.js";

export const ALTAIR_DRAFT_SERVICE_ID = "haneoka.altair.drafts";

export const ALTAIR_DRAFT_SERVICE = defineAltairService<AltairDraftService>(
  ALTAIR_DRAFT_SERVICE_ID,
);

const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_MAX_SCENES_PER_SESSION = 512;
const DEFAULT_MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_NAME_LENGTH = 64;
const MAX_SCENE_ID_LENGTH = 256;

interface MutableDraftRecord {
  value: string;
  base?: AltairDraftBase;
}

interface MutableSceneDraftRecord extends MutableDraftRecord {
  sceneId: string;
  context?: JsonValue;
}

interface DraftState {
  project: MutableDraftRecord | undefined;
  scenes: Map<string, MutableSceneDraftRecord>;
}

interface DraftLimits {
  readonly maxScenesPerSession: number;
  readonly maxSessionBytes: number;
}

const volatilePersistenceInfo = Object.freeze({
  id: "memory",
  durable: false,
} satisfies AltairDraftPersistenceInfo);

class DraftSession implements AltairDraftSession {
  readonly name: string;

  #state: DraftState;
  #persistenceRevision: number | null;
  #tail = Promise.resolve();
  #accepting = true;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(
    name: string,
    state: DraftState,
    persistenceRevision: number | null,
    private readonly limits: DraftLimits,
    private readonly persistence: AltairDraftPersistence | undefined,
    private readonly onDispose: (session: DraftSession) => void,
  ) {
    this.name = name;
    this.#state = state;
    this.#persistenceRevision = persistenceRevision;
    assertWithinLimits(name, state, limits);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get persistenceRevision(): number | null {
    this.#assertReadable();
    return this.#persistenceRevision;
  }

  updateProject(update: AltairProjectDraftUpdate): Promise<void> {
    return this.#mutate("updating the project draft", (state) => {
      const baseline = requireText(update.baseline, "project baseline");
      const value = requireText(update.value, "project draft");
      const revision = requireRevision(update.revision);
      const previous = state.project;
      state.project =
        value === baseline
          ? undefined
          : {
              value,
              base: previous?.base ?? frozenBase(baseline, revision),
            };
    });
  }

  clearProject(): Promise<void> {
    return this.#mutate("clearing the project draft", (state) => {
      state.project = undefined;
    });
  }

  updateScene(update: AltairSceneDraftUpdate): Promise<void> {
    return this.#mutate("updating a scene draft", (state) => {
      const sceneId = requireSceneId(update.sceneId);
      const baseline = requireText(update.baseline, "scene baseline");
      const value = requireText(update.value, "scene draft");
      const projectSnapshot = requireText(
        update.projectSnapshot,
        "scene project snapshot",
      );
      const projectRevision = requireRevision(update.projectRevision);
      const previous = state.scenes.get(sceneId);
      if (value === baseline) {
        state.scenes.delete(sceneId);
        return;
      }
      if (!previous && state.scenes.size >= this.limits.maxScenesPerSession) {
        throw new Error(
          `Altair draft session ${JSON.stringify(this.name)} reached its ${this.limits.maxScenesPerSession} scene limit`,
        );
      }
      const context =
        update.context === undefined
          ? previous?.context
          : copyJson(
              update.context,
              `scene ${JSON.stringify(sceneId)} context`,
            );
      state.scenes.set(sceneId, {
        sceneId,
        value,
        base: previous?.base ?? frozenBase(projectSnapshot, projectRevision),
        ...(context === undefined ? {} : { context }),
      });
    });
  }

  clearScene(sceneIdValue: string): Promise<void> {
    return this.#mutate("clearing a scene draft", (state) => {
      state.scenes.delete(requireSceneId(sceneIdValue));
    });
  }

  reconcileScene(
    sceneIdValue: string,
    baselineValue: string,
  ): Promise<AltairSceneDraftReconciliation> {
    const sceneId = requireSceneId(sceneIdValue);
    const baseline = requireText(baselineValue, "scene baseline");
    return this.#enqueue(async () => {
      const record = this.#state.scenes.get(sceneId);
      if (!record) {
        return freezeResult({
          sceneId,
          value: baseline,
          pending: false,
        });
      }
      if (record.value !== baseline) {
        return reconciliation(record);
      }
      const candidate = cloneState(this.#state);
      candidate.scenes.delete(sceneId);
      const nextRevision = await persistState(
        this.name,
        candidate,
        this.#persistenceRevision,
        this.persistence,
        "reconciling a scene draft",
      );
      this.#state = candidate;
      this.#persistenceRevision = nextRevision;
      return freezeResult({
        sceneId,
        value: baseline,
        pending: false,
      });
    });
  }

  pending(): AltairDraftPendingStatus {
    this.#assertReadable();
    return pendingStatus(this.#state);
  }

  status(currentValue: AltairDraftCurrentProject): AltairDraftStatus {
    this.#assertReadable();
    const current = normalizeCurrent(currentValue);
    const pending = pendingStatus(this.#state);
    const conflict = detectConflict(this.#state, current);
    return freezeResult({
      ...pending,
      ...(conflict === undefined ? {} : { conflict }),
    });
  }

  snapshot(): AltairDraftSessionSnapshot {
    this.#assertReadable();
    return sessionSnapshot(this.name, this.#state, this.#persistenceRevision);
  }

  reload(): Promise<AltairDraftSessionSnapshot> {
    return this.#enqueue(async () => {
      if (!this.persistence) return this.snapshot();
      const loaded = await persistenceOperation(
        "reloading a draft session",
        () => this.persistence!.load(this.name),
      );
      const normalized =
        loaded === undefined
          ? { state: emptyState(), revision: null }
          : normalizePersistedSession(loaded, this.name, this.limits);
      this.#state = normalized.state;
      this.#persistenceRevision = normalized.revision;
      return this.snapshot();
    });
  }

  async flush(): Promise<void> {
    this.#assertReadable();
    const queued = this.#tail;
    await queued;
    if (this.persistence?.flush) {
      await persistenceOperation("flushing a draft session", () =>
        this.persistence!.flush!(),
      );
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#accepting = false;
    this.#disposePromise = (async () => {
      let failure: unknown;
      try {
        await this.#tail;
        if (this.persistence?.flush) {
          await persistenceOperation("flushing a disposed draft session", () =>
            this.persistence!.flush!(),
          );
        }
      } catch (error) {
        failure = error;
      } finally {
        this.#disposed = true;
        this.#state = emptyState();
        this.onDispose(this);
      }
      if (failure !== undefined) throw failure;
    })();
    return this.#disposePromise;
  }

  #mutate(
    operation: string,
    mutate: (state: DraftState) => void,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const candidate = cloneState(this.#state);
      mutate(candidate);
      assertWithinLimits(this.name, candidate, this.limits);
      if (sameState(candidate, this.#state)) return;
      const nextRevision = await persistState(
        this.name,
        candidate,
        this.#persistenceRevision,
        this.persistence,
        operation,
      );
      this.#state = candidate;
      this.#persistenceRevision = nextRevision;
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#accepting || this.#disposed) {
      return Promise.reject(
        new Error(
          `Altair draft session ${JSON.stringify(this.name)} is disposed`,
        ),
      );
    }
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertReadable(): void {
    if (this.#disposed) {
      throw new Error(
        `Altair draft session ${JSON.stringify(this.name)} is disposed`,
      );
    }
  }
}

class DraftService implements AltairDraftService {
  readonly altairDraftBaseForValue = altairDraftBaseForValue;
  readonly altairDraftConflict = altairDraftConflict;
  readonly hasPendingAltairDrafts = hasPendingAltairDrafts;
  readonly reconcileAltairSceneDraft = reconcileAltairSceneDraft;
  readonly storyJsonDraftBaseForValue = storyJsonDraftBaseForValue;
  readonly storyJsonDraftConflict = storyJsonDraftConflict;
  readonly hasPendingStoryCodeDrafts = hasPendingStoryCodeDrafts;
  readonly reconcileStorySceneCodeDraft = reconcileStorySceneCodeDraft;
  readonly maxSessions: number;
  readonly persistence: AltairDraftPersistenceInfo;

  readonly #limits: DraftLimits;
  readonly #adapter: AltairDraftPersistence | undefined;
  readonly #sessions = new Map<string, DraftSession>();
  readonly #openingNames = new Set<string>();
  readonly #openOperations = new Set<Promise<unknown>>();
  #disposed = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: AltairDraftServiceOptions) {
    this.maxSessions = boundedInteger(
      options.maxSessions,
      DEFAULT_MAX_SESSIONS,
      1,
      128,
      "maxSessions",
    );
    this.#limits = Object.freeze({
      maxScenesPerSession: boundedInteger(
        options.maxScenesPerSession,
        DEFAULT_MAX_SCENES_PER_SESSION,
        1,
        4096,
        "maxScenesPerSession",
      ),
      maxSessionBytes: boundedInteger(
        options.maxSessionBytes,
        DEFAULT_MAX_SESSION_BYTES,
        1024,
        64 * 1024 * 1024,
        "maxSessionBytes",
      ),
    });
    this.#adapter =
      options.persistence === undefined
        ? undefined
        : requirePersistence(options.persistence);
    this.persistence =
      this.#adapter === undefined
        ? volatilePersistenceInfo
        : Object.freeze({
            id: this.#adapter.id,
            durable: this.#adapter.durable,
          });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  open(
    nameValue: string,
    seed?: AltairDraftSessionSeed,
  ): Promise<AltairDraftSession> {
    this.#assertActive();
    const name = requireSessionName(nameValue);
    if (this.#sessions.has(name) || this.#openingNames.has(name)) {
      return Promise.reject(
        new Error(`Altair draft session already exists: ${name}`),
      );
    }
    if (this.#sessions.size + this.#openingNames.size >= this.maxSessions) {
      return Promise.reject(
        new Error(
          `Altair draft service reached its ${this.maxSessions} session limit`,
        ),
      );
    }
    this.#openingNames.add(name);
    const operation = this.#openNow(name, seed).finally(() => {
      this.#openingNames.delete(name);
      this.#openOperations.delete(operation);
    });
    this.#openOperations.add(operation);
    return operation;
  }

  get(nameValue: string): AltairDraftSession | undefined {
    this.#assertActive();
    return this.#sessions.get(requireSessionName(nameValue));
  }

  names(): readonly string[] {
    this.#assertActive();
    return Object.freeze([...this.#sessions.keys()].sort());
  }

  async close(nameValue: string): Promise<boolean> {
    this.#assertActive();
    const session = this.#sessions.get(requireSessionName(nameValue));
    if (!session) return false;
    await session.dispose();
    return true;
  }

  async flush(): Promise<void> {
    this.#assertActive();
    const results = await Promise.allSettled([
      ...this.#openOperations,
      ...[...this.#sessions.values()].map((session) => session.flush()),
      ...(this.#adapter?.flush
        ? [
            persistenceOperation("flushing the draft service", () =>
              this.#adapter!.flush!(),
            ),
          ]
        : []),
    ]);
    throwSettledFailures(results, "Failed to flush Altair drafts");
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      const opening = await Promise.allSettled([...this.#openOperations]);
      const sessions = await Promise.allSettled(
        [...this.#sessions.values()].map((session) => session.dispose()),
      );
      const adapter: PromiseSettledResult<unknown>[] = [];
      if (this.#adapter?.flush) {
        adapter.push(
          await settlePromise(
            persistenceOperation("flushing the disposed draft service", () =>
              this.#adapter!.flush!(),
            ),
          ),
        );
      }
      if (this.#adapter?.dispose) {
        adapter.push(
          await settlePromise(
            persistenceOperation("disposing draft persistence", () =>
              this.#adapter!.dispose!(),
            ),
          ),
        );
      }
      this.#sessions.clear();
      throwSettledFailures(
        [...opening, ...sessions, ...adapter],
        "Failed to dispose Altair drafts",
      );
    })();
    return this.#disposePromise;
  }

  async #openNow(
    name: string,
    fallbackSeed: AltairDraftSessionSeed | undefined,
  ): Promise<AltairDraftSession> {
    let state: DraftState;
    let revision: number | null = null;
    if (this.#adapter) {
      const loaded = await persistenceOperation("loading a draft session", () =>
        this.#adapter!.load(name),
      );
      if (loaded !== undefined) {
        const normalized = normalizePersistedSession(
          loaded,
          name,
          this.#limits,
        );
        state = normalized.state;
        revision = normalized.revision;
      } else {
        state = stateFromSeed(fallbackSeed);
        assertWithinLimits(name, state, this.#limits);
        if (statePending(state)) {
          revision = await persistState(
            name,
            state,
            null,
            this.#adapter,
            "persisting an initial draft seed",
          );
        }
      }
    } else {
      state = stateFromSeed(fallbackSeed);
      assertWithinLimits(name, state, this.#limits);
    }
    if (this.#disposed) {
      throw new Error("Altair draft service is disposed");
    }
    const session = new DraftSession(
      name,
      state,
      revision,
      this.#limits,
      this.#adapter,
      (disposed) => {
        if (this.#sessions.get(disposed.name) === disposed) {
          this.#sessions.delete(disposed.name);
        }
      },
    );
    this.#sessions.set(name, session);
    return session;
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error("Altair draft service is disposed");
    }
  }
}

export const createAltairDraftService = (
  options: AltairDraftServiceOptions = {},
): AltairDraftService => new DraftService(options);

export const createAltairDraftsPlugin = (
  options: AltairDraftsPluginOptions = {},
): AltairPluginV2 => {
  if (
    options.persistenceFactory !== undefined &&
    typeof options.persistenceFactory !== "function"
  ) {
    throw new TypeError("Altair draft persistenceFactory must be a function");
  }
  const serviceOptions = Object.freeze({
    ...(options.maxSessions === undefined
      ? {}
      : { maxSessions: options.maxSessions }),
    ...(options.maxScenesPerSession === undefined
      ? {}
      : { maxScenesPerSession: options.maxScenesPerSession }),
    ...(options.maxSessionBytes === undefined
      ? {}
      : { maxSessionBytes: options.maxSessionBytes }),
  });
  const persistenceFactory = options.persistenceFactory;
  return defineAltairPlugin({
    manifest: {
      id: "haneoka.altair-drafts",
      name: "Altair Drafts",
      version: "0.1.0",
      apiVersion: 2,
      description:
        "Bounded, optionally persistent draft sessions for Altair editors",
      capabilities: ["services"],
    },
    setup(context) {
      const persistence = persistenceFactory?.();
      const service = context.use(
        createAltairDraftService({
          ...serviceOptions,
          ...(persistence === undefined ? {} : { persistence }),
        }),
      );
      context.provide(ALTAIR_DRAFT_SERVICE, service);
    },
  });
};

export const altairDraftsPlugin = createAltairDraftsPlugin();

export default altairDraftsPlugin;

const requirePersistence = (
  persistence: AltairDraftPersistence,
): AltairDraftPersistence => {
  if (!persistence || typeof persistence !== "object") {
    throw new TypeError("Altair draft persistence must be an object");
  }
  if (
    typeof persistence.id !== "string" ||
    !persistence.id.trim() ||
    persistence.id.length > 256
  ) {
    throw new TypeError("Altair draft persistence id is invalid");
  }
  if (typeof persistence.durable !== "boolean") {
    throw new TypeError(
      "Altair draft persistence durable flag must be boolean",
    );
  }
  for (const method of ["load", "save", "remove"] as const) {
    if (typeof persistence[method] !== "function") {
      throw new TypeError(
        `Altair draft persistence ${method} must be a function`,
      );
    }
  }
  for (const method of ["flush", "dispose"] as const) {
    if (
      persistence[method] !== undefined &&
      typeof persistence[method] !== "function"
    ) {
      throw new TypeError(
        `Altair draft persistence ${method} must be a function`,
      );
    }
  }
  return persistence;
};

const emptyState = (): DraftState => ({
  project: undefined,
  scenes: new Map(),
});

const stateFromSeed = (
  seed: AltairDraftSessionSeed | undefined,
): DraftState => {
  if (seed !== undefined && (!seed || typeof seed !== "object")) {
    throw new TypeError("Altair draft seed must be an object");
  }
  const state = emptyState();
  if (seed?.project !== undefined) {
    state.project = copyDraftRecord(seed.project, "project draft");
  }
  if (seed?.scenes !== undefined && !Array.isArray(seed.scenes)) {
    throw new TypeError("Altair draft seed scenes must be an array");
  }
  for (const scene of seed?.scenes ?? []) {
    const record = copySceneDraftRecord(scene);
    if (state.scenes.has(record.sceneId)) {
      throw new Error(
        `Altair draft seed repeats scene ${JSON.stringify(record.sceneId)}`,
      );
    }
    state.scenes.set(record.sceneId, record);
  }
  return state;
};

const cloneState = (state: DraftState): DraftState =>
  stateFromSeed(seedFromState(state));

const seedFromState = (state: DraftState): AltairDraftSessionSeed =>
  freezeResult({
    ...(state.project === undefined
      ? {}
      : { project: snapshotDraftRecord(state.project) }),
    scenes: [...state.scenes.values()]
      .sort((left, right) => left.sceneId.localeCompare(right.sceneId))
      .map(snapshotSceneDraftRecord),
  });

const sameState = (left: DraftState, right: DraftState): boolean =>
  JSON.stringify(seedFromState(left)) === JSON.stringify(seedFromState(right));

const statePending = (state: DraftState): boolean =>
  state.project !== undefined || state.scenes.size > 0;

const persistState = async (
  name: string,
  state: DraftState,
  expectedRevision: number | null,
  persistence: AltairDraftPersistence | undefined,
  operation: string,
): Promise<number | null> => {
  if (!persistence) return null;
  if (!statePending(state) && expectedRevision === null) return null;
  const revision = (expectedRevision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new AltairDraftPersistenceError(
      "invalid-data",
      `Altair draft ${JSON.stringify(name)} exhausted persistence revisions`,
    );
  }
  const record = freezeResult({
    format: "altair-draft-session",
    formatVersion: 1,
    name,
    revision,
    seed: seedFromState(state),
  } satisfies AltairDraftPersistedSession);
  await persistenceOperation(operation, () =>
    persistence.save(record, { expectedRevision }),
  );
  return revision;
};

const normalizePersistedSession = (
  value: AltairDraftPersistedSession,
  expectedName: string,
  limits: DraftLimits,
): { readonly state: DraftState; readonly revision: number } => {
  if (!value || typeof value !== "object") {
    throw new AltairDraftPersistenceError(
      "invalid-data",
      "Altair persisted draft session must be an object",
    );
  }
  if (value.format !== "altair-draft-session" || value.formatVersion !== 1) {
    throw new AltairDraftPersistenceError(
      "invalid-data",
      "Altair persisted draft session has an unsupported format",
    );
  }
  const name = requireSessionName(value.name);
  if (name !== expectedName) {
    throw new AltairDraftPersistenceError(
      "invalid-data",
      `Altair persisted draft name ${JSON.stringify(name)} does not match ${JSON.stringify(expectedName)}`,
    );
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new AltairDraftPersistenceError(
      "invalid-data",
      "Altair persisted draft revision must be a positive safe integer",
    );
  }
  const state = stateFromSeed(value.seed);
  assertWithinLimits(name, state, limits);
  return { state, revision: value.revision };
};

const persistenceOperation = async <T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw normalizeAltairDraftPersistenceError(error, operation);
  }
};

const throwSettledFailures = (
  results: readonly PromiseSettledResult<unknown>[],
  message: string,
): void => {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
};

const settlePromise = async (
  promise: Promise<unknown>,
): Promise<PromiseSettledResult<unknown>> =>
  (await Promise.allSettled([promise]))[0]!;

const sessionSnapshot = (
  name: string,
  state: DraftState,
  persistenceRevision: number | null,
): AltairDraftSessionSnapshot =>
  freezeResult({
    name,
    persistenceRevision,
    ...(state.project === undefined
      ? {}
      : { project: snapshotDraftRecord(state.project) }),
    scenes: [...state.scenes.values()]
      .sort((left, right) => left.sceneId.localeCompare(right.sceneId))
      .map(snapshotSceneDraftRecord),
    status: pendingStatus(state),
  });

const reconciliation = (
  record: MutableSceneDraftRecord,
): AltairSceneDraftReconciliation =>
  freezeResult({
    sceneId: record.sceneId,
    value: record.value,
    pending: true,
    ...(record.context === undefined
      ? {}
      : { context: copyJson(record.context, "scene context") }),
    ...(record.base === undefined ? {} : { base: copyBase(record.base) }),
  });

const detectConflict = (
  state: DraftState,
  current: Required<
    Pick<AltairDraftCurrentProject, "snapshot" | "revision">
  > & { readonly nextSceneIds?: readonly string[] },
): AltairDraftConflict | undefined => {
  const records = [
    ...(state.project === undefined ? [] : [state.project]),
    ...state.scenes.values(),
  ];
  if (records.length === 0) return undefined;
  if (records.some(({ base }) => base === undefined)) {
    return "missing-base";
  }
  if (
    records.some(
      ({ base }) =>
        base!.snapshot !== current.snapshot ||
        base!.revision !== current.revision,
    )
  ) {
    return "project-changed";
  }
  if (current.nextSceneIds !== undefined) {
    const nextSceneIds = new Set(current.nextSceneIds);
    if (
      [...state.scenes.keys()].some((sceneId) => !nextSceneIds.has(sceneId))
    ) {
      return "scene-draft-orphaned";
    }
  }
  return undefined;
};

const pendingStatus = (state: DraftState): AltairDraftPendingStatus =>
  freezeResult({
    pending: statePending(state),
    project: state.project !== undefined,
    sceneIds: [...state.scenes.keys()].sort(),
  });

const normalizeCurrent = (
  value: AltairDraftCurrentProject,
): Required<Pick<AltairDraftCurrentProject, "snapshot" | "revision">> & {
  readonly nextSceneIds?: readonly string[];
} => {
  if (!value || typeof value !== "object") {
    throw new TypeError("Altair current project must be an object");
  }
  const snapshot = requireText(value.snapshot, "current project snapshot");
  const revision = requireRevision(value.revision);
  if (value.nextSceneIds === undefined) return { snapshot, revision };
  if (!Array.isArray(value.nextSceneIds)) {
    throw new TypeError("Altair next scene ids must be an array");
  }
  const nextSceneIds = value.nextSceneIds.map(requireSceneId);
  if (new Set(nextSceneIds).size !== nextSceneIds.length) {
    throw new TypeError("Altair next scene ids must be unique");
  }
  return {
    snapshot,
    revision,
    nextSceneIds: Object.freeze(nextSceneIds),
  };
};

const copyDraftRecord = (
  record: AltairDraftRecord,
  label: string,
): MutableDraftRecord => {
  if (!record || typeof record !== "object") {
    throw new TypeError(`Altair ${label} must be an object`);
  }
  return {
    value: requireText(record.value, `${label} value`),
    ...(record.base === undefined ? {} : { base: copyBase(record.base) }),
  };
};

const copySceneDraftRecord = (
  record: AltairSceneDraftRecord,
): MutableSceneDraftRecord => {
  const draft = copyDraftRecord(record, "scene draft");
  const sceneId = requireSceneId(record.sceneId);
  return {
    sceneId,
    ...draft,
    ...(record.context === undefined
      ? {}
      : {
          context: copyJson(
            record.context,
            `scene ${JSON.stringify(sceneId)} context`,
          ),
        }),
  };
};

const snapshotDraftRecord = (record: MutableDraftRecord): AltairDraftRecord =>
  freezeResult({
    value: record.value,
    ...(record.base === undefined ? {} : { base: copyBase(record.base) }),
  });

const snapshotSceneDraftRecord = (
  record: MutableSceneDraftRecord,
): AltairSceneDraftRecord =>
  freezeResult({
    sceneId: record.sceneId,
    value: record.value,
    ...(record.base === undefined ? {} : { base: copyBase(record.base) }),
    ...(record.context === undefined
      ? {}
      : { context: copyJson(record.context, "scene context") }),
  });

const copyBase = (base: AltairDraftBase): AltairDraftBase => {
  if (!base || typeof base !== "object") {
    throw new TypeError("Altair draft base must be an object");
  }
  return frozenBase(
    requireText(base.snapshot, "draft base snapshot"),
    requireRevision(base.revision),
  );
};

const frozenBase = (snapshot: string, revision: number): AltairDraftBase =>
  Object.freeze({ snapshot, revision });

const requireText = (value: string, label: string): string => {
  if (typeof value !== "string") {
    throw new TypeError(`Altair ${label} must be a string`);
  }
  return value;
};

const requireRevision = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      "Altair draft revision must be a non-negative safe integer",
    );
  }
  return value;
};

const requireSessionName = (value: string): string => {
  if (typeof value !== "string") {
    throw new TypeError("Altair draft session name must be a string");
  }
  const name = value.normalize("NFKC").trim();
  if (
    name.length === 0 ||
    name.length > MAX_SESSION_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new TypeError(
      `Altair draft session name must contain 1-${MAX_SESSION_NAME_LENGTH} visible characters`,
    );
  }
  return name;
};

const requireSceneId = (value: string): string => {
  if (typeof value !== "string") {
    throw new TypeError("Altair scene id must be a string");
  }
  const sceneId = value.trim();
  if (
    sceneId.length === 0 ||
    sceneId.length > MAX_SCENE_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(sceneId)
  ) {
    throw new TypeError(
      `Altair scene id must contain 1-${MAX_SCENE_ID_LENGTH} visible characters`,
    );
  }
  return sceneId;
};

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(
      `Altair ${label} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return result;
};

const copyJson = <T extends JsonValue>(value: T, label: string): T => {
  const seen = new Set<object>();
  const visit = (input: JsonValue, path: string): JsonValue => {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new TypeError(`Altair ${path} contains a non-finite number`);
      }
      return input;
    }
    if (typeof input !== "object") {
      throw new TypeError(`Altair ${path} is not JSON`);
    }
    if (seen.has(input)) {
      throw new TypeError(`Altair ${path} contains a cycle`);
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return input.map((entry, index) => visit(entry, `${path}[${index}]`));
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`Altair ${path} must be a plain JSON object`);
      }
      const result: Record<string, JsonValue> = Object.create(null);
      for (const [key, entry] of Object.entries(input)) {
        result[key] = visit(entry, `${path}.${key}`);
      }
      return result;
    } finally {
      seen.delete(input);
    }
  };
  return visit(value, label) as T;
};

const assertWithinLimits = (
  name: string,
  state: DraftState,
  limits: DraftLimits,
): void => {
  if (state.scenes.size > limits.maxScenesPerSession) {
    throw new Error(
      `Altair draft session ${JSON.stringify(name)} exceeds its scene limit`,
    );
  }
  const bytes = sessionBytes(state);
  if (bytes > limits.maxSessionBytes) {
    throw new Error(
      `Altair draft session ${JSON.stringify(name)} exceeds its ${limits.maxSessionBytes}-byte limit`,
    );
  }
};

const sessionBytes = (state: DraftState): number => {
  const encoder = new TextEncoder();
  const textBytes = (value: string): number => encoder.encode(value).byteLength;
  const recordBytes = (record: MutableDraftRecord): number =>
    textBytes(record.value) +
    (record.base === undefined ? 0 : textBytes(record.base.snapshot) + 8);
  let bytes = state.project === undefined ? 0 : recordBytes(state.project);
  for (const scene of state.scenes.values()) {
    bytes += textBytes(scene.sceneId) + recordBytes(scene);
    if (scene.context !== undefined) {
      bytes += textBytes(JSON.stringify(scene.context));
    }
  }
  return bytes;
};

const freezeResult = <T>(value: T): T => {
  const freeze = (input: unknown): void => {
    if (!input || typeof input !== "object" || Object.isFrozen(input)) {
      return;
    }
    for (const child of Object.values(input as Record<string, unknown>)) {
      freeze(child);
    }
    Object.freeze(input);
  };
  freeze(value);
  return value;
};
