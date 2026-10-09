# OpenStrudel visual assets

The main assistant is the smiling cinnamon-roll character selected by the user
on 9 October 2026. Its warm dough, small face and generous graphite surround
match the employee character family.

The final revision enlarges the character by approximately 20% inside the same
tile, improving legibility at Dock size while retaining the standard Mac footprint.

`IconSources/Assistant.png` is the approved transparent macOS artwork.
`IconSources/Graphite.icon/Assets/Strudel.png` is its opaque square export:
the graphite background was extended for platforms that apply their own mask.
The character's shape, face, colors and composition are preserved.

Run `swift scripts/export-app-icons.swift` from the repository root to export
the Apple asset-catalog sizes and the web/PWA icons. The Mac export adds optical
padding so the tile fits alongside other Dock icons. It does not redraw the art.

The existing Cream/Graphite asset names and public URLs are retained for
compatibility; both appearances use the selected graphite artwork.
`IconSources/MenuTemplate.png` simplifies the same smiling bun into a monochrome
silhouette with a spiral and face. Its transparent cutouts stay legible in the
20 × 17 point menu-bar template, which macOS tints for the current appearance.
Employee character choices remain separate assets.
