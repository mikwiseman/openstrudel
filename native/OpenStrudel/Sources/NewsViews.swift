import SwiftUI

/// A desk's stories as a paper a day: the day and one quiet line about the desk's runs, three ways further (the week,
/// the post drafts, the search), the lead as a large tile, what came since the reader last looked, the top stories,
/// the day's analysis, the rest under their sections, and the earlier days as a shelf of issues. A story opens over
/// its page with its numbers, its evidence and its earlier chapters, and a post for the owner's channel is one press
/// away. Discussion happens in the chat: the capsule at the bottom takes the story there.

/// The edition's voice: New York for headlines, the interface face for reading, quiet sentence-case lines for the rest.
enum NewsType {
    static func headline(_ mac: CGFloat, _ style: Font.TextStyle, weight: Font.Weight = .medium) -> Font { AppTypography.serif(mac, style, weight: weight) }
    /// Time, section and status over a headline.
    static var quiet: Font { ReaderLine.font }
    /// The small name over a group of stories.
    static var head: Font { ReaderLine.font.weight(.semibold) }
    /// The day at the top of a desk's page.
    static var dayTitle: Font {
        #if os(macOS)
        .system(size: 28, weight: .semibold)
        #else
        .system(.title, weight: .semibold)
        #endif
    }
}

enum NewsLayout {
    /// The page's reading column, wider than the chat's for headlines; a story reads in a narrower one.
    static let column: CGFloat = 680
    static let story: CGFloat = 620
    static var lead: CGFloat {
        #if os(macOS)
        300
        #else
        236
        #endif
    }
    /// The lead headline's sizes, largest first.
    static var leadSizes: [CGFloat] {
        #if os(macOS)
        [30, 27, 24, 21]
        #else
        [24, 22, 20, 18]
        #endif
    }
    /// A lead with no picture is set in words: its headline is the face of the tile, a step larger.
    static var leadWordSizes: [CGFloat] {
        #if os(macOS)
        [38, 34, 30, 27, 24]
        #else
        [31, 28, 25, 22, 20]
        #endif
    }
    /// The figure such a lead stands on, when its story has one.
    static var leadFigure: CGFloat {
        #if os(macOS)
        76
        #else
        64
        #endif
    }
}

extension EnvironmentValues {
    /// The language of the stories on screen. Every label and date of the reader follows it.
    @Entry var newsWords = NewsWords()
    /// The desk's own Home: a picture it serves itself is read like the rest of the page.
    @Entry var newsHome: String? = nil
}

extension NewsStory {
    /// Where the story comes from, as the reader would name it: each source's site once.
    var domains: [String] {
        var seen = Set<String>()
        return sources.compactMap { URL(string: $0.url)?.host() }.map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }.filter { seen.insert($0).inserted }
    }
}

/// A row is its own button: it dims under the finger and springs back.
struct NewsRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(configuration.isPressed ? .easeOut(duration: 0.08) : .spring(response: 0.35, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

/// Where a story belongs and how sure it is, in one quiet sentence-case line: «Модели · вышло».
func newsLine(_ story: NewsStory, locale: Locale) -> String {
    [story.section, story.status.lowercased(with: locale)].filter { !$0.isEmpty }.joined(separator: " · ")
}

struct QuietLine: View {
    let text: String
    /// ↻: the story moved since the reader had it on screen.
    var developed = false
    @Environment(\.newsWords) private var words

    var body: some View {
        HStack(spacing: 5) {
            if developed { Text("↻").foregroundStyle(AppTheme.signalText).fontWeight(.semibold).accessibilityLabel(words("Развитие истории")) }
            Text(text).foregroundStyle(AppTheme.secondaryText)
        }
        .font(NewsType.quiet).monospacedDigit()
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
}

/// The desk's own conclusion, set apart by one arrow in the signal colour.
struct ViewLine: View {
    let text: String
    var limit: Int? = nil
    @Environment(\.newsWords) private var words

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // A symbol, so it points the other way in a language that reads from the right.
            Image(systemName: "arrow.forward").imageScale(.small).fontWeight(.semibold).foregroundStyle(AppTheme.signalText).accessibilityHidden(true)
            Text(text).lineLimit(limit).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(words("Наш взгляд") + ": " + text)
    }
}

/// Small capsules that wrap: a story's sources.
struct Capsules: SwiftUI.Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(bounds.width, subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func rows(_ width: CGFloat, _ subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
            if let last = rows.last, last.width + spacing + size.width <= width {
                rows[rows.count - 1] = (last.items + [index], last.width + spacing + size.width, max(last.height, size.height))
            } else { rows.append(([index], min(size.width, width), size.height)) }
        }
        return rows
    }
}

struct SourceCapsule: View {
    let title: String
    var symbol: String? = nil
    var body: some View {
        HStack(spacing: 6) {
            if let symbol { Image(systemName: symbol).imageScale(.small).foregroundStyle(AppTheme.secondaryText) }
            Text(title).lineLimit(1)
        }
        .font(NewsType.quiet.weight(.medium)).foregroundStyle(.primary)
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(AppTheme.surface, in: Capsule())
    }
}

/// A story's picture on its own page: a tile. Nothing is kept for it: it takes its place when it has loaded, and
/// one that does not load stays out without a word.
private struct NewsPicture: View {
    let address: String?
    let maxHeight: CGFloat
    @State private var image: CGImage?
    @Environment(\.newsHome) private var home
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(address: String?, maxHeight: CGFloat) {
        self.address = address; self.maxHeight = maxHeight
        _image = State(initialValue: StoryPictures.cached(address))
    }

    var body: some View {
        VStack(spacing: 0) {
            if let image {
                // The picture's own shape inside the column and the cap, so its corners are the picture's.
                // The corners and the shadow belong to the picture itself, so they are set before the cap on its height:
                // a wide column would otherwise round a frame wider than the picture and leave its corners square.
                Image(decorative: image, scale: 1).resizable()
                    .aspectRatio(CGFloat(image.width) / CGFloat(max(image.height, 1)), contentMode: .fit)
                    .clipShape(.rect(cornerRadius: 28, style: .continuous))
                    .tileShadow()
                    .frame(maxHeight: maxHeight)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 24)
                    .transition(.opacity)
                    .accessibilityElement()
                    .accessibilityLabel(L("Фото"))
                    .accessibilityAddTraits(.isImage)
                    .accessibilityIdentifier("newsPicture")
            }
        }
        .task(id: address) {
            guard let address, image == nil, let picture = await StoryPictures.load(address, home: home), !Task.isCancelled else { return }
            withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : .smooth(duration: 0.25)) { image = picture }
        }
    }
}

// MARK: - The screen

/// One desk, opened from the home or from the conversations list.
struct NewsScreen: View {
    @EnvironmentObject private var library: DeviceLibrary
    @EnvironmentObject private var client: HomeClient
    @ObservedObject var feed: NewsFeed
    let discuss: (ChatContext) -> Void
    @State private var unavailable: String?
    #if os(macOS)
    @Environment(\.appearsActive) private var appearsActive
    #else
    @Environment(\.scenePhase) private var scenePhase
    #endif

    private var profile: EmployeeProfile? { client.profiles.first { $0.id == feed.route.profileID } }
    private var windowIsActive: Bool {
        #if os(macOS)
        appearsActive
        #else
        scenePhase == .active
        #endif
    }

    var body: some View {
        NewsDayPage(feed: feed, date: nil, chrome: NewsChrome(profile: profile, attentive: windowIsActive, discuss: quote))
            .environment(\.newsHome, URL(string: client.normalizedBaseURL)?.host)
            // Stories that arrive behind another app are read as new when the reader comes back.
            .onChange(of: windowIsActive, initial: true) { _, active in feed.attend(active) }
            .alert(L("Нет связи"), isPresented: Binding(get: { unavailable != nil }, set: { if !$0 { unavailable = nil } })) {
                Button(L("Понятно"), role: .cancel) {}
            } message: { Text(unavailable ?? "") }
    }

    /// A quote carries where it came from. Without a verified Home there is no truthful origin, so nothing is attached.
    private func quote(_ version: HomeMessage) {
        guard let home = client.quoteHome(for: feed.route, primary: library.primary) else {
            unavailable = L("«\(client.displayName)» не на связи. Цитату можно передать, когда устройство подключится.")
            return
        }
        discuss(.story(version, home: home))
    }
}

/// What every page of a desk shares: whose desk it is, whether the reader is looking, and the way to the chat.
struct NewsChrome {
    let profile: EmployeeProfile?
    let attentive: Bool
    let discuss: (HomeMessage) -> Void
}

extension EnvironmentValues {
    /// Opens the post sheet from the page on screen: a new draft from stories, or one already written.
    @Entry var newsPost: (NewsPostRequest) -> Void = { _ in }
}

extension View {
    /// The desk's capsule in the bar opens its settings, as on every page. Its character proofs there while a run is on.
    func newsToolbar(_ feed: NewsFeed, _ chrome: NewsChrome, title: String, working: Bool = false, offline: Bool = false) -> some View {
        modifier(NewsToolbar(feed: feed, chrome: chrome, title: title, working: working, offline: offline))
    }
}

/// A desk page's bar, and the two sheets a page can open: the desk's settings and a post. Each page presents them
/// itself. On the Mac a sheet attached to the first page of the desk does not open while another page is pushed over
/// it, so the page in front has to be the one that presents.
private struct NewsToolbar: ViewModifier {
    @ObservedObject var feed: NewsFeed
    let chrome: NewsChrome
    let title: String
    let working: Bool
    let offline: Bool
    @State private var details: EmployeeProfile?
    @State private var composing: NewsPostRequest?

    func body(content: Content) -> some View {
        content
            .environment(\.newsPost) { composing = $0 }
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            // A pushed page would sit on the system's white; the edition reads on the app's own paper.
            .containerBackground(AppTheme.canvas, for: .navigation)
            #endif
            .toolbar {
                ToolbarItem(placement: .principal) {
                    TitleCapsule(appearance: chrome.profile?.resolvedAppearance, name: feed.route.title, offline: offline, working: working,
                                 action: chrome.profile == nil ? nil : { details = chrome.profile })
                        .accessibilityLabel(chrome.profile == nil ? feed.route.title : L("Настройки сотрудника"))
                        .accessibilityValue(feed.route.title)
                        .accessibilityIdentifier("readerTitle")
                }
                if chrome.profile != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button(L("Настройки сотрудника"), systemImage: "slider.horizontal.3") { details = chrome.profile }
                        } label: { Image(systemName: "ellipsis") }
                        .menuIndicator(.hidden)
                        .accessibilityLabel(L("Ещё"))
                        .accessibilityIdentifier("readerMore")
                    }
                }
            }
            .sheet(item: $details) { profile in
                BotDetailsView(profile: profile, conversationID: feed.conversationID).environmentObject(feed.client)
            }
            .sheet(item: $composing) { request in
                NewsPostSheet(feed: feed, posts: feed.posts, request: request, appearance: chrome.profile?.resolvedAppearance)
                    .environment(\.newsWords, feed.words)
            }
    }
}

/// The rows resting on screen. A story counts as seen once its row has stayed there for a moment with the page at rest
/// in the active window: scrolling past is not seeing, and opening the page marks nothing by itself.
@MainActor
private final class NewsDwell {
    private var resting: Set<String> = []
    private var timer: Task<Void, Never>?
    var attentive = false { didSet { if attentive != oldValue { settle() } } }
    var seen: (Set<String>) -> Void = { _ in }

    func rest(_ id: String, _ visible: Bool) {
        if visible { resting.insert(id) } else { resting.remove(id) }
        settle()
    }

    private func settle() {
        timer?.cancel()
        guard attentive, !resting.isEmpty else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled, let self else { return }
            self.seen(self.resting)
        }
    }
}

/// «2 новых ↑»: stories that arrived while the reader was reading wait behind this instead of moving the page.
private struct NewsArrivals: View {
    @ObservedObject var feed: NewsFeed
    let words: NewsWords
    let show: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        ZStack {
            if feed.arrivals > 0 {
                Button(action: show) {
                    HStack(spacing: 6) { Text(words.fresh(feed.arrivals)); Image(systemName: "arrow.up").imageScale(.small) }
                        #if os(iOS)
                        .font(.subheadline)
                        #endif
                }
                .buttonStyle(.glass)
                // It floats over the page, so it grows only as far as it can without covering the lines under it.
                .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                .accessibilityIdentifier("newsArrivals")
            }
        }
        // Over a wide column it sits in the middle; on a phone at the trailing edge, where the date's line is free.
        .frame(maxWidth: .infinity, alignment: sizeClass == .compact ? .trailing : .center)
        .padding(.horizontal, Layout.edge)
        .padding(.top, 8)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .smooth(duration: 0.25), value: feed.arrivals > 0)
    }
}

// MARK: - A day

struct NewsDayPage: View {
    @ObservedObject var feed: NewsFeed
    /// Nil is today.
    let date: String?
    let chrome: NewsChrome
    @EnvironmentObject private var client: HomeClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var dwell = NewsDwell()

    /// Nothing is pushed over this page.
    private var isFront: Bool { feed.place.story == nil && feed.place.day == date && (date != nil || feed.place.panel == nil) }
    private var offline: Bool { feed.unreachable || client.homeUnreachable || client.connectionNeedsPairing }
    private var home: String? { URL(string: client.normalizedBaseURL)?.host }

    var body: some View {
        // The minute decides what "today" is and how the status line reads.
        TimelineView(.everyMinute) { timeline in
            let now = timeline.date, words = feed.words
            let front = feed.desk.front(date, now: now, read: feed.visit)
            let line = NewsStatusLine(status: feed.status, front: front)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        // In an empty feed the one sentence stands in the middle of the page, not under the date.
                        masthead(front, line: front.isEmpty ? nil : line, words: words, now: now).id("top")
                        if !front.isEmpty { sections(front, words: words, now: now) }
                        else if feed.loaded { empty(line, words: words, now: now).id("empty") }
                    }
                    .scrollTargetLayout()
                    .frame(maxWidth: NewsLayout.column, alignment: .leading)
                    .padding(.horizontal, Layout.edge)
                    .padding(.bottom, 32)
                    .frame(maxWidth: .infinity)
                }
                // Back from a story, from a day or from the chat, the page opens where the reader left it.
                .scrollPosition(id: Binding(get: { feed.anchors[date ?? ""] }, set: { feed.anchors[date ?? ""] = $0 }), anchor: .top)
                .scrollIndicators(.hidden)
                .accessibilityIdentifier(date == nil ? "newsToday" : "newsDay")
                .overlay(alignment: .top) {
                    NewsArrivals(feed: feed, words: words) {
                        feed.showIncoming()
                        if date == nil { withAnimation(reduceMotion ? nil : .smooth(duration: 0.25)) { proxy.scrollTo("top", anchor: .top) } }
                        else { feed.place.top += 1; feed.place.day = nil }
                    }
                }
                .onChange(of: feed.place.top) { if date == nil { proxy.scrollTo("top", anchor: .top) } }
            }
            .environment(\.newsWords, words)
            .newsToolbar(feed, chrome, title: date.map { feed.words.day($0) } ?? feed.words("Сегодня"), working: line.isRunning && !offline, offline: offline)
        }
        .paperTop()
        .safeAreaBar(edge: .bottom, spacing: 0) {
            // The page's way to the composer: its lead goes to the chat as context.
            if let lead = feed.desk.front(date, read: feed.visit).lead {
                AskCapsule(title: feed.words("Спросить про \(feed.route.title)")) { chrome.discuss(lead.latest) }
                    .accessibilityIdentifier("discussDesk")
            }
        }
        // Every page pushed over this one reads `isAway`: once the reader has chosen another place, none stays open.
        .navigationDestination(isPresented: Binding(get: { !feed.isAway && feed.place.story != nil && feed.place.day == date && (date != nil || feed.place.panel == nil) }, set: { if !$0 { feed.closeStory() } })) {
            NewsStoryPage(feed: feed, story: Binding(get: { feed.place.story }, set: { feed.place.story = $0 }),
                          order: feed.desk.front(date, read: feed.visit).order, chrome: chrome)
                .environment(\.newsHome, home)
        }
        .navigationDestination(item: Binding(get: { date == nil && !feed.isAway ? feed.place.day : nil }, set: { if date == nil { if let day = $0 { feed.place.day = day } else { feed.closeDay() } } })) { day in
            NewsDayPage(feed: feed, date: day, chrome: chrome).environmentObject(client).environment(\.newsHome, home).id(day)
        }
        .navigationDestination(item: Binding(get: { date == nil && !feed.isAway ? feed.place.panel : nil }, set: { if date == nil, !feed.holdsPlace { feed.place.panel = $0 } })) { panel in
            NewsPanelPage(feed: feed, panel: panel, chrome: chrome).environmentObject(client).environment(\.newsHome, home)
        }
        #if os(macOS)
        .background {
            // Esc goes back from an earlier day, as it does from a story.
            if date != nil, isFront {
                Button(feed.words("Сегодня")) { feed.place.day = nil }.keyboardShortcut(.cancelAction).opacity(0).accessibilityHidden(true)
            }
        }
        #endif
        .onAppear {
            feed.appear()
            if date != nil { feed.cover() }
            // Rows are named by their section and story; a story id has no colon.
            dwell.seen = { [feed] rows in feed.see(Set(rows.map { String($0.split(separator: ":", maxSplits: 1).last ?? "") })) }
        }
        .onDisappear { feed.disappear(); if date != nil { feed.uncover() } }
        .onChange(of: chrome.attentive && isFront, initial: true) { _, looking in dwell.attentive = looking }
        // Today's page says how many drafts there are, so it asks the Home once it is opened.
        .task { if date == nil { await feed.posts.load() } }
    }

    // MARK: Masthead

    /// The page's head: the day as its title, what the desk's runs say in one quiet line, the desk's own words on the
    /// day when its edition has them, and on today's page the three ways further.
    private func masthead(_ front: NewsDesk.Front, line: NewsStatusLine?, words: NewsWords, now: Date) -> some View {
        let status = line.map { offline ? words("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : words.status($0, name: feed.route.title, now: now) }
        var isEdition = false
        if case .edition? = line, !offline { isEdition = true }
        let intro = feed.edition.flatMap { $0.date == front.date && !front.standsIn ? $0.intro : nil }
        return VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 5) {
                Text(words.weekday(front.isToday ? NewsDesk.dayKey(now, feed.desk.calendar) : front.date, now: now))
                    .font(NewsType.dayTitle).displayTracking(-0.7).foregroundStyle(.primary)
                    .lineLimit(1).minimumScaleFactor(0.6)
                    .accessibilityAddTraits(.isHeader)
                if let status, let line {
                    Text(status).font(NewsType.quiet).monospacedDigit()
                        .foregroundStyle(line.isFailing && !offline ? AppTheme.warning : AppTheme.secondaryText)
                        // One line; at the largest text sizes, where one line cannot hold it, two.
                        .lineLimit(isEdition && !typeSize.isAccessibilitySize ? 1 : 2).minimumScaleFactor(isEdition ? 0.85 : 1).multilineTextAlignment(.leading)
                        .contentTransition(.opacity)
                        .animation(.easeInOut(duration: 0.15), value: line)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("newsStatus")
            if date == nil, !front.isEmpty { NewsWays(feed: feed, posts: feed.posts).padding(.top, 14) }
            if let intro {
                Text(intro).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing).foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true).padding(.top, 16)
                    .accessibilityIdentifier("newsIntro")
            }
        }
        // The space under the bar belongs to this first row, so scrolling to it shows the page's very top.
        .padding(.top, 10).padding(.bottom, 18)
    }

    /// No story in two weeks: the character, the truth in one sentence, and nothing to press.
    private func empty(_ line: NewsStatusLine, words: NewsWords, now: Date) -> some View {
        VStack(spacing: 16) {
            ToneAvatar(appearance: chrome.profile?.resolvedAppearance, size: AvatarSize.hero + 16, working: line.isRunning && !offline, offline: offline)
            Text(offline ? words("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : words.status(line, name: feed.route.title, now: now))
                .font(NewsType.headline(24, .title2)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            Text(words("Истории за последние две недели появятся здесь.")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("newsEmpty")
    }

    // MARK: Sections

    @ViewBuilder private func sections(_ front: NewsDesk.Front, words: NewsWords, now: Date) -> some View {
        if let lead = front.lead {
            // An edition reads under the name its desk gave it; a day the radar made alone needs no name.
            if front.published != nil || front.standsIn { head(words.paperTitle(front, named: feed.edition, now: now)).padding(.bottom, 6).id("edition") }
            NewsLeadStory(item: lead, developed: lead.developed(since: feed.visit), tint: AgentAppearance.tint(chrome.profile?.resolvedAppearance, dark: scheme == .dark)) { open(lead.id) }
                .onScrollVisibilityChange(threshold: 0.5) { dwell.rest("lead:" + lead.id, $0) }
                .id("lead:" + lead.id)
        }
        if !front.fresh.isEmpty {
            head(words.freshTitle(since: front.freshSince(feed.visit, calendar: feed.desk.calendar), count: front.fresh.count, now: now), accent: true).padding(.top, 30).id("fresh")
            ForEach(feed.place.showsAllFresh ? front.fresh : Array(front.fresh.prefix(5))) { moment in
                compact(moment.item, line: words.column(moment, on: front.date) + " · " + moment.item.story.section.lowercased(with: words.language.locale),
                        developed: moment.isDevelopment, row: "fresh:")
            }
            if front.fresh.count > 5 {
                Button(feed.place.showsAllFresh ? words("Свернуть") : words("Показать все · \(front.fresh.count)")) { feed.place.showsAllFresh.toggle() }
                    .buttonStyle(.plain).font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
                    .frame(minHeight: controlTarget)
                    .accessibilityIdentifier("newsMoreFresh")
                    .id("fresh:more")
            }
        }
        if !front.top.isEmpty {
            head(words("Главное")).padding(.top, 30).padding(.bottom, 2).id("top-stories")
            ForEach(front.top) { item in
                NewsRow(item: item, developed: item.developed(since: feed.visit)) { open(item.id) }
                    .onScrollVisibilityChange(threshold: 0.5) { dwell.rest("top:" + item.id, $0) }
                    .id("top:" + item.id)
            }
        }
        if !front.analysis.isEmpty {
            head(words("Разбор")).padding(.top, 30).padding(.bottom, 8).id("analysis")
            NewsAnalysisShelf(items: front.analysis, open: open).id("analysis:shelf")
        }
        ForEach(front.sections) { section in
            head(section.name).padding(.top, 30).id("section:" + section.name)
            ForEach(section.items) { item in
                compact(item, line: [feed.desk.moment(item).map { words.column($0, on: front.date) }, item.story.status.lowercased(with: words.language.locale)].compactMap { $0 }.joined(separator: " · "),
                        developed: item.developed(since: feed.visit), row: "section:")
            }
        }
        if !front.earlier.isEmpty {
            head(words("Выпуски")).padding(.top, 38).padding(.bottom, 8).id("earlier")
            NewsIssueShelf(desk: feed.desk, days: front.earlier, now: now) { feed.place.day = $0 }.id("earlier:shelf")
        }
    }

    /// A group of stories opens under its own small name; what is new wears the signal colour.
    private func head(_ title: String, accent: Bool = false) -> some View {
        Text(title).font(NewsType.head).monospacedDigit()
            .foregroundStyle(accent ? AppTheme.signalText : AppTheme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func compact(_ item: NewsDesk.Item, line: String, developed: Bool, row: String) -> some View {
        NewsCompactRow(item: item, line: line, developed: developed) { open(item.id) }
            .onScrollVisibilityChange(threshold: 0.5) { dwell.rest(row + item.id, $0) }
            .id(row + item.id)
    }

    private func open(_ story: String) {
        feed.storyScroll = nil
        feed.place.story = story
    }
}

/// The three ways further from today's paper, said in words: the week, the post drafts with how many there are, the search.
private struct NewsWays: View {
    @ObservedObject var feed: NewsFeed
    @ObservedObject var posts: NewsPostShelf

    var body: some View {
        let words = feed.words, drafts = posts.posts.count
        Capsules {
            way(words("Неделя"), "chart.bar", .week)
            way(drafts > 0 ? words("Посты · \(drafts)") : words("Посты"), "square.and.pencil", .posts)
            way(words("Найти"), "magnifyingglass", .search)
        }
    }

    private func way(_ title: String, _ symbol: String, _ panel: NewsPanel) -> some View {
        Button { feed.place.panel = panel } label: {
            SourceCapsule(title: title, symbol: symbol).frame(minHeight: controlTarget - 8).contentShape(.rect)
        }
        .buttonStyle(NewsRowStyle())
        .accessibilityIdentifier("newsWay-" + panel.rawValue)
    }
}

/// A row to scan: when and what kind in one quiet line, then what it is. The summary waits on the story's page.
struct NewsCompactRow: View {
    let item: NewsDesk.Item
    let line: String
    /// ↻: a development of a story reported earlier.
    var developed = false
    let open: () -> Void
    @Environment(\.newsWords) private var words

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 3) {
                QuietLine(text: line, developed: developed)
                Text(item.story.title).font(NewsType.headline(19, .title3, weight: .regular)).multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 9)
            .contentShape(.rect)
        }
        .buttonStyle(NewsRowStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
        #if os(macOS)
        .help(item.story.opening)
        #endif
    }
}

/// The paper's first story: a large tile with its picture, or the desk's own paper, then its first paragraph, what
/// the desk makes of it and where it comes from.
private struct NewsLeadStory: View {
    let item: NewsDesk.Item
    let developed: Bool
    let tint: Color
    let open: () -> Void
    @Environment(\.newsWords) private var words
    @Environment(\.newsHome) private var home
    @State private var picture: CGImage?
    /// The story names a picture that did not come: the tile stops waiting for it.
    @State private var missed = false

    var body: some View {
        let story = item.story, shown = StoryPictures.covers(picture ?? StoryPictures.cached(story.image))
        // A lead with no picture is not a tile with a hole in it. It is set in words: the figure the story stands on,
        // large, when it has one, and the headline a step larger, in a tile exactly as tall as they are. While a named
        // picture is still on its way the tile keeps the picture's shape, so the page does not jump when it lands.
        let inWords = shown == nil && (story.image == nil || missed || picture != nil), figure = inWords ? story.numbers?.first : nil
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                Tile(label: (developed ? "↻ " : "") + newsLine(story, locale: words.language.locale), skin: shown.map { .picture($0) } ?? .paper(tint),
                     side: .infinity, height: inWords ? nil : NewsLayout.lead, grows: inWords, radius: 40) {
                    if let figure {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(figure.value).font(.system(size: NewsLayout.leadFigure, weight: .semibold)).tracking(-2).monospacedDigit()
                                .lineLimit(1).minimumScaleFactor(0.5)
                            Text(figure.label).font(AppTypography.label.weight(.regular)).opacity(0.66).lineLimit(2).multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 10)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(figure.value + ", " + figure.label)
                        .accessibilityIdentifier("newsLeadFigure")
                    }
                    Spacer(minLength: inWords ? (figure == nil ? 14 : 18) : 8)
                    // A step smaller rather than cut; over a picture the headline stands on its scrim.
                    FittedTitle(text: story.title, sizes: inWords && figure == nil ? NewsLayout.leadWordSizes : NewsLayout.leadSizes, lines: shown != nil ? 3 : inWords ? 5 : 4, tracking: -0.3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .pictureScrim(shown != nil)
                }
                .animation(.smooth(duration: 0.3), value: shown != nil)
                .animation(.smooth(duration: 0.3), value: inWords)
                // The lead's first paragraph and the desk's view are read here; the rest is one press away.
                Text(story.opening).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 18)
                if let view = story.view { ViewLine(text: view).padding(.top, 12) }
                if !story.domains.isEmpty {
                    Capsules { ForEach(story.domains.prefix(4), id: \.self) { SourceCapsule(title: $0) } }.padding(.top, 16)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(TilePressStyle())
        .task(id: story.image) {
            missed = false
            guard let address = story.image else { picture = nil; return }
            picture = await StoryPictures.load(address, home: home)
            missed = picture == nil && !Task.isCancelled
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
        .accessibilityIdentifier("newsLead")
    }
}

/// One of the day's top stories: where it belongs, what it is, its first lines, and its picture small beside them
/// when it has one.
struct NewsRow: View {
    let item: NewsDesk.Item
    let developed: Bool
    let open: () -> Void
    @Environment(\.newsWords) private var words
    @Environment(\.newsHome) private var home
    @State private var picture: CGImage?

    var body: some View {
        let shown = picture ?? StoryPictures.cached(item.story.image)
        Button(action: open) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    QuietLine(text: newsLine(item.story, locale: words.language.locale), developed: developed)
                    Text(item.story.title).font(NewsType.headline(21, .title3))
                        .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    Text(item.story.opening).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).lineSpacing(AppTypography.readingLineSpacing)
                        .lineLimit(2).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let shown {
                    Image(decorative: shown, scale: 1).resizable().scaledToFill()
                        .frame(width: 72, height: 72).clipShape(.rect(cornerRadius: 18, style: .continuous))
                        .padding(.top, 4).transition(.opacity)
                }
            }
            .padding(.vertical, 12)
            .contentShape(.rect)
        }
        .buttonStyle(NewsRowStyle())
        .task(id: item.story.image) {
            guard let address = item.story.image else { picture = nil; return }
            picture = await StoryPictures.load(address, home: home)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
    }
}

/// «Разбор»: the points the headlines missed, as ink tiles. One fills the column; more stand in a row that scrolls.
private struct NewsAnalysisShelf: View {
    let items: [NewsDesk.Item]
    let open: (String) -> Void
    @Environment(\.newsWords) private var words

    var body: some View {
        if items.count == 1 { card(items[0]) }
        else {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: TileMetrics.gap) { ForEach(items) { card($0).frame(width: 264) } }
                    .scrollTargetLayout()
                    // Room for the shadows, which the scroll view would otherwise cut.
                    .padding(.top, 2).padding(.bottom, 22)
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
            .scrollClipDisabled()
        }
    }

    private func card(_ item: NewsDesk.Item) -> some View {
        Button { open(item.id) } label: {
            Tile(label: item.story.section, skin: .ink, side: .infinity, height: 164, radius: 32) {
                Spacer(minLength: 8)
                FittedTitle(text: item.story.title, sizes: [21, 19.5, 18, 16.5, 15, 14], lines: 4, most: 5, tracking: -0.2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .buttonStyle(TilePressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
        .accessibilityIdentifier("newsAnalysis-" + item.id)
    }
}

/// «Выпуски»: the earlier days as tiles, each with its day, its lead and how many stories it had.
private struct NewsIssueShelf: View {
    let desk: NewsDesk
    let days: [NewsDesk.Day]
    let now: Date
    let open: (String) -> Void
    @Environment(\.newsWords) private var words

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: TileMetrics.gap) {
                ForEach(days) { day in
                    let stories = desk.paper(day)
                    Button { open(day.date) } label: {
                        Tile(label: words.issue(day.date, now: now), skin: .plain) {
                            Spacer(minLength: 6)
                            FittedTitle(text: stories.first?.story.title ?? "", sizes: [14, 13, 12.5], lines: 4, most: 4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(words.stories(stories.count)).font(AppTypography.label.weight(.regular)).opacity(0.62).lineLimit(1).padding(.top, 6)
                        }
                    }
                    .buttonStyle(TilePressStyle())
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("newsDay-" + day.date)
                }
            }
            .scrollTargetLayout()
            .padding(.top, 2).padding(.bottom, 26)
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }
}

// MARK: - One story

/// The story open over the page it was opened from. Next and previous follow that page's reading order.
struct NewsStoryPage: View {
    @ObservedObject var feed: NewsFeed
    /// The open story; nil closes the page.
    @Binding var story: String?
    /// The stories of the page it was opened from, as they read from top to bottom.
    let order: [String]
    let chrome: NewsChrome
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The story on screen. It stays while the page slides away after `story` is cleared.
    @State private var shown: String?
    /// Everything about one name, opened over the story.
    @State private var topic: NewsTopic?

    init(feed: NewsFeed, story: Binding<String?>, order: [String], chrome: NewsChrome) {
        self.feed = feed; _story = story; self.order = order; self.chrome = chrome
        _shown = State(initialValue: story.wrappedValue)
    }

    var body: some View {
        let words = feed.words
        let item = feed.desk.item(shown)
        ZStack {
            if let item {
                let next = order.firstIndex(of: item.id).flatMap { order.indices.contains($0 + 1) ? feed.desk.item(order[$0 + 1]) : nil }
                NewsArticle(item: item, next: next, related: feed.desk.related(to: item), start: feed.storyScroll?.story == item.id ? feed.storyScroll?.offset ?? 0 : 0,
                            scrolled: { feed.storyScroll = (item.id, $0) }, open: { feed.storyScroll = nil; story = $0 },
                            topic: { topic = NewsTopic(name: $0) },
                            step: { move($0) }, close: { story = nil })
                    .id(item.id)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 12)))
            }
        }
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .smooth(duration: 0.25), value: item?.id)
        .environment(\.newsWords, words)
        .overlay(alignment: .top) {
            NewsArrivals(feed: feed, words: words) {
                feed.showIncoming()
                feed.place.top += 1
                story = nil; feed.place.story = nil; feed.place.day = nil; feed.place.panel = nil
            }
        }
        .paperTop()
        .safeAreaBar(edge: .bottom, spacing: 0) {
            // Two ways on from a story: ask about it in the chat, or have a post for the channel written from it.
            if let item {
                NewsDock(ask: words("Спросить"), onAsk: { chrome.discuss(item.latest) }, post: words("Сделать пост"), stories: [item.id])
            }
        }
        .newsToolbar(feed, chrome, title: item?.story.title ?? "")
        .navigationDestination(item: Binding(get: { feed.isAway ? nil : topic }, set: { topic = $0 })) { NewsListPage(feed: feed, kind: .topic($0.name), chrome: chrome) }
        #if os(macOS)
        .background {
            // Esc goes back from anywhere in the window, also while the sidebar holds the keyboard.
            Button(words("Сегодня")) { story = nil }.keyboardShortcut(.cancelAction).opacity(0).accessibilityHidden(true)
        }
        #endif
        .onAppear { feed.appear(); feed.cover(); see() }
        .onDisappear { feed.disappear(); feed.uncover() }
        .onChange(of: story) { _, next in
            if let next { shown = next; see() }
        }
        // A story that left the feed leaves the screen.
        .onChange(of: item == nil) { _, gone in if gone { story = nil } }
    }

    /// Opening a story is the plainest way of seeing it.
    private func see() {
        if let story { feed.open(story) }
    }

    private func move(_ step: Int) {
        guard let index = order.firstIndex(of: story ?? ""), order.indices.contains(index + step) else { return }
        feed.storyScroll = nil
        story = order[index + step]
    }
}

/// The story's dock: a glass capsule that takes it to the chat, and the ink capsule that makes a post of it. Where
/// both names do not fit side by side (a large text size, a narrow window), asking becomes a round «+» and keeps its
/// name for VoiceOver: an action is never left as an ellipsis.
struct NewsDock: View {
    @Environment(\.zoomNamespace) private var zoom
    @Environment(\.newsPost) private var newsPost
    let ask: String
    let onAsk: () -> Void
    let post: String
    /// What a post is made from.
    let stories: [String]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { asking(named: true); posting }
            HStack(spacing: 10) { asking(named: false); Spacer(minLength: 0); posting }
        }
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .frame(maxWidth: Layout.column)
        .padding(.horizontal, Layout.edge)
        .padding(.top, 8)
        .padding(.bottom, Layout.belowComposer)
        .frame(maxWidth: .infinity)
        .dockFade()
    }

    @ViewBuilder private func asking(named: Bool) -> some View {
        let button = Button(action: onAsk) {
            Group {
                if named {
                    HStack(spacing: 12) {
                        Image(systemName: "plus").font(.system(size: AskCapsule.height * 0.35, weight: .regular)).foregroundStyle(.primary)
                        // The whole word or the round button: never a cut one.
                        Text(ask).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).lineLimit(1).fixedSize()
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 18).frame(minHeight: AskCapsule.height)
                } else {
                    Image(systemName: "plus").font(.system(size: AskCapsule.height * 0.35, weight: .regular)).foregroundStyle(.primary)
                        .frame(width: AskCapsule.height, height: AskCapsule.height)
                }
            }
            .contentShape(Capsule())
            .dockGlass()
        }
        .buttonStyle(TilePressStyle())
        .accessibilityLabel(ask)
        .accessibilityIdentifier("discussStory")
        if let zoom { button.zoomSource(AnyHashable("ask"), in: zoom) } else { button }
    }

    private var posting: some View {
        Button { newsPost(NewsPostRequest(stories: stories)) } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil").font(.system(size: AskCapsule.height * 0.33, weight: .medium))
                Text(post).font(AppTypography.reading.weight(.medium)).lineLimit(1)
            }
            .foregroundStyle(AppTheme.canvas)
            .padding(.horizontal, 20).frame(minHeight: AskCapsule.height)
            .background(AppTheme.accentText, in: Capsule())
            .contentShape(Capsule())
            // The action keeps its whole name.
            .fixedSize()
        }
        .buttonStyle(TilePressStyle())
        .accessibilityIdentifier("makePost")
    }
}

/// Where a story's page is scrolled, kept out of the view's state because scrolling changes it all the time.
@MainActor
private final class NewsScroll {
    var offset: CGFloat = 0
    var page: CGFloat = 0
    var end: CGFloat = 0
}

private struct NewsArticle: View {
    let item: NewsDesk.Item
    let next: NewsDesk.Item?
    /// Other stories about the same names, the newest first.
    let related: [NewsDesk.Item]
    let scrolled: (CGFloat) -> Void
    let open: (String) -> Void
    /// Everything the desk wrote about one name.
    let topic: (String) -> Void
    /// The next or the previous story of the page, and the way back to it.
    let step: (Int) -> Void
    let close: () -> Void
    @Environment(\.newsWords) private var words
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsSources: Bool
    @State private var position: ScrollPosition
    @State private var scroll = NewsScroll()
    @FocusState private var focused: Bool

    init(item: NewsDesk.Item, next: NewsDesk.Item?, related: [NewsDesk.Item], start: CGFloat, scrolled: @escaping (CGFloat) -> Void, open: @escaping (String) -> Void,
         topic: @escaping (String) -> Void, step: @escaping (Int) -> Void, close: @escaping () -> Void) {
        self.item = item; self.next = next; self.related = related; self.scrolled = scrolled; self.open = open; self.topic = topic; self.step = step; self.close = close
        // Three sources or fewer are the evidence at a glance; more wait behind their count.
        _showsSources = State(initialValue: item.story.sources.count <= 3)
        _position = State(initialValue: start > 0 ? ScrollPosition(point: CGPoint(x: 0, y: start)) : ScrollPosition(edge: .top))
    }

    private var story: NewsStory { item.story }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                NewsPicture(address: story.image, maxHeight: 360)
                QuietLine(text: newsLine(story, locale: words.language.locale))
                Text(story.title).font(NewsType.headline(34, .largeTitle)).lineSpacing(1).tracking(-0.4).padding(.top, 8)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text(story.summary).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing + 1).padding(.top, 16)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if item.developments.count > 1, let change = item.newest.story?.change { development(item.newest, change).padding(.top, 14) }
                if let view = story.view { ViewLine(text: view).padding(.top, 14) }
                if let numbers = story.numbers, !numbers.isEmpty { NewsNumbers(numbers: numbers).padding(.top, 22) }
                if !links.isEmpty {
                    Capsules {
                        ForEach(Array(links.enumerated()), id: \.offset) { _, source in
                            Link(destination: source.url) { SourceCapsule(title: source.title, symbol: "arrow.up.right") }.buttonStyle(.plain)
                        }
                    }
                    .padding(.top, story.numbers?.isEmpty == false ? 4 : 18)
                }

                section(words("Что произошло")) { MessageContent(source: story.body).equatable() }
                evidence.padding(.top, 32)
                if item.developments.count > 1 { history.padding(.top, 32) }
                if !item.topics.isEmpty || !related.isEmpty { chapters.padding(.top, 32) }
                if let next {
                    Button { open(next.id) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(words("Дальше")).font(NewsType.head).foregroundStyle(AppTheme.secondaryText)
                            Text(next.story.title).font(NewsType.headline(21, .title3)).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12).contentShape(.rect)
                    }
                    .buttonStyle(NewsRowStyle()).padding(.top, 32)
                    .accessibilityIdentifier("nextStory")
                }
            }
            .frame(maxWidth: NewsLayout.story, alignment: .leading)
            .padding(.horizontal, Layout.edge)
            .padding(.top, 14)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .scrollPosition($position)
        .onScrollGeometryChange(for: [CGFloat].self) { [$0.contentOffset.y + $0.contentInsets.top, $0.visibleRect.height, $0.contentSize.height - $0.visibleRect.height] } action: { _, now in
            scroll.offset = now[0]; scroll.page = now[1]; scroll.end = max(0, now[2])
            scrolled(now[0])
        }
        .scrollIndicators(.hidden)
        .accessibilityIdentifier("newsStory")
        #if os(macOS)
        // The story takes the keyboard from the sidebar, so it reads without the mouse: J, K and the arrows move
        // between stories, Space and the paging keys scroll, Esc goes back.
        .focusable(true, interactions: .edit)
        .focusEffectDisabled()
        .focused($focused)
        .onAppear { focused = true }
        .onKeyPress(phases: [.down, .repeat]) { press in
            switch press.key {
            case .rightArrow: step(1)
            case .leftArrow: step(-1)
            case .escape: close()
            case .downArrow: move(by: 56)
            case .upArrow: move(by: -56)
            case .pageDown: move(by: scroll.page * 0.9)
            case .pageUp: move(by: -scroll.page * 0.9)
            case .space: move(by: (press.modifiers.contains(.shift) ? -0.9 : 0.9) * scroll.page)
            case .home: move(by: -scroll.end)
            case .end: move(by: scroll.end)
            default:
                // Where J and K sit on a Russian keyboard too.
                switch press.characters.lowercased() {
                case "j", "о": step(1)
                case "k", "л": step(-1)
                default: return .ignored
                }
            }
            return .handled
        }
        #endif
    }

    #if os(macOS)
    private func move(by distance: CGFloat) {
        let target = min(max(0, scroll.offset + distance), scroll.end)
        withAnimation(reduceMotion ? nil : .smooth(duration: 0.2)) { position.scrollTo(y: target) }
    }
    #endif

    /// The story's sources as capsules: each opens its page.
    private var links: [(title: String, url: URL)] {
        story.sources.prefix(4).compactMap { source in
            URL(string: source.url).flatMap { MessageContent.allowsLink($0) ? (source.title, $0) : nil }
        }
    }

    /// The latest development leads the story it changed.
    private func development(_ version: HomeMessage, _ change: String) -> some View {
        let when = version.sentAt.map { words.moment($0) } ?? ""
        // No text selection here: on the Mac a selectable text with its own accessibility label never finishes resolving it.
        return Text("\(Text("↻ " + when).foregroundStyle(AppTheme.signalText).fontWeight(.medium)) — \(change)")
            .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(words("Развитие истории") + ", " + when + ". " + change)
    }

    private func label(_ title: String) -> some View {
        Text(title).font(NewsType.head).foregroundStyle(AppTheme.secondaryText)
            .accessibilityAddTraits(.isHeader)
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            label(title)
            content()
        }
        .padding(.top, 32)
    }

    /// Everything the story stands on, in one place: the sources, what was read, what was not checked, and when it happened.
    private var evidence: some View {
        VStack(alignment: .leading, spacing: 12) {
            label(words("Доказательства"))
            if story.sources.count > 3 {
                Button { withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : .smooth(duration: 0.25)) { showsSources.toggle() } } label: {
                    HStack {
                        Text(words("Источники · \(story.sources.count)")).font(AppTypography.interface.weight(.medium))
                        Spacer()
                        Image(systemName: "plus").rotationEffect(.degrees(showsSources ? 45 : 0)).foregroundStyle(AppTheme.secondaryText)
                    }
                    .frame(minHeight: controlTarget).contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityValue(showsSources ? words("Развёрнуто") : words("Свёрнуто"))
                .accessibilityIdentifier("storySources")
            }
            if showsSources {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(story.sources.enumerated()), id: \.offset) { _, source in
                        VStack(alignment: .leading, spacing: 4) {
                            if let url = URL(string: source.url), MessageContent.allowsLink(url) {
                                Link(destination: url) {
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(source.title).underline(color: AppTheme.faint).multilineTextAlignment(.leading)
                                        Image(systemName: "arrow.up.right").imageScale(.small)
                                    }
                                }
                                .font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
                            }
                            Text([source.role, URL(string: source.url)?.host(), NewsDesk.instant(source.publishedAt, words.calendar).map { $0.hasClock ? words.moment($0.date) : words.day($0.date) }]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(NewsType.quiet).foregroundStyle(AppTheme.secondaryText)
                        }
                    }
                }
                .padding(.bottom, 4)
                .transition(.opacity)
            }
            fact(words("Прочитано"), story.verification)
            if let check = story.check { fact(words("Не проверено"), check) }
            if let event = NewsDesk.instant(story.eventAt, words.calendar) {
                fact(words("Событие"), event.hasClock ? words.day(event.date) + ", " + words.time(event.date) : words.day(event.date))
            }
        }
    }

    /// A name or a time, then what it says: side by side on a wide page, one over the other on a phone or in large text.
    private func fact(_ name: String, _ text: String) -> some View {
        let name = Text(name).font(NewsType.quiet).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
        let text = Text(text).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
            .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        return Group {
            if textSize.isAccessibilitySize || sizeClass == .compact { VStack(alignment: .leading, spacing: 4) { name; text } }
            else { HStack(alignment: .firstTextBaseline, spacing: 16) { name.frame(width: 112, alignment: .leading); text } }
        }
    }

    /// Whom the story is about, each name a way to everything the desk wrote about it, and the earlier chapters of
    /// the same storyline.
    private var chapters: some View {
        VStack(alignment: .leading, spacing: 10) {
            label(words("Раньше по теме"))
            if !item.topics.isEmpty {
                Capsules {
                    ForEach(item.topics, id: \.self) { name in
                        Button { topic(name) } label: { SourceCapsule(title: name) }.buttonStyle(NewsRowStyle())
                            .accessibilityIdentifier("storyTopic-" + name)
                    }
                }
            }
            ForEach(related) { other in
                NewsCompactRow(item: other, line: [other.newest.sentAt.map { words.shortDay($0) }, other.story.section.lowercased(with: words.language.locale)].compactMap { $0 }.joined(separator: " · ")) { open(other.id) }
            }
        }
    }

    private var history: some View {
        VStack(alignment: .leading, spacing: 12) {
            label(words("Развитие"))
            ForEach(item.developments.reversed()) { version in
                fact(version.sentAt.map { words.shortDay($0) + ", " + words.time($0) } ?? "",
                     version.id == item.versions.first?.id ? words("Первое сообщение") : version.story?.change ?? "")
            }
        }
    }
}

/// The figures that carry a story, each large over what it measures: a row of tiles that scrolls when it must.
struct NewsNumbers: View {
    let numbers: [NewsStory.Number]

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: TileMetrics.gap) {
                ForEach(Array(numbers.enumerated()), id: \.offset) { index, number in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(number.value).font(.system(size: TileMetrics.side * 0.2, weight: .semibold)).tracking(-1).monospacedDigit()
                            .lineLimit(1).minimumScaleFactor(0.5)
                        Text(number.label).font(AppTypography.label.weight(.regular)).opacity(0.66).lineLimit(4).multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(TileMetrics.padding)
                    // A little wider than a tile of the shelf: what a figure measures is a phrase, not a word.
                    .frame(width: TileMetrics.side * 1.2, height: TileMetrics.side, alignment: .topLeading)
                    .foregroundStyle(index == 0 ? AnyShapeStyle(AppTheme.canvas) : AnyShapeStyle(.primary))
                    .background(index == 0 ? AppTheme.accentText : AppTheme.tile, in: .rect(cornerRadius: TileMetrics.radius, style: .continuous))
                    .tileShadow()
                    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(number.value + ", " + number.label)
                }
            }
            .scrollTargetLayout()
            // Room for the shadows, which the scroll view would otherwise cut.
            .padding(.top, 2).padding(.bottom, 26)
        }
        .scrollTargetBehavior(.viewAligned)
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
        .accessibilityIdentifier("storyNumbers")
    }
}
