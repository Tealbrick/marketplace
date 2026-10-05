# `@tealbrick/ui`

Canonical web tokens, brand assets and low-level components for standalone
Teal Brick Micro-apps. It is intentionally smaller than an application framework.

Import the tokens before application CSS:

```ts
import "@tealbrick/ui/tokens.css";
import "@tealbrick/ui/components.css";
```

Brand source: the deployed Teal Brick Portal and website (see `brand-spec.md`).
The `--dg-*` custom-property names are kept as a stable styling API; new code may
use the `--tb-*` aliases. `@doppelganger/ui` and `.sdk/doppelganger-ui` remain
resolvable legacy spellings only.

Applications own their domain components and information architecture. This
package owns brand assets, tokens, primitive interaction vocabulary, focus and
motion behavior, and the small reusable components proven by reference apps.

The deployed Micro-app archive already carries `apps/.sdk` beside every
Program. Vite consumers should resolve `@tealbrick/ui` against the local or
packaged `.sdk/tealbrick-ui` source rather than copying it.

## Themes

Light is the default. The dark theme follows `prefers-color-scheme: dark` unless
the app pins `data-theme="light"`; `data-theme="dark"` forces it.

## App icons and web manifest

`vite/app-icons.mjs` exports `tealbrickAppIcons({ name, shortName })`, a Vite
plugin that emits the favicon, Apple touch icon, PWA icons and
`manifest.webmanifest`, and injects their `<link>` tags. Every icon in
`assets/icons/` is rendered from the official `teal-brick-colour.png`.

## Unified interaction primitives

`Button` supports `pending` (disabled and `aria-busy`) without changing its
existing HTML button type semantics. Use an explicit `type` inside forms.
`TextField`, `TextareaField`, `SelectField` and `CheckboxField` provide shared geometry and
associated labels/help/errors. Existing `Field` remains compatible.
`TextareaField` preserves native textarea props (controlled value, `readOnly`,
`disabled`, `rows`, `maxLength`) and defaults to four rows with vertical resize.
It merges external help IDs with its description/error IDs and supports the
same `autoFocus` marker as single-line inputs inside shared dialogs.

`Dialog` is a controlled native modal (`open`, `onOpenChange`, `title`,
`description`, optional `children`, `footer`, `kind="alertdialog"`). Native
`showModal()` supplies top-layer isolation and focus containment; Escape closes
through the caller, and the browser returns focus to the invoker. Put `autoFocus`
on a shared TextField or Button for the intended first focus; destructive dialogs
should initially focus Cancel/Keep. No app-local modal geometry or custom focus
trap is needed. Use a real browser for modal acceptance; DOM-only tests need an
explicit native-dialog fixture and cannot prove focus containment.

`SettingsPage` is layout, not persistence or routing. Apps own route/deep-link
handling, dirty-state navigation guards and explicit Save/Discard actions.
`Sidebar` displays already-authorized contributions and never grants access.
`SectionNavigation` owns the same wrapping horizontal section navigation in
every app. Supply typed items, current ID and an app-owned `onSelect` callback
that handles URL/history and dirty-state guards. These are normal navigation
buttons with `aria-current`, not ARIA tabs; natural Tab/Shift+Tab and Enter/Space
apply. No app-specific vertical orientation or small-screen scroll rail.
`Feedback` distinguishes loading, empty, error, forbidden, unavailable, pending
and confirmed results; callers supply truthful evidence, not optimistic success.

Primary foreground now uses `--dg-on-accent` in both themes. Do not override
button foreground in product CSS. The shared 4px/6px/8px geometry remains fixed.

## Local component acceptance gallery

```sh
npm ci --ignore-scripts
npm run check
npm run build:gallery
npm run dev:gallery
```

The gallery runs at `http://127.0.0.1:5490` and includes light/dark states,
forms, standard/destructive dialogs and an in-memory settings example. It calls
no product backend and is not a deployed control plane. Root browser review and
app-specific migration tests remain required before claiming ecosystem parity.
