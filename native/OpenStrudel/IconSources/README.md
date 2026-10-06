# OpenStrudel icon masters

Selected artwork: the infinity-shaped pastry, with cream for light appearance and graphite for dark appearance. These are the user's selected raster masters, not a new drawing. Icon Composer's licence was accepted with explicit user permission on 6 October 2026.

- `Cream.icon` and `Graphite.icon`: editable Icon Composer documents, 1024 × 1024 artwork, no added glass distortion.
- `MenuTemplate.png`: original transparent monochrome T2 mark. The menu asset crops only transparent padding, then scales to 20 × 10 points at 1×/2×/3×. Template rendering adapts its ink to the system appearance.
- `../Assets.xcassets/iOSAppIcon.appiconset`: opaque square light/dark 1024 px sources. iOS applies its system mask.
- `../Assets.xcassets/AppIcon.appiconset`: Mac icon sizes 16–1024 px, using the system rendering exported by Icon Composer. Finder's static icon is cream.
- `../Assets.xcassets/DockCream.imageset` and `DockGraphite.imageset`: system-masked icons for the running app's Dock/app-switcher icon. Appearance follows the system; this is still a regular Dock app.

The app and its web surface use the same artwork. No server credentials, app signing credentials or image-generation history belong in this pack. The source documents are editable artwork; production targets currently compile the flattened asset catalogues, not layered `.icon` documents.

Apple reference: [App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons), [Menu bar extras](https://developer.apple.com/design/human-interface-guidelines/menu-bar-extras).
