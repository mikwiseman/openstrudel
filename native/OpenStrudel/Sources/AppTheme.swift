import SwiftUI

/// Shared semantic colors adapt independently to light, dark and increased contrast.
/// Navigation stays neutral; the muted accent identifies links and primary actions.
enum AppTheme {
    static let accent = Color("AccentColor")
    static let secondaryText = Color("SecondaryText")
    static let metadataText = Color("MetadataText")
    static let warning = Color("WarningText")
    static let destructive = Color("DestructiveText")
}

/// Give large text the full row instead of letting a capsule squeeze each word.
struct AdaptiveActionLabel: View {
    @Environment(\.dynamicTypeSize) private var textSize
    let title: String

    var body: some View {
        Text(title)
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
            .multilineTextAlignment(.center)
            .frame(maxWidth: textSize.isAccessibilitySize ? .infinity : nil)
    }
}

private struct AdaptiveActionStyle<Regular: PrimitiveButtonStyle>: ViewModifier {
    @Environment(\.dynamicTypeSize) private var textSize
    let regular: Regular

    @ViewBuilder
    func body(content: Content) -> some View {
        if textSize.isAccessibilitySize {
            content.buttonStyle(ReadableActionButtonStyle())
        } else {
            content.buttonStyle(regular)
        }
    }
}

private struct ReadableActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let color = configuration.role == .destructive ? AppTheme.destructive : AppTheme.accent
        configuration.label
            .padding(.horizontal, 8)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(color)
            .background(color.opacity(configuration.isPressed ? 0.22 : 0.10),
                        in: RoundedRectangle(cornerRadius: 14))
            .contentShape(RoundedRectangle(cornerRadius: 14))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

extension View {
    func adaptiveActionStyle<S: PrimitiveButtonStyle>(_ style: S) -> some View {
        modifier(AdaptiveActionStyle(regular: style))
    }
}
