# Contributing

Use Node.js 20 or newer and pnpm 11. Run `pnpm check` before opening a change.
Keep the service framework-neutral, bounded, deterministic, and free of shared
mutable state. Add tests for conflict ordering, reconciliation, limits, and
plugin lifecycle changes. Persistence changes require tests for atomic
revision checks, load failure, quota rollback, flush ordering, disposal and
browser IndexedDB behavior.

Do not import Altair's draft implementation. Do not commit game assets,
extracted game content, proprietary SDKs, runtime cores, or credentials.

Maintainers publish from GitHub releases through npm trusted publishing. The
npm package must authorize this repository's `.github/workflows/publish.yml`
workflow before the first release.
