import SwiftUI

/// Semantic colors with light, dark and increased-contrast variants (docs/design-system.md).
/// The canvas is warm paper; sheets, forms and popovers keep system backgrounds.
enum AppTheme {
    static let canvas = Color("CanvasColor")
    /// A quiet fill on the paper: code blocks, file chips, source capsules, secondary buttons, other people's messages.
    static let surface = Color("SurfaceColor")
    /// The face of a card or a data tile: white on the paper, a step above the canvas in dark.
    static let tile = Color("TileColor")
    /// The person's bubble is ink, light in dark; its words use `canvas`.
    static let userBubble = Color("UserBubbleColor")
    /// Hairlines and rules only, never an input border.
    static let separator = Color("SeparatorColor")
    /// The neutral system accent: focus, switches and checkboxes.
    static let accent = Color("AccentColor")
    /// Ink: text, links (underlined), the send button and primary fills, whose labels use the canvas colour.
    static let accentText = Color("AccentText")
    static let secondaryText = Color("SecondaryText")
    /// Times and date lines that only place a thing in the day.
    static let faint = Color("FaintText")
    /// The one signal colour: something new, someone working, the arrow of a story's view.
    static let signal = Color("SignalColor")
    static let warning = Color("WarningText")
    static let destructive = Color("DestructiveText")
}

extension AgentAppearance {
    /// The paper tint of a character's tone: the circle behind it and its tiles. Nil is the main assistant's apricot.
    static func tint(_ appearance: AgentAppearance?, dark: Bool) -> Color {
        let angle = appearance.flatMap { $0.isValid ? angles[$0.tone] : nil } ?? 0
        let hue = (30 + angle).truncatingRemainder(dividingBy: 360) / 360
        return dark ? Color(hue: hue, saturation: 0.28, brightness: 0.27) : Color(hue: hue, saturation: 0.17, brightness: 0.975)
    }
}

/// One superfamily: SF for the interface and reading, SF Rounded for display, SF Mono for code.
/// Hebrew falls back to SF Hebrew and SF Hebrew Rounded by itself.
enum AppTypography {
    /// Page titles, welcome and onboarding: SF semibold, set tight with `displayTracking`.
    static var display: Font {
        #if os(macOS)
        .system(size: 26, weight: .semibold)
        #else
        .system(.title, weight: .semibold)
        #endif
    }
    /// Editorial headlines and tile titles: New York medium.
    static func serif(_ mac: CGFloat, _ style: Font.TextStyle, weight: Font.Weight = .medium) -> Font {
        #if os(macOS)
        .system(size: mac, weight: weight, design: .serif)
        #else
        .system(style, design: .serif, weight: weight)
        #endif
    }
    /// The small sentence-case label over a tile or a section.
    static var label: Font {
        #if os(macOS)
        .system(size: 12, weight: .semibold)
        #else
        .caption.weight(.semibold)
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
    static let bubble: CGFloat = 24
    /// The corner of a bubble that points at its author.
    static let bubbleTail: CGFloat = 8
    static let composer: CGFloat = 26
    /// Cards in the transcript: questions, approvals, files.
    static let cardTile: CGFloat = 28
}

enum AvatarSize {
    static let toolbar: CGFloat = 24
    /// The character in a title capsule.
    static let capsule: CGFloat = 30
    static let row: CGFloat = 36
    /// A row of the team list: 54 on a phone, 40 in the Mac sidebar.
    static var team: CGFloat {
        #if os(macOS)
        40
        #else
        54
        #endif
    }
    static let header: CGFloat = 64
    static let hero: CGFloat = 96
}

extension View {
    /// Display type is set tight; the larger the type, the tighter.
    func displayTracking(_ amount: CGFloat = -0.6) -> some View { tracking(amount) }

    /// The paper rising softly behind a floating control at the bottom, so what scrolls under it fades instead of
    /// showing through. Glass stays glass; this is the page under it.
    func dockFade() -> some View {
        background {
            LinearGradient(stops: [.init(color: AppTheme.canvas.opacity(0), location: 0), .init(color: AppTheme.canvas.opacity(0.9), location: 0.28), .init(color: AppTheme.canvas, location: 0.5)],
                           startPoint: .top, endPoint: .bottom)
                .padding(.top, -28).ignoresSafeArea(edges: .bottom).allowsHitTesting(false)
        }
    }

    /// The soft two-layer shadow under a tile or a card; none where the reader asked for more contrast.
    func tileShadow(_ strength: Double = 1) -> some View {
        shadow(color: .black.opacity(0.10 * strength), radius: 13, y: 10).shadow(color: .black.opacity(0.05 * strength), radius: 2, y: 1)
    }
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
