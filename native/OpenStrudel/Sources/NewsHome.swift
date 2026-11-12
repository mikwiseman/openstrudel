import SwiftUI

/// The way into the news from the home: each desk's paper as a wide tile at the top, with its lead story, its picture
/// and how many stories are unseen. One press opens today's front page. The tile is there from the first moment, from
/// the copy of the paper the device keeps, and stays when the desk has nothing yet.
struct NewsPaperShelf: View {
    struct Paper: Identifiable {
        let route: ReaderRoute
        let name: String
        let appearance: AgentAppearance
        let feed: NewsFeed
        /// The desk's own Home: a picture it serves itself is read like the rest of the page.
        let host: String?
        var id: String { route.id }
    }

    let papers: [Paper]
    let margin: CGFloat
    let zoom: Namespace.ID
    let open: (ReaderRoute) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: TileMetrics.gap) {
                ForEach(papers) { paper in
                    Button { open(paper.route) } label: { NewsPaperTile(paper: paper, feed: paper.feed) }
                        .buttonStyle(TilePressStyle())
                        .zoomSource(AnyHashable("tile:desk:" + paper.route.id), in: zoom)
                        // One paper fills the row; of several, the next one shows its edge.
                        .containerRelativeFrame(.horizontal) { length, _ in papers.count == 1 ? length : length * 0.86 }
                        .accessibilityIdentifier("tile-desk:" + paper.route.id)
                }
            }
            .scrollTargetLayout()
            // Room for the shadows, which the scroll view would otherwise cut.
            .padding(.top, 6).padding(.bottom, 20)
        }
        .contentMargins(.horizontal, margin, for: .scrollContent)
        .scrollTargetBehavior(.viewAligned)
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }
}

private struct NewsPaperTile: View {
    let paper: NewsPaperShelf.Paper
    @ObservedObject var feed: NewsFeed
    @Environment(\.colorScheme) private var scheme
    @State private var picture: CGImage?

    private static var height: CGFloat {
        #if os(macOS)
        148
        #else
        184
        #endif
    }
    private static var sizes: [CGFloat] {
        #if os(macOS)
        [19, 17.5, 16, 15, 14]
        #else
        [23, 21, 19, 17.5, 16]
        #endif
    }
    /// With no picture the headline is the tile's face: larger, on as many lines as the tile holds.
    private static var wordSizes: [CGFloat] {
        #if os(macOS)
        [21, 19, 17.5, 16, 15, 14]
        #else
        [27, 25, 23, 21, 19, 17]
        #endif
    }

    var body: some View {
        let lead = feed.lead?.story, unseen = feed.unseen, words = NewsWords()
        let shown = StoryPictures.covers(picture ?? StoryPictures.cached(lead?.image))
        let label = unseen > 0 ? paper.name + " · " + words.fresh(unseen) : paper.name
        // Until the first story, the desk says what will be here in the language of its own interface.
        let title = lead?.title ?? (feed.loaded ? L("Сегодняшние новости появятся здесь") : "")
        Tile(label: label, shortLabel: unseen > 0 ? paper.name + " · " + unseen.formatted() : paper.name,
             skin: shown.map { .picture($0) } ?? .paper(AgentAppearance.tint(paper.appearance, dark: scheme == .dark)),
             side: .infinity, height: Self.height, radius: TileMetrics.radius + 2) {
            Spacer(minLength: 8)
            FittedTitle(text: title, sizes: shown == nil ? Self.wordSizes : Self.sizes, lines: shown == nil ? 4 : 3, most: 4, tracking: -0.3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .pictureScrim(shown != nil)
        }
        .animation(.smooth(duration: 0.3), value: shown != nil)
        .task(id: lead?.image) {
            guard let image = lead?.image else { picture = nil; return }
            picture = await StoryPictures.load(image, home: paper.host)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(title)
    }
}
