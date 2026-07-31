import type { JsonValue } from "@haneoka/altair/model";

export type AltairDraftConflict =
  "missing-base" | "project-changed" | "scene-draft-orphaned";

export interface AltairDraftBase {
  /** Deterministic project source at the moment editing diverged. */
  readonly snapshot: string;
  /** Monotonic editor revision at the moment editing diverged. */
  readonly revision: number;
}

export interface AltairDraftRecord {
  readonly value: string;
  readonly base?: AltairDraftBase;
}

export interface AltairSceneDraftRecord extends AltairDraftRecord {
  readonly sceneId: string;
  readonly context?: JsonValue;
}

export interface AltairDraftSessionSeed {
  readonly project?: AltairDraftRecord;
  readonly scenes?: readonly AltairSceneDraftRecord[];
}

export interface AltairProjectDraftUpdate {
  readonly baseline: string;
  readonly value: string;
  readonly revision: number;
}

export interface AltairSceneDraftUpdate {
  readonly sceneId: string;
  readonly baseline: string;
  readonly value: string;
  readonly projectSnapshot: string;
  readonly projectRevision: number;
  readonly context?: JsonValue;
}

export interface AltairDraftCurrentProject {
  readonly snapshot: string;
  readonly revision: number;
  readonly nextSceneIds?: readonly string[];
}

export interface AltairDraftPendingStatus {
  readonly pending: boolean;
  readonly project: boolean;
  readonly sceneIds: readonly string[];
}

export interface AltairDraftStatus extends AltairDraftPendingStatus {
  readonly conflict?: AltairDraftConflict;
}

export interface AltairSceneDraftReconciliation {
  readonly sceneId: string;
  readonly value: string;
  readonly pending: boolean;
  readonly context?: JsonValue;
  readonly base?: AltairDraftBase;
}

export interface AltairDraftSessionSnapshot {
  readonly name: string;
  readonly persistenceRevision: number | null;
  readonly project?: AltairDraftRecord;
  readonly scenes: readonly AltairSceneDraftRecord[];
  readonly status: AltairDraftPendingStatus;
}

export interface AltairDraftSession {
  readonly name: string;
  readonly disposed: boolean;
  readonly persistenceRevision: number | null;
  updateProject(update: AltairProjectDraftUpdate): Promise<void>;
  clearProject(): Promise<void>;
  updateScene(update: AltairSceneDraftUpdate): Promise<void>;
  clearScene(sceneId: string): Promise<void>;
  reconcileScene(
    sceneId: string,
    baseline: string,
  ): Promise<AltairSceneDraftReconciliation>;
  pending(): AltairDraftPendingStatus;
  status(current: AltairDraftCurrentProject): AltairDraftStatus;
  snapshot(): AltairDraftSessionSnapshot;
  /** Replace the committed memory state with the current persisted state. */
  reload(): Promise<AltairDraftSessionSnapshot>;
  /** Wait for queued mutations and the persistence adapter. */
  flush(): Promise<void>;
  /** Flush and release memory. Persisted drafts remain recoverable. */
  dispose(): Promise<void>;
}

export interface AltairDraftPersistenceInfo {
  readonly id: string;
  readonly durable: boolean;
}

export interface AltairDraftConflictOptions {
  readonly base?: AltairDraftBase;
  readonly currentSnapshot: string;
  readonly currentRevision: number;
  readonly nextSceneIds?: readonly string[];
  readonly sceneDraftIds?: readonly string[];
}

export interface AltairSceneDraftReconciliationOptions<Context> {
  readonly sceneId: string;
  readonly baseline: string;
  readonly drafts: Readonly<Record<string, string>>;
  readonly contexts: Readonly<Record<string, Context>>;
}

export interface AltairSceneDraftReconciliationResult<Context> {
  readonly value: string;
  readonly drafts: Record<string, string>;
  readonly contexts: Record<string, Context>;
}

export interface AltairDraftReconciliationHelpers {
  altairDraftBaseForValue(
    existing: AltairDraftBase | undefined,
    baseline: string,
    nextValue: string,
    revision: number,
  ): AltairDraftBase | undefined;
  altairDraftConflict(
    options: AltairDraftConflictOptions,
  ): AltairDraftConflict | undefined;
  hasPendingAltairDrafts(
    projectDraftPending: boolean,
    sceneDraftIds: readonly string[],
  ): boolean;
  reconcileAltairSceneDraft<Context>(
    options: AltairSceneDraftReconciliationOptions<Context>,
  ): AltairSceneDraftReconciliationResult<Context>;
  /** Compatibility alias for Altair 0.1 authoring integrations. */
  storyJsonDraftBaseForValue(
    existing: AltairDraftBase | undefined,
    baseline: string,
    nextValue: string,
    revision: number,
  ): AltairDraftBase | undefined;
  /** Compatibility alias for Altair 0.1 authoring integrations. */
  storyJsonDraftConflict(
    options: AltairDraftConflictOptions,
  ): AltairDraftConflict | undefined;
  /** Compatibility alias for Altair 0.1 authoring integrations. */
  hasPendingStoryCodeDrafts(
    projectDraftPending: boolean,
    sceneDraftIds: readonly string[],
  ): boolean;
  /** Compatibility alias for Altair 0.1 authoring integrations. */
  reconcileStorySceneCodeDraft<Context>(
    options: AltairSceneDraftReconciliationOptions<Context>,
  ): AltairSceneDraftReconciliationResult<Context>;
}

export interface AltairDraftService extends AltairDraftReconciliationHelpers {
  readonly disposed: boolean;
  readonly maxSessions: number;
  readonly persistence: AltairDraftPersistenceInfo;
  /**
   * Opens a named session after loading persistence.
   *
   * `seed` is used only when persistence has no record for this name.
   */
  open(
    name: string,
    seed?: AltairDraftSessionSeed,
  ): Promise<AltairDraftSession>;
  get(name: string): AltairDraftSession | undefined;
  names(): readonly string[];
  close(name: string): Promise<boolean>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AltairDraftPersistenceRequest {
  readonly signal?: AbortSignal;
}

export interface AltairDraftPersistenceMutationRequest extends AltairDraftPersistenceRequest {
  /** `null` means the record must not exist. */
  readonly expectedRevision: number | null;
}

export interface AltairDraftPersistedSession {
  readonly format: "altair-draft-session";
  readonly formatVersion: 1;
  readonly name: string;
  /** Positive monotonic persistence revision. */
  readonly revision: number;
  readonly seed: AltairDraftSessionSeed;
}

export interface AltairDraftPersistence extends AltairDraftPersistenceInfo {
  load(
    name: string,
    request?: AltairDraftPersistenceRequest,
  ): Promise<AltairDraftPersistedSession | undefined>;
  save(
    record: AltairDraftPersistedSession,
    request: AltairDraftPersistenceMutationRequest,
  ): Promise<void>;
  remove(
    name: string,
    request: AltairDraftPersistenceMutationRequest,
  ): Promise<void>;
  flush?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface AltairDraftServiceOptions {
  /** Maximum number of simultaneously open named sessions. */
  readonly maxSessions?: number;
  /** Maximum number of scene drafts retained by one session. */
  readonly maxScenesPerSession?: number;
  /** Maximum encoded state retained by one session. */
  readonly maxSessionBytes?: number;
  /** Omit for intentionally volatile, process-local memory mode. */
  readonly persistence?: AltairDraftPersistence;
}

export interface AltairDraftsPluginOptions {
  readonly maxSessions?: number;
  readonly maxScenesPerSession?: number;
  readonly maxSessionBytes?: number;
  /**
   * Called for every plugin activation so uninstall/reinstall gets a fresh,
   * independently owned adapter.
   */
  readonly persistenceFactory?: () => AltairDraftPersistence;
}

export interface AltairIndexedDbDraftPersistenceOptions {
  /** Injected for tests, workers, or non-window browser hosts. */
  readonly indexedDB?: IDBFactory;
  readonly databaseName?: string;
  readonly storeName?: string;
}
