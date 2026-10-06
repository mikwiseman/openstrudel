#if os(macOS)
import AppKit
import SwiftUI

/// Dock and the app switcher use the same artwork as the system appearance.
/// The application remains a regular Dock application when the menu is hidden.
struct AppIconAppearance: ViewModifier {
    @Environment(\.colorScheme) private var appearance
    @MainActor private static var appliedName: String?
    func body(content: Content) -> some View {
        content.onAppear(perform: update).onChange(of: appearance) { _, _ in update() }
    }
    private func update() {
        let name = appearance == .dark ? "DockGraphite" : "DockCream"
        guard Self.appliedName != name, let image = NSImage(named: name) else { return }
        Self.appliedName = name
        NSApp.applicationIconImage = image
    }
}
#endif
