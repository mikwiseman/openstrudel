import SwiftUI

/// Tiles are the content's face: a squircle with a soft shadow, a small sentence-case label and one big thing.
/// A picture tile carries a story's image under a scrim; a paper tile is tinted from an employee's tone; a data tile
/// is plain. They press with a spring and never use glass: glass is for controls.
enum TileMetrics {
    #if os(macOS)
    static let side: CGFloat = 126
    static let radius: CGFloat = 30
    static let padding: CGFloat = 14
    static let gap: CGFloat = 10
    #else
    static let side: CGFloat = 150
    static let radius: CGFloat = 36
    static let padding: CGFloat = 16
    static let gap: CGFloat = 12
    #endif
}

enum TileSkin {
    /// A tint from a character's tone.
    case paper(Color)
    /// Ink in light, light in dark; its words are the canvas colour.
    case ink
    /// White on the paper, a step above the canvas in dark.
    case plain
    case picture(CGImage)
}

struct Tile<Content: View>: View {
    @Environment(\.colorSchemeContrast) private var contrast
    let label: String
    /// What the label says when the whole of it does not fit on one line.
    var shortLabel: String? = nil
    let skin: TileSkin
    var side: CGFloat = TileMetrics.side
    var height: CGFloat? = nil
    var radius: CGFloat = TileMetrics.radius
    @ViewBuilder var content: Content

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ViewThatFits(in: .horizontal) {
                Text(label).lineLimit(1)
                if let shortLabel { Text(shortLabel).lineLimit(1) }
                Text(shortLabel ?? label).lineLimit(1).truncationMode(.tail)
            }
            .font(AppTypography.label).opacity(0.72)
            .contentTransition(.numericText())
            content
        }
        .padding(TileMetrics.padding)
        .frame(width: side == .infinity ? nil : side, height: height ?? side, alignment: .topLeading)
        .frame(maxWidth: side == .infinity ? .infinity : nil, alignment: .topLeading)
        .foregroundStyle(foreground)
        .background { background }
        .clipShape(shape)
        .overlay { shape.strokeBorder(contrast == .increased ? AnyShapeStyle(AppTheme.separator) : AnyShapeStyle(.white.opacity(0.18)), lineWidth: 1) }
        .contentShape(shape)
        .tileShadow()
        // A tile is read like a widget: its type follows the reader's size only as far as its face allows.
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }

    private var foreground: AnyShapeStyle {
        switch skin {
        case .ink: AnyShapeStyle(AppTheme.canvas)
        case .picture: AnyShapeStyle(.white)
        case .paper, .plain: AnyShapeStyle(.primary)
        }
    }

    @ViewBuilder private var background: some View {
        switch skin {
        case .paper(let tint): tint
        case .ink: AppTheme.accentText
        case .plain: AppTheme.tile
        case .picture(let image):
            Image(decorative: image, scale: 1).resizable().scaledToFill()
                // The label and the title stay readable over any picture.
                .overlay { LinearGradient(stops: [.init(color: .black.opacity(0.56), location: 0), .init(color: .black.opacity(0.10), location: 0.27),
                                                   .init(color: .black.opacity(0.14), location: 0.40), .init(color: .black.opacity(0.74), location: 0.70),
                                                   .init(color: .black.opacity(0.88), location: 1)], startPoint: .top, endPoint: .bottom) }
        }
    }
}

/// A tile presses like a real thing: down at once, back with a spring.
struct TilePressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.7 : 1)
            .animation(configuration.isPressed ? .easeOut(duration: 0.1) : .spring(response: 0.35, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// A story's picture, kept once it has loaded, so a tile and its page share it.
@MainActor
enum StoryPictures {
    private static var loaded: [String: CGImage] = [:]
    static func cached(_ address: String?) -> CGImage? { address.flatMap { loaded[$0] } }
    static func load(_ address: String, home: String?) async -> CGImage? {
        if let image = loaded[address] { return image }
        guard let image = try? await ChatMedia.picture(address, home: home) else { return nil }
        loaded[address] = image
        return image
    }
}

/// A picture an employee attached to its answer, read from its Home once and kept for the tile.
@MainActor
enum ResultPictures {
    private static var loaded: [String: CGImage] = [:]
    static func cached(_ file: ChatAttachment) -> CGImage? { loaded[file.id] }
    static func load(_ file: ChatAttachment, from home: HomeClient) async -> CGImage? {
        if let image = loaded[file.id] { return image }
        guard let url = try? await home.downloadFile(file), let image = ChatMedia.thumbnail(url, maxPixels: 720) else { return nil }
        loaded[file.id] = image
        return image
    }
}

/// The home's shelf: today's work as tiles, in one row up to three and two rows beyond, scrolling sideways.
struct HomeShelf: View {
    let tiles: [ShelfTile]
    let margin: CGFloat
    /// What a tile's page grows out of. A tile and a row can open the same page; each names itself.
    let source: (ShelfTile) -> AnyHashable
    let zoom: Namespace.ID
    let open: (ShelfTile) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: TileMetrics.gap) {
                ForEach(Shelf.columns(tiles), id: \.first?.id) { column in
                    VStack(spacing: TileMetrics.gap) {
                        ForEach(column) { tile in
                            Button { open(tile) } label: { ShelfTileView(tile: tile) }
                                .buttonStyle(TilePressStyle())
                                .zoomSource(source(tile), in: zoom)
                                .accessibilityIdentifier("tile-" + tile.id)
                        }
                    }
                }
            }
            .scrollTargetLayout()
            // Room for the shadows, which the scroll view would otherwise cut.
            .padding(.top, 6).padding(.bottom, 26)
        }
        .contentMargins(.horizontal, margin, for: .scrollContent)
        .scrollTargetBehavior(.viewAligned)
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
        .animation(.smooth(duration: 0.25), value: tiles.map(\.id))
    }
}

extension View {
    /// Where a page zooms out of, on the platforms that zoom.
    @ViewBuilder func zoomSource(_ id: AnyHashable, in namespace: Namespace.ID) -> some View {
        #if os(iOS)
        matchedTransitionSource(id: id, in: namespace)
        #else
        self
        #endif
    }
}

private struct ShelfTileView: View {
    @Environment(\.colorScheme) private var scheme
    let tile: ShelfTile

    var body: some View {
        switch tile {
        case .desk(_, let name, let appearance, let title, let image, let host, let unseen):
            DeskTile(name: name, appearance: appearance, title: title, image: image, host: host, unseen: unseen)
        case .important(let open, let done):
            Tile(label: L("Что важно"), skin: .paper(AgentAppearance.tint(AgentAppearance(kind: "coil", tone: 6), dark: scheme == .dark))) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(open.enumerated()), id: \.offset) { _, line in check(line, done: false) }
                    ForEach(Array(done.enumerated()), id: \.offset) { _, line in check(line, done: true) }
                }
                .padding(.top, 12)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L("Что важно"))
            .accessibilityValue((open + done).joined(separator: ", "))
        case .next(_, let name, let at):
            Tile(label: L("Дальше"), skin: .ink) {
                TimelineView(.everyMinute) { timeline in
                    let words = TeamWords()
                    VStack(alignment: .leading, spacing: 6) {
                        Text(words.time(at)).font(.system(size: TileMetrics.side * 0.26, weight: .semibold)).tracking(-1.6).monospacedDigit()
                            .lineLimit(1).minimumScaleFactor(0.6)
                        Text(name + " · " + words.day(at, now: timeline.date)).font(AppTypography.label.weight(.regular)).opacity(0.62).lineLimit(2)
                    }
                    .padding(.top, TileMetrics.side * 0.13)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L("Дальше"))
            .accessibilityValue(name + ", " + TeamWords().moment(at))
        case .limit(let used, let weekly):
            Tile(label: weekly ? L("Лимит недели") : L("Лимит"), skin: .plain) {
                UsageRing(used: used).frame(maxWidth: .infinity, maxHeight: .infinity).padding(.top, 8)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(weekly ? L("Лимит недели") : L("Лимит"))
            .accessibilityValue(used.formatted(.percent.precision(.fractionLength(0))))
        case .progress(let done):
            Tile(label: L("Прогресс"), skin: .paper(AgentAppearance.tint(AgentAppearance(kind: "coil", tone: 1), dark: scheme == .dark))) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(done.formatted()).font(.system(size: TileMetrics.side * 0.26, weight: .semibold)).tracking(-1.6).monospacedDigit()
                        .contentTransition(.numericText(value: Double(done))).lineLimit(1).minimumScaleFactor(0.6)
                    Text(L("сделано за 7 дней")).font(AppTypography.label.weight(.regular)).opacity(0.62).lineLimit(2)
                }
                .padding(.top, TileMetrics.side * 0.13)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L("Прогресс"))
            .accessibilityValue(done.formatted() + ", " + L("сделано за 7 дней"))
        case .result(let route, let name, let appearance, let text, let file):
            ResultTile(connection: route.connectionID, name: name, appearance: appearance, text: text, file: file)
        }
    }

    private func check(_ line: String, done: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle").font(.system(size: 14, weight: .medium))
                .foregroundStyle(AppTheme.signal).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2.5 }
            Text(line).font(.system(size: 13, weight: .medium)).lineLimit(done ? 1 : 2).multilineTextAlignment(.leading)
        }
        .opacity(done ? 0.5 : 1)
    }
}

/// A desk's lead story: its picture when it has one, otherwise the desk's own paper.
private struct DeskTile: View {
    @Environment(\.colorScheme) private var scheme
    let name: String
    let appearance: AgentAppearance
    let title: String
    let image: String?
    let host: String?
    let unseen: Int
    @State private var picture: CGImage?

    private var label: String { unseen > 0 ? name + " · " + NewsWords().fresh(unseen) : name }

    var body: some View {
        let shown = picture ?? StoryPictures.cached(image)
        Tile(label: label, shortLabel: unseen > 0 ? name + " · " + unseen.formatted() : nil,
             skin: shown.map { .picture($0) } ?? .paper(AgentAppearance.tint(appearance, dark: scheme == .dark))) {
            Spacer(minLength: 6)
            Text(title).font(.system(size: shown == nil ? 17 : 15.5, weight: .medium, design: .serif)).lineSpacing(-1)
                .lineLimit(shown == nil ? 5 : 4).minimumScaleFactor(0.85).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .animation(.smooth(duration: 0.3), value: shown != nil)
        .task(id: image) {
            guard let image else { picture = nil; return }
            picture = await StoryPictures.load(image, home: host)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(title)
    }
}

/// An employee's answer that came with a picture: the picture, the employee's name and the answer's first words.
/// Until the picture is read from its Home, the employee's own paper.
private struct ResultTile: View {
    @EnvironmentObject private var library: DeviceLibrary
    @Environment(\.colorScheme) private var scheme
    let connection: String
    let name: String
    let appearance: AgentAppearance
    let text: String
    let file: ChatAttachment
    @State private var picture: CGImage?

    var body: some View {
        let shown = picture ?? ResultPictures.cached(file)
        Tile(label: name, skin: shown.map { .picture($0) } ?? .paper(AgentAppearance.tint(appearance, dark: scheme == .dark))) {
            Spacer(minLength: 6)
            Text(text).font(.system(size: shown == nil ? 17 : 15.5, weight: .medium, design: .serif)).lineSpacing(-1)
                .lineLimit(shown == nil ? 5 : 3).minimumScaleFactor(0.85).multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .animation(.smooth(duration: 0.3), value: shown != nil)
        .task(id: file.id) {
            guard let home = library.visibleClients.first(where: { $0.id == connection }) else { return }
            picture = await ResultPictures.load(file, from: home)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name)
        .accessibilityValue(text)
    }
}

/// How much of a limit is used: an ink arc on a quiet track, the number inside.
struct UsageRing: View {
    let used: Double

    var body: some View {
        ZStack {
            Circle().stroke(AppTheme.surface, lineWidth: 9)
            Circle().trim(from: 0, to: max(0.02, min(1, used))).stroke(AppTheme.accentText, style: StrokeStyle(lineWidth: 9, lineCap: .round)).rotationEffect(.degrees(-90))
            Text(used.formatted(.percent.precision(.fractionLength(0)))).font(.system(size: 18, weight: .semibold)).tracking(-0.5).monospacedDigit()
                .contentTransition(.numericText(value: used))
        }
        .padding(5)
        .aspectRatio(1, contentMode: .fit)
        .animation(.smooth(duration: 0.4), value: used)
    }
}
