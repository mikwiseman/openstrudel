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

    /// How wide a label of the given size is, so the shelf can decide once whether every tile's long label fits.
    static func labelWidth(_ text: String, size: CGFloat) -> CGFloat {
        #if os(macOS)
        let font = NSFont.systemFont(ofSize: size, weight: .semibold)
        #else
        let font = UIFont.systemFont(ofSize: size, weight: .semibold)
        #endif
        return (text as NSString).size(withAttributes: [.font: font]).width
    }
}

extension EnvironmentValues {
    /// Every desk's tile says «News · 5» instead of «News · 5 новых»: when one long label would not fit, all are short.
    @Entry var compactTileLabels = false
}

/// A title that steps its size down until it fits its lines, instead of being cut in the middle of a word. Only a
/// title too long for the smallest size is cut.
struct FittedTitle: View {
    let text: String
    let sizes: [CGFloat]
    var lines = 4
    /// How many lines the smallest size may take when even it does not fit `lines`.
    var most: Int? = nil
    var tracking: CGFloat = 0

    var body: some View {
        FirstFit(lines: lines) {
            ForEach(Array(sizes.enumerated()), id: \.offset) { index, size in
                Text(text).font(.system(size: size, weight: .medium, design: .serif)).tracking(tracking).lineSpacing(-1).multilineTextAlignment(.leading)
            }
            // The last resort: the smallest size, cut only when it must be.
            Text(text).font(.system(size: sizes.last ?? 12, weight: .medium, design: .serif)).tracking(tracking).lineSpacing(-1)
                .lineLimit(most ?? lines).multilineTextAlignment(.leading)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}

/// Shows the first of its candidates that takes no more than `lines` lines at the width it is given; the others wait
/// out of sight, where the tile's shape clips them.
private struct FirstFit: SwiftUI.Layout {
    let lines: Int

    private func choice(_ subviews: Subviews, width: CGFloat?) -> Int {
        for (index, view) in subviews.enumerated() {
            let line = view.sizeThatFits(.init(width: .infinity, height: nil)).height
            let whole = view.sizeThatFits(.init(width: width, height: nil)).height
            if line > 0, whole <= line * CGFloat(lines) + 1 { return index }
        }
        return subviews.count - 1
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        let size = subviews[choice(subviews, width: proposal.width)].sizeThatFits(.init(width: proposal.width, height: nil))
        return CGSize(width: proposal.width ?? size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }
        let chosen = choice(subviews, width: bounds.width)
        for (index, view) in subviews.enumerated() {
            view.place(at: CGPoint(x: bounds.minX, y: index == chosen ? bounds.minY : bounds.minY - 20_000), anchor: .topLeading,
                       proposal: .init(width: bounds.width, height: nil))
        }
    }
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
                // The label reads over a darkened top. The title brings its own scrim (`pictureScrim`), which starts
                // just above its first line, so the picture shows in everything the words leave free.
                .overlay(alignment: .top) {
                    LinearGradient(colors: [.black.opacity(0.5), .black.opacity(0)], startPoint: .top, endPoint: .bottom).frame(height: (height ?? side) * 0.3)
                }
                .overlay { Color.black.opacity(0.04) }
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
    @ScaledMetric(relativeTo: .caption) private var labelSize: CGFloat = 12

    /// One desk's long label does not fit: then every desk's label is the short one, so they read alike.
    private var compact: Bool {
        let room = TileMetrics.side - 2 * TileMetrics.padding - 1
        return tiles.contains { tile in
            guard case .desk(_, let name, _, _, _, _, let unseen) = tile, unseen > 0 else { return false }
            return TileMetrics.labelWidth(name + " · " + NewsWords().fresh(unseen), size: labelSize) > room
        }
    }

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
        .environment(\.compactTileLabels, compact)
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
                        Text(name + " · " + words.day(at, now: timeline.date)).font(AppTypography.label.weight(.regular)).opacity(0.62).lineLimit(2).minimumScaleFactor(0.8)
                    }
                    .padding(.top, TileMetrics.side * 0.13)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L("Дальше"))
            .accessibilityValue(name + ", " + TeamWords().moment(at))
        case .limit(let used, let weekly):
            LimitTile(used: used, weekly: weekly)
        case .progress(let done):
            Tile(label: L("Прогресс"), skin: .paper(AgentAppearance.tint(AgentAppearance(kind: "coil", tone: 1), dark: scheme == .dark))) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(done.formatted()).font(.system(size: TileMetrics.side * 0.26, weight: .semibold)).tracking(-1.6).monospacedDigit()
                        .contentTransition(.numericText(value: Double(done))).lineLimit(1).minimumScaleFactor(0.6)
                    Text(L("сделано за 7 дней")).font(AppTypography.label.weight(.regular)).opacity(0.62).lineLimit(2).minimumScaleFactor(0.8)
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

/// A desk's lead story: its picture when it has one, otherwise the desk's own paper. On paper a title that starts
/// with a name («Имя: что это») shows the name large and the rest small under it.
private struct DeskTile: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.compactTileLabels) private var compact
    let name: String
    let appearance: AgentAppearance
    let title: String
    let image: String?
    let host: String?
    let unseen: Int
    @State private var picture: CGImage?

    private var short: String { unseen > 0 ? name + " · " + unseen.formatted() : name }
    private var label: String { unseen > 0 && !compact ? name + " · " + NewsWords().fresh(unseen) : short }

    var body: some View {
        let shown = picture ?? StoryPictures.cached(image)
        Tile(label: label, shortLabel: short, skin: shown.map { .picture($0) } ?? .paper(AgentAppearance.tint(appearance, dark: scheme == .dark))) {
            if shown == nil, let named = Shelf.named(title) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(named.name).font(.system(size: TileMetrics.side * 0.175, weight: .medium, design: .serif)).tracking(-0.4)
                        .lineLimit(2).minimumScaleFactor(0.7)
                    Text(Shelf.clipped(named.rest, to: 38)).font(.system(size: TileMetrics.side * 0.082)).opacity(0.7).lineSpacing(0.5).lineLimit(2)
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(.top, TileMetrics.side * 0.09)
            } else {
                Spacer(minLength: 6)
                TileTitle(text: title, picture: shown != nil)
            }
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

/// A tile's serif title: at most four lines, a step smaller rather than cut. Over a picture it starts a size down
/// and stands on its own scrim.
private struct TileTitle: View {
    let text: String
    let picture: Bool
    var body: some View {
        // Over a picture the title keeps to three lines while it can, so the picture has the top of the tile.
        let scale = max(TileMetrics.side / 150, 0.92)
        FittedTitle(text: text, sizes: (picture ? [15.5, 14.5, 13.5, 12.5] : [17, 15.5, 14, 13, 12.5]).map { $0 * scale }, lines: picture ? 3 : 4, most: 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .pictureScrim(picture)
    }
}

extension View {
    /// Under a title that stands on a picture: the picture darkens to near ink just above the first line and stays
    /// so to the tile's edges, however many lines the title takes. No detail of the picture runs through the words.
    func pictureScrim(_ on: Bool = true) -> some View {
        background {
            if on {
                VStack(spacing: 0) {
                    LinearGradient(colors: [.black.opacity(0), .black.opacity(0.86)], startPoint: .top, endPoint: .bottom).frame(height: 28)
                    Color.black.opacity(0.86)
                }
                .padding(.top, -32).padding(.horizontal, -TileMetrics.padding).padding(.bottom, -TileMetrics.padding)
                .allowsHitTesting(false)
            }
        }
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
            TileTitle(text: text, picture: shown != nil)
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

/// A row of data tiles at the top of a page behind a tile: the same squares as the home's shelf, scrolling sideways
/// when the page is narrower than they are.
struct DataShelf<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: TileMetrics.gap) { content }
                .scrollTargetLayout()
                // Room for the shadows, which the scroll view would otherwise cut.
                .padding(.top, 6).padding(.bottom, 26)
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }
}

/// One number as a tile: its name, the figure, and a quiet word about it.
struct NumberTile: View {
    let label: String
    let value: String
    var caption: String? = nil
    var skin: TileSkin = .plain
    var body: some View {
        Tile(label: label, skin: skin) {
            VStack(alignment: .leading, spacing: 6) {
                Text(value).font(.system(size: TileMetrics.side * 0.26, weight: .semibold)).tracking(-1.6).monospacedDigit()
                    .contentTransition(.numericText()).lineLimit(1).minimumScaleFactor(0.5)
                if let caption { Text(caption).font(AppTypography.label.weight(.regular)).opacity(0.62).lineLimit(2).minimumScaleFactor(0.8) }
            }
            .padding(.top, TileMetrics.side * 0.13)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue([value, caption].compactMap { $0 }.joined(separator: ", "))
    }
}

/// The fullest limit as a tile, as on the home.
struct LimitTile: View {
    let used: Double
    let weekly: Bool
    var body: some View {
        Tile(label: weekly ? L("Лимит недели") : L("Лимит"), skin: .plain) {
            UsageRing(used: used).frame(maxWidth: .infinity, maxHeight: .infinity).padding(.top, 8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(weekly ? L("Лимит недели") : L("Лимит"))
        .accessibilityValue(used.formatted(.percent.precision(.fractionLength(0))))
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
