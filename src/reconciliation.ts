import type {
  AltairDraftBase,
  AltairDraftConflict,
  AltairDraftConflictOptions,
  AltairSceneDraftReconciliationOptions,
  AltairSceneDraftReconciliationResult,
} from "./contracts.js";

/**
 * Captures the baseline for the first divergent edit and retains it until the
 * draft returns to that baseline.
 */
export const altairDraftBaseForValue = (
  existing: AltairDraftBase | undefined,
  baseline: string,
  nextValue: string,
  revision: number,
): AltairDraftBase | undefined => {
  if (nextValue === baseline) return undefined;
  return existing ?? { snapshot: baseline, revision };
};

/**
 * Detects project and scene conflicts in deterministic recovery order.
 */
export const altairDraftConflict = (options: AltairDraftConflictOptions): AltairDraftConflict | undefined => {
  if (!options.base) return "missing-base";
  if (options.currentRevision !== options.base.revision || options.currentSnapshot !== options.base.snapshot) {
    return "project-changed";
  }
  if (options.nextSceneIds !== undefined && options.sceneDraftIds?.length) {
    const nextSceneIds = new Set(options.nextSceneIds);
    if (options.sceneDraftIds.some((sceneId) => !nextSceneIds.has(sceneId))) {
      return "scene-draft-orphaned";
    }
  }
  return undefined;
};

export const hasPendingAltairDrafts = (projectDraftPending: boolean, sceneDraftIds: readonly string[]): boolean =>
  projectDraftPending || sceneDraftIds.length > 0;

/**
 * Returns a detached scene-draft view and drops an entry once it matches the
 * current baseline. Input records are never mutated.
 */
export const reconcileAltairSceneDraft = <Context>(
  options: AltairSceneDraftReconciliationOptions<Context>,
): AltairSceneDraftReconciliationResult<Context> => {
  const draft = options.drafts[options.sceneId];
  if (draft !== options.baseline) {
    return {
      value: draft ?? options.baseline,
      drafts: { ...options.drafts },
      contexts: { ...options.contexts },
    };
  }
  const { [options.sceneId]: _draft, ...drafts } = options.drafts;
  const { [options.sceneId]: _context, ...contexts } = options.contexts;
  return { value: options.baseline, drafts, contexts };
};

/** @deprecated Use `AltairDraftBase`. */
export type StoryJsonDraftBase = AltairDraftBase;

/** @deprecated Use `AltairDraftConflict`. */
export type StoryJsonDraftConflict = AltairDraftConflict;

/** Compatibility alias for Altair 0.1 authoring integrations. */
export const storyJsonDraftBaseForValue = altairDraftBaseForValue;

/** Compatibility alias for Altair 0.1 authoring integrations. */
export const storyJsonDraftConflict = altairDraftConflict;

/** Compatibility alias for Altair 0.1 authoring integrations. */
export const hasPendingStoryCodeDrafts = hasPendingAltairDrafts;

/** Compatibility alias for Altair 0.1 authoring integrations. */
export const reconcileStorySceneCodeDraft = reconcileAltairSceneDraft;
