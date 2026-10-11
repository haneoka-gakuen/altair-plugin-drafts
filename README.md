# Altair Drafts

Altair Drafts keeps unsaved edits safe. While you type in the
[Altair](https://github.com/haneoka-gakuen/altair) editor, every change to the
project and to each scene is recorded as a draft against the version it
started from. Close the tab, reload, or let the browser crash, and the drafts
are still there the next time the project opens. If the project changed
underneath you in the meantime — another window saved it, or you pulled a new
version — Altair tells you which drafts no longer apply instead of silently
overwriting anything.

Drafts live in memory by default. Add the IndexedDB adapter and they survive
reloads; write your own adapter and they can live anywhere.

## Install

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-drafts
```

ESM only; Node 20 or a current browser.

## Use it in Altair

The default plugin keeps drafts in memory for the life of the page:

```ts
import { AltairPluginHost } from "@haneoka/altair/plugins";
import { ALTAIR_DRAFT_SERVICE, altairDraftsPlugin } from "@haneoka/altair-plugin-drafts";

const host = new AltairPluginHost();
await host.install(altairDraftsPlugin);
const drafts = host.service(ALTAIR_DRAFT_SERVICE);
```

For crash and reload recovery, give it persistence:

```ts
import { createAltairDraftsPlugin, createAltairIndexedDbDraftPersistence } from "@haneoka/altair-plugin-drafts";

await host.install(
  createAltairDraftsPlugin({
    persistenceFactory: () => createAltairIndexedDbDraftPersistence(),
  }),
);
```

`persistenceFactory` is called each time the plugin is activated, so
uninstalling and reinstalling the plugin always gets a fresh adapter.

## How drafts work

Drafts are grouped into named **sessions** — typically one per open project.

```ts
const session = await drafts.open("project:first-light");

// The user edited the project file.
await session.updateProject({ baseline: savedJson, value: editedJson, revision: 12 });

// The user edited one scene in the code view.
await session.updateScene({
  sceneId: "opening",
  baseline: savedSceneSource,
  value: editedSceneSource,
  projectSnapshot: savedJson,
  projectRevision: 12,
});
```

- `baseline` is the saved text; `value` is what the user has now. When the two
  are equal again the draft disappears on its own.
- The first edit records a **base**: the project snapshot and revision the
  draft grew from. Later edits keep that base.
- Scene drafts can carry a `context` (cursor, selection, scroll) that is
  restored with the text.

When the project is opened again, ask the session where it stands:

```ts
const status = session.status({ snapshot: currentJson, revision: currentRevision, nextSceneIds });
if (status.conflict) {
  // show a recovery dialog
} else if (status.pending) {
  // offer to restore session.snapshot()
}
```

`status.conflict` is checked in this order:

| Conflict | Meaning |
| --- | --- |
| `missing-base` | A draft exists but has no recorded base, so it cannot be compared. |
| `project-changed` | The project's snapshot or revision differs from the draft's base. |
| `scene-draft-orphaned` | A scene draft belongs to a scene that is no longer in `nextSceneIds`. |

`reconcileScene(sceneId, baseline)` merges a scene's draft with a new saved
baseline and returns the text to show and whether it is still pending. Other
session methods: `clearProject()`, `clearScene(id)`, `pending()`,
`snapshot()`, `reload()` (re-read from persistence), `flush()` and `dispose()`.
Disposing a session releases memory; persisted drafts remain recoverable.

On the service: `open(name, seed?)`, `get(name)`, `names()`, `close(name)`,
`flush()` and `dispose()`. `seed` pre-fills a session only when persistence has
nothing stored for that name.

## Limits

| Option | Default |
| --- | --- |
| `maxSessions` | 16 open sessions |
| `maxScenesPerSession` | 512 scene drafts per session |
| `maxSessionBytes` | 16 MiB of encoded drafts per session |

Session names are at most 64 characters and scene ids at most 256. Pass the
options to `createAltairDraftsPlugin` or `createAltairDraftService`. Going over
a limit rejects that edit and keeps the previous draft.

## Persistence

`createAltairIndexedDbDraftPersistence(options?)` stores one record per
session in the `sessions` store of the `haneoka-altair-drafts` database. Change
them with `databaseName` and `storeName`; pass `indexedDB` to use a factory
other than `globalThis.indexedDB`, for example in a worker.

To store drafts elsewhere, implement `AltairDraftPersistence`:

```ts
interface AltairDraftPersistence {
  readonly id: string;
  readonly durable: boolean;
  load(name, { signal }?): Promise<AltairDraftPersistedSession | undefined>;
  save(record, { expectedRevision, signal }): Promise<void>;
  remove(name, { expectedRevision, signal }): Promise<void>;
  flush?(): Promise<void>;
  dispose?(): Promise<void>;
}
```

Every write carries the revision it expects to replace (`null` for a new
record). If storage holds a different revision, throw
`AltairDraftPersistenceConflictError`; the session keeps its last committed
state and reports the conflict. Other errors map to
`AltairDraftPersistenceQuotaError`, `AltairDraftPersistenceUnavailableError`,
or the base `AltairDraftPersistenceError` with code `invalid-data` or
`operation-failed`. A failed write never replaces the last good snapshot.

## Without the plugin host

`createAltairDraftService(options)` returns the same service for apps that do
not use Altair's plugin host. The reconciliation helpers
(`altairDraftConflict`, `altairDraftBaseForValue`, `reconcileAltairSceneDraft`,
`hasPendingAltairDrafts`) are exported on their own for custom editors.

## License

MPL-2.0. See [LICENSE](LICENSE).
