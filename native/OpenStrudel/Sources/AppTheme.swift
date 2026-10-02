import SwiftUI

/// Shared semantic colors adapt independently to light, dark and increased contrast.
/// Navigation stays neutral; the muted accent identifies links and primary actions.
enum AppTheme {
    static let accent = Color("AccentColor")
    static let secondaryText = Color("SecondaryText")
    static let metadataText = Color("MetadataText")
    static let warning = Color("WarningText")
}
