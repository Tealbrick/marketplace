# Teal Brick Web Brand Specification

Status: canonical miniapp web baseline (v0.2.1)
Source: deployed Teal Brick website and Portal (`Tealbrick/Website-martin`:
`public/brand/`, `app/teal.css`, `app/portal/home.css`), extracted 2026-10-05.
Supersedes the 2026-08-12 burgundy/mirrored-D baseline inherited from Doppelganger.

## Identity

- Product: Teal Brick (wordmark set lowercase, `teal brick`, in the interface face)
- Product mark: the two-brick illustration (brick-red + teal), operator-supplied
- Interface face: Geist (variable), as served by the Portal
- Editorial face: Georgia serif stack (Portal and website headlines)
- Technical face: Geist Mono (variable)

## Assets

- Mark: `assets/tealbrick-mark.svg` (raster wrapper, 160px) and `assets/tealbrick-mark.png`.
  Both derive from `Website-martin/public/brand/teal-brick-colour.png`; the artwork is
  not vector-traced.
- App tile: `assets/tealbrick-tile.svg` (website `teal-icon.svg`: paper brick on a teal tile)
  for favicons where the illustration is unreadable at 16px.
- Fonts: `assets/fonts/Geist-Variable.woff2`, `assets/fonts/GeistMono-Variable.woff2`
  (SIL OFL 1.1, `assets/fonts/licenses/Geist-OFL.txt`).
- App icons: `assets/icons/` (favicon 32/48, Apple touch 180, PWA 192/512 and maskable 512),
  rendered from `teal-brick-colour.png` on paper `#f3f1e9`; emitted by `vite/app-icons.mjs`.
  The Portal itself uses the same colour PNG as its favicon.

The mark must be rendered from the tracked asset. Do not redraw, recolour,
stretch, outline, or replace it. Never reintroduce the mirrored-D monogram.

## Palette (light)

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Paper | `--dg-canvas` / `--tb-paper` | `#f3f1e9` | application background |
| Surface | `--dg-paper` / `--tb-surface` | `#fbfaf5` | raised working surfaces |
| Teal ink | `--dg-ink` / `--tb-ink` | `#173f3c` | primary text |
| Muted | `--dg-muted` | `#596b62` | secondary text |
| Hairline | `--dg-line` | `#d9ddd3` | separators and quiet borders |
| Hairline strong | `--dg-line-strong` | `#b7c5bb` | hovered and selected borders |
| Primary | `--dg-primary` (legacy `--dg-burgundy`) | `#173f3c` | primary action |
| Primary hover | `--dg-primary-deep` | `#2a5850` | primary hover |
| Brick | `--dg-brick` / `--tb-brick` | `#a8442f` | emphasis, focus ring, editorial accent |
| Danger | `--dg-danger` | `#a3322a` | destructive and denied state |
| Warning | `--dg-warning` | `#94621c` | degraded or attention state |
| Verified green | `--dg-success` | `#2f6b4f` | confirmed positive state only |

`--dg-*` names are a stable styling API used by every miniapp stylesheet; their
values changed, their names did not. New code may use the `--tb-*` aliases.
A dark theme (OS `prefers-color-scheme: dark`, or `:root[data-theme="dark"]`) uses deep-teal surfaces and a light
teal primary; text on primary uses `--dg-on-primary`.

## Shape and depth

- Controls 4px, small surfaces 6px, large surfaces and modals 8px radius.
- Prefer hairlines and tonal contrast to nested cards; Portal surfaces are flat.
- Use the modal shadow token only for true elevation.

## Interaction

- Default transition: 140ms ease-out.
- Focus rings use translucent brick and must remain visible.
- Primary actions are teal; success becomes green only after verification.
- Motion is reduced under `prefers-reduced-motion`.
- Developer data, paths, identifiers, commands, and code use Geist Mono.

## Product character

Quiet, editorial, exact, governed, and human: warm paper, deep teal ink, a
single brick-red accent. No purple-gradient AI branding, neon dashboards,
decorative statistics, nested rounded cards, or emoji iconography.
