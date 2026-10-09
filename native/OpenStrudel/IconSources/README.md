# OpenStrudel icon masters

Selected artwork: the smiling cinnamon-roll assistant on graphite, approved by
the user on 9 October 2026.

- `Assistant.png`: the selected character, enlarged inside its tile after Dock
  review, with transparency outside the tile.
- `Graphite.icon` and `Cream.icon`: editable Icon Composer documents containing
  the same opaque square artwork, without added glass distortion. The background
  extends to the square edges so iOS and web/PWA can apply their own masks.
- `../Assets.xcassets/AppIcon.appiconset`: Mac icon sizes 16–1024 px.
- `../Assets.xcassets/DockCream.imageset` and `DockGraphite.imageset`: the same
  approved tile for the running app, app switcher and main assistant. Transparent
  optical padding keeps its size consistent with neighboring macOS icons.
- `../Assets.xcassets/iOSAppIcon.appiconset`: opaque 1024 px sources.
- `MenuTemplate.png`: the same bun as a monochrome silhouette with transparent
  spiral, eyes and smile; exported at 20 × 17 points for the system menu bar.

Regenerate all flattened exports with `swift scripts/export-app-icons.swift`
from the repository root. Cream/Graphite names remain compatibility aliases;
both use the selected graphite design. Production targets compile the flattened
asset catalogues, not the layered `.icon` documents.

Apple reference: [App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons), [Menu bar extras](https://developer.apple.com/design/human-interface-guidelines/menu-bar-extras).
