import SwiftUI

/// Semantic colors with light, dark and increased-contrast variants (docs/design-system.md).
/// The canvas belongs to the main window; sheets, forms and popovers keep system backgrounds.
enum AppTheme {
    static let canvas = Color("CanvasColor")
    /// Code blocks, file chips, cards, table headers and other people's messages.
    static let surface = Color("SurfaceColor")
    static let userBubble = Color("UserBubbleColor")
    /// Hairlines and rules only, never an input border.
    static let separator = Color("SeparatorColor")
    /// The warm graphite system accent: selection, focus, switches and checkboxes.
    static let accent = Color("AccentColor")
    /// Ink: links (underlined), the send button and primary fills, whose labels use the canvas colour.
    static let accentText = Color("AccentText")
    static let secondaryText = Color("SecondaryText")
    static let warning = Color("WarningText")
    static let destructive = Color("DestructiveText")
}

/// One superfamily: SF for the interface and reading, SF Rounded for display, SF Mono for code.
/// Hebrew falls back to SF Hebrew and SF Hebrew Rounded by itself.
enum AppTypography {
    /// Welcome, onboarding and the empty conversation's name.
    static var display: Font {
        #if os(macOS)
        .system(size: 28, weight: .semibold, design: .rounded)
        #else
        .system(.title, design: .rounded, weight: .semibold)
        #endif
    }
    /// Sheet and pane titles inside content.
    static var title: Font {
        #if os(macOS)
        .title2.weight(.semibold)
        #else
        .title3.weight(.semibold)
        #endif
    }
    /// Messages, the composer and long editable text. Pair with `readingLineSpacing`.
    static var reading: Font {
        #if os(macOS)
        .system(size: 15)
        #else
        .body
        #endif
    }
    static var readingLineSpacing: CGFloat {
        #if os(macOS)
        3
        #else
        4
        #endif
    }
    /// Rows, labels, buttons and settings.
    static let interface: Font = .body
    /// Time clusters, status, file sizes and captions.
    static var meta: Font {
        #if os(macOS)
        .subheadline
        #else
        .footnote
        #endif
    }
    /// Code blocks and inline code. Pair with `codeLineSpacing`.
    static var code: Font {
        #if os(macOS)
        .system(size: 13, design: .monospaced)
        #else
        .subheadline.monospaced()
        #endif
    }
    static var codeLineSpacing: CGFloat {
        #if os(macOS)
        4
        #else
        5
        #endif
    }

    // Earlier names, kept until every surface reads the roles above.
    static var welcome: Font { display }
    static var emptyTitle: Font { display }
    static var sidebarTitle: Font { interface.weight(.medium) }
    static var sidebarDetail: Font { interface }
    static var chat: Font { reading }
}

enum Layout {
    /// The transcript and composer column: about 71 Russian or 82 English characters at 15 pt.
    static let column: CGFloat = 560
}

/// Concentric radii: an inner shape's radius is the outer radius minus the padding between them.
enum Radius {
    static let control: CGFloat = 8
    static let card: CGFloat = 12
    static let bubble: CGFloat = 20
    static let composer: CGFloat = 24
}

enum AvatarSize {
    static let toolbar: CGFloat = 24
    /// A row of the Mac sidebar's team list.
    static let sidebar: CGFloat = 32
    static let row: CGFloat = 36
    static let header: CGFloat = 64
    static let hero: CGFloat = 96
}

extension View {
    /// A character whose device is out of reach rests in grey and returns with the character spring.
    func offlineCharacter(_ offline: Bool) -> some View {
        saturation(offline ? 0 : 1)
            .opacity(offline ? 0.6 : 1)
            .animation(.spring(response: 0.4, dampingFraction: 0.8), value: offline)
    }
}

/// The smallest comfortable hit target for a standalone control.
var controlTarget: CGFloat {
    #if os(iOS)
    44
    #else
    32
    #endif
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
        let destructive = configuration.role == .destructive
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        configuration.label
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(destructive ? AppTheme.destructive : AppTheme.accentText)
            .background((destructive ? AppTheme.destructive : AppTheme.accent).opacity(configuration.isPressed ? 0.22 : 0.10), in: shape)
            .contentShape(shape)
            .opacity(isEnabled ? 1 : 0.5)
    }
}

extension View {
    func adaptiveActionStyle<S: PrimitiveButtonStyle>(_ style: S) -> some View {
        modifier(AdaptiveActionStyle(regular: style))
    }
}
