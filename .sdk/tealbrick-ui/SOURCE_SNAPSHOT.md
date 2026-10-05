# Bundled UI provenance

2026-10-05 (0.2.1): Teal Brick brand applied — tokens, mark, fonts and icons
from the miniapp brand lane's `@tealbrick/ui` 0.2.0 (sourced from the deployed
Portal/website), merged into this richer primitive set; OS dark mode and the
`vite/app-icons.mjs` icon/manifest plugin added. Earlier history follows.

Updated 2026-09-06 from the reviewed LABS `.sdk/doppelganger-ui` source.
Shared-support source commit: `1c2a828269af9b44776200ad0370e4ff8e2e93e4`.
That local source history is preserved in LABS's verified
`report/evidence/shared-dialog-close-race.bundle`; it is not a published
package-registry release or a new canonical remote repository.

This repository carries its own complete UI source/assets so a standalone
clone builds without an adjacent LABS checkout. Its existing app-local Vite
and TypeScript SDK paths are retained. No node_modules or generated gallery
bundle is included. Existing standalone brand-spec Markdown whitespace is
preserved; source controls, tokens and assets match the reviewed foundation.

Shared primitives do not by themselves mean all application routes, forms or
dialogs have migrated. App-specific acceptance is recorded separately.
