# Altair Drafts

Recoverable draft sessions and conflict handling for Altair editors.

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-drafts
```

```ts
import { createAltairDraftService, createAltairIndexedDbDraftPersistence } from "@haneoka/altair-plugin-drafts";

const drafts = createAltairDraftService({
  persistence: createAltairIndexedDbDraftPersistence(),
});
const session = await drafts.open("main", initialProject);
await session.updateScene(update);
await drafts.flush();
```

The default plugin stores drafts in memory. Use the IndexedDB adapter for reload and crash recovery. Revision conflicts and storage quota failures are reported without replacing the last committed snapshot.

MPL-2.0.
