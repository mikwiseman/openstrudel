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
    /// The lead names a picture that did not come.
    @State private var missed = false

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
        // Set in words only when no picture is coming: a headline that grew at every launch and shrank again when the
        // picture landed would be a flicker.
        let inWords = shown == nil && (lead?.image == nil || missed || picture != nil)
        let label = unseen > 0 ? paper.name + " · " + words.fresh(unseen) : paper.name
        // Until the first story, the desk says what will be here in the language of its own interface.
        let title = lead?.title ?? (feed.loaded ? L("Сегодняшние новости появятся здесь") : "")
        Tile(label: label, shortLabel: unseen > 0 ? paper.name + " · " + unseen.formatted() : paper.name,
             skin: shown.map { .picture($0) } ?? .paper(AgentAppearance.tint(paper.appearance, dark: scheme == .dark)),
             side: .infinity, height: Self.height, radius: TileMetrics.radius + 2) {
            Spacer(minLength: 8)
            FittedTitle(text: title, sizes: inWords ? Self.wordSizes : Self.sizes, lines: inWords ? 4 : 3, most: 4, tracking: -0.3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .pictureScrim(shown != nil)
        }
        .animation(.smooth(duration: 0.3), value: shown != nil)
        .task(id: lead?.image) {
            missed = false
            guard let image = lead?.image else { picture = nil; return }
            picture = await StoryPictures.load(image, home: paper.host)
            missed = picture == nil && !Task.isCancelled
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(title)
    }
}

/// A desk's paper on the phone's first page: whose it is and how much of it is new, the lead with its picture and its
/// headline under it, then the next headlines to scan. A story opens over the desk's own page; the first line opens
/// the whole paper. Only the first paper of the page leads with a picture, so two desks never read as two front pages.
struct TodayPaper: View {
    let paper: NewsPaperShelf.Paper
    @ObservedObject var feed: NewsFeed
    /// The first paper of the page: its lead is set large, with its picture.
    let leads: Bool
    let zoom: Namespace.ID
    let openDesk: () -> Void
    let openStory: (String) -> Void
    @State private var picture: CGImage?
    /// Headlines under the lead.
    private static let rows = 3

    var body: some View {
        let words = feed.words, front = feed.latest.front(read: feed.read), unseen = front.unseen(feed.read)
        let stories = front.stories, lead = leads ? stories.first : nil
        // A desk whose runs fail shows the paper it last made, and shows that it is not today's.
        let stale = front.standsIn && NewsStatusLine(status: feed.status, front: front).isFailing
        VStack(alignment: .leading, spacing: 0) {
            Button(action: openDesk) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(paper.name).font(AppTypography.label).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
                    Spacer(minLength: 8)
                    Group {
                        if front.standsIn { Text(words("Выпуск за \(words.day(front.date))")) }
                        else if unseen > 0 { Text(words.fresh(unseen)).foregroundStyle(AppTheme.signalText) }
                        else if !stories.isEmpty { Text(words.stories(stories.count)) }
                    }
                    .font(.footnote).monospacedDigit().foregroundStyle(AppTheme.faint).lineLimit(1)
                    Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(AppTheme.faint)
                }
                .frame(minHeight: max(32, controlTarget * 0.8)).contentShape(Rectangle())
            }
            .buttonStyle(NewsRowStyle())
            .zoomSource(AnyHashable("tile:desk:" + paper.route.id), in: zoom)
            // Read as the desk's tile is beside an open place: whose paper, how much is new, and its lead.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(unseen > 0 ? paper.name + " · " + words.fresh(unseen) : paper.name)
            .accessibilityValue(stories.first?.story.title ?? (feed.loaded ? L("Сегодняшние новости появятся здесь") : ""))
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("tile-desk:" + paper.route.id)
            Group {
                if let lead {
                    Button { openStory(lead.id) } label: { leadStory(lead, words: words) }
                        .buttonStyle(NewsRowStyle())
                        .accessibilityElement(children: .combine)
                        .accessibilityHint(words("Открыть историю"))
                        .accessibilityIdentifier("todayLead")
                }
                ForEach(stories.dropFirst(lead == nil ? 0 : 1).prefix(Self.rows)) { item in
                    NewsCompactRow(item: item, line: newsLine(item.story, locale: words.language.locale), developed: item.developed(since: feed.read)) { openStory(item.id) }
                        .accessibilityIdentifier("todayStory-" + item.id)
                }
                if stories.isEmpty, feed.loaded {
                    // Until the first story, the desk says what will be here.
                    Text(L("Сегодняшние новости появятся здесь")).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText)
                        .padding(.top, 4)
                }
            }
            .opacity(stale ? 0.5 : 1)
        }
        .environment(\.newsWords, words)
        .task(id: lead?.story.image) {
            guard let address = lead?.story.image else { picture = nil; return }
            picture = await StoryPictures.load(address, home: paper.host)
        }
    }

    private func leadStory(_ item: NewsDesk.Item, words: NewsWords) -> some View {
        let story = item.story, shown = StoryPictures.covers(picture ?? StoryPictures.cached(story.image))
        return VStack(alignment: .leading, spacing: 0) {
            if let shown {
                // The picture keeps one shape whatever its own is, so the page does not change its rhythm by the day.
                Color.clear.aspectRatio(2, contentMode: .fit)
                    .overlay { Image(decorative: shown, scale: 1).resizable().scaledToFill() }
                    .clipShape(.rect(cornerRadius: 28, style: .continuous))
                    .tileShadow()
                    .padding(.top, 6).padding(.bottom, 14)
                    .transition(.opacity)
            }
            QuietLine(text: newsLine(story, locale: words.language.locale), developed: item.developed(since: feed.read))
            Text(story.title).font(NewsType.headline(26, .title2)).tracking(-0.3)
                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 10)
        .contentShape(.rect)
        .animation(.smooth(duration: 0.3), value: shown != nil)
    }
}
