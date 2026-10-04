# Teal Brick Web Brand Specification

Status: canonical miniapp web baseline
Source: `dg/brand/README.md` and assembled desktop brand assets
Established: 2026-08-12

## Identity

- Product: Teal Brick
- Product mark: mirrored-D monogram only
- Interface face: Switzer Variable
- Editorial face: Cormorant Garamond
- Technical face: JetBrains Mono

## Assets

- Mark: `assets/tealbrick-mark.svg`
- Interface font: `assets/fonts/Switzer-Variable.woff2`
- Editorial font: `assets/fonts/CormorantGaramond.ttf`
- Technical font: `assets/fonts/JetBrainsMono-Regular.woff2`

The mark must be rendered from the tracked asset. It must not be redrawn,
stretched, recolored, outlined, or replaced by donor mascots.

## Palette

| Role | Value | Use |
| --- | --- | --- |
| Canvas | `#faf8f4` | application background |
| Paper | `#fffdf9` | raised working surfaces |
| Charcoal | `#1c1917` | primary text |
| Muted | `#655f59` | secondary text |
| Hairline | `#ddd5ca` | separators and quiet borders |
| Hairline strong | `#b9aca0` | hovered and selected borders |
| Burgundy | `#7c2d36` | primary action and identity |
| Burgundy deep | `#5f2029` | primary hover |
| Danger | `#a73242` | destructive and denied state |
| Warning | `#9a641d` | degraded or attention state |
| Verified green | `#39755a` | confirmed positive state only |

## Shape and depth

- Controls: 4px radius
- Small surfaces: 6px radius
- Large surfaces and modals: 8px radius
- Prefer hairlines and tonal contrast to nested cards.
- Use the modal shadow token only for true elevation.
- Avoid pill-shaped containers except tags, status, and compact metadata.

## Interaction

- Default transition: 140ms ease-out.
- Focus rings use translucent burgundy and must remain visible.
- Primary actions are burgundy; success becomes green only after verification.
- Motion must be disabled or reduced under `prefers-reduced-motion`.
- Developer data, paths, identifiers, commands, and code use JetBrains Mono.

## Product character

Quiet, editorial, exact, governed, and human. The system must not drift into
purple-gradient AI branding, cyber-neon dashboards, decorative statistics,
rounded-card nesting, emoji iconography, or generic system-font prototypes.
