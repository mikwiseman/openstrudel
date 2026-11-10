import SwiftUI

/// A desk's stories as one page a day: one quiet line for the day and the desk's runs, what is new since the last
/// visit, the edition with its lead as a large tile, the day's radar and the earlier days. A story opens over its page
/// with its evidence and its history. Discussion happens in the chat: the capsule at the bottom takes the story there.

/// The edition's voice: New York for headlines, the interface face for reading, quiet sentence-case lines for the rest.
private enum NewsType {
    static func headline(_ mac: CGFloat, _ style: Font.TextStyle, weight: Font.Weight = .medium) -> Font { AppTypography.serif(mac, style, weight: weight) }
    /// Time, section and status over a headline.
    static var quiet: Font { ReaderLine.font }
    /// The small name over a group of stories.
    static var head: Font { ReaderLine.font.weight(.semibold) }
}

private enum NewsLayout {
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
}

private extension EnvironmentValues {
    /// The language of the stories on screen. Every label and date of the reader follows it.
    @Entry var newsWords = NewsWords()
    /// The desk's own Home: a picture it serves itself is read like the rest of the page.
    @Entry var newsHome: String? = nil
}

private extension NewsStory {
    /// Where the story comes from, as the reader would name it: each source's site once.
    var domains: [String] {
        var seen = Set<String>()
        return sources.compactMap { URL(string: $0.url)?.host() }.map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }.filter { seen.insert($0).inserted }
    }
}

/// A row is its own button: it dims under the finger and springs back.
private struct NewsRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(configuration.isPressed ? .easeOut(duration: 0.08) : .spring(response: 0.35, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

/// Where a story belongs and how sure it is, in one quiet sentence-case line: «Модели · вышло».
private func newsLine(_ story: NewsStory, locale: Locale) -> String {
    [story.section, story.status.lowercased(with: locale)].filter { !$0.isEmpty }.joined(separator: " · ")
}

private struct QuietLine: View {
    let text: String
    /// ↻: the story moved since the reader had it on screen.
    var developed = false
    @Environment(\.newsWords) private var words

    var body: some View {
        HStack(spacing: 5) {
            if developed { Text("↻").foregroundStyle(AppTheme.signal).fontWeight(.semibold).accessibilityLabel(words("Развитие истории")) }
            Text(text).foregroundStyle(AppTheme.secondaryText)
        }
        .font(NewsType.quiet).monospacedDigit()
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
}

/// The desk's own conclusion, set apart by one arrow in the signal colour.
private struct ViewLine: View {
    let text: String
    var limit: Int? = nil
    @Environment(\.newsWords) private var words

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            // A symbol, so it points the other way in a language that reads from the right.
            Image(systemName: "arrow.forward").imageScale(.small).fontWeight(.semibold).foregroundStyle(AppTheme.signal).accessibilityHidden(true)
            Text(text).lineLimit(limit).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(words("Наш взгляд") + ": " + text)
    }
}

/// Small capsules that wrap: a story's sources.
private struct Capsules: SwiftUI.Layout {
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

private struct SourceCapsule: View {
    let title: String
    var body: some View {
        Text(title).font(NewsType.quiet.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
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
                Image(decorative: image, scale: 1).resizable()
                    .aspectRatio(CGFloat(image.width) / CGFloat(max(image.height, 1)), contentMode: .fit)
                    .frame(maxHeight: maxHeight)
                    .clipShape(.rect(cornerRadius: 28, style: .continuous))
                    .tileShadow()
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
    @State private var details: EmployeeProfile?
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
        NewsDayPage(feed: feed, date: nil, chrome: NewsChrome(profile: profile, attentive: windowIsActive,
                                                             showDetails: { details = profile }, discuss: quote))
            .environment(\.newsHome, URL(string: client.normalizedBaseURL)?.host)
            // Stories that arrive behind another app are read as new when the reader comes back.
            .onChange(of: windowIsActive, initial: true) { _, active in feed.attend(active) }
            .sheet(item: $details) { profile in BotDetailsView(profile: profile, conversationID: feed.conversationID).environmentObject(client) }
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

/// What every page of a desk shares: whose desk it is, whether the reader is looking, and the two ways out.
private struct NewsChrome {
    let profile: EmployeeProfile?
    let attentive: Bool
    let showDetails: () -> Void
    let discuss: (HomeMessage) -> Void
}

private extension View {
    /// The desk's capsule in the bar opens its settings, as on every page. Its character proofs there while a run is on.
    func newsToolbar(_ feed: NewsFeed, _ chrome: NewsChrome, title: String, working: Bool = false, offline: Bool = false) -> some View {
        navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            // A pushed page would sit on the system's white; the edition reads on the app's own paper.
            .containerBackground(AppTheme.canvas, for: .navigation)
            #endif
            .toolbar {
                ToolbarItem(placement: .principal) {
                    TitleCapsule(appearance: chrome.profile?.resolvedAppearance, name: feed.route.title, offline: offline, working: working,
                                 action: chrome.profile == nil ? nil : chrome.showDetails)
                        .accessibilityLabel(chrome.profile == nil ? feed.route.title : L("Настройки сотрудника"))
                        .accessibilityValue(feed.route.title)
                        .accessibilityIdentifier("readerTitle")
                }
                if chrome.profile != nil {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            Button(L("Настройки сотрудника"), systemImage: "slider.horizontal.3", action: chrome.showDetails)
                        } label: { Image(systemName: "ellipsis") }
                        .menuIndicator(.hidden)
                        .accessibilityLabel(L("Ещё"))
                        .accessibilityIdentifier("readerMore")
                    }
                }
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

private struct NewsDayPage: View {
    @ObservedObject var feed: NewsFeed
    /// Nil is today.
    let date: String?
    let chrome: NewsChrome
    @EnvironmentObject private var client: HomeClient
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var dwell = NewsDwell()

    /// Nothing is pushed over this page.
    private var isFront: Bool { feed.place.story == nil && feed.place.day == date }
    private var offline: Bool { feed.unreachable || client.homeUnreachable || client.connectionNeedsPairing }
    /// The story «Спросить про…» takes to the chat: the page's first.
    private var lead: NewsDesk.Item? {
        let page = feed.desk.page(date, read: feed.visit)
        return page.edition.first ?? page.fresh.first?.item ?? page.radar.first?.item
    }

    var body: some View {
        // The minute decides what "today" is and how the status line reads.
        TimelineView(.everyMinute) { timeline in
            let now = timeline.date, words = feed.words
            let page = feed.desk.page(date, now: now, read: feed.visit)
            let line = NewsStatusLine(status: feed.status, page: page)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        // In an empty feed the one sentence stands in the middle of the page, not under the date.
                        masthead(page, line: page.isEmpty ? nil : line, words: words, now: now).id("top")
                        if !page.isEmpty { sections(page, words: words, now: now) }
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
            .newsToolbar(feed, chrome, title: date.map { feed.words.day($0) } ?? feed.words("Сегодня"), working: line.isRunning && !offline, offline: offline || line.isFailing)
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            // The page's way to the composer: its first story goes to the chat as context.
            if let lead {
                AskCapsule(title: feed.words("Спросить про \(feed.route.title)")) { chrome.discuss(lead.latest) }
                    .accessibilityIdentifier("discussDesk")
            }
        }
        .navigationDestination(isPresented: Binding(get: { feed.place.story != nil && feed.place.day == date }, set: { if !$0 { feed.closeStory() } })) {
            NewsStoryPage(feed: feed, date: date, chrome: chrome).environment(\.newsHome, URL(string: client.normalizedBaseURL)?.host)
        }
        .navigationDestination(item: Binding(get: { date == nil ? feed.place.day : nil }, set: { if date == nil { if let day = $0 { feed.place.day = day } else { feed.closeDay() } } })) { day in
            NewsDayPage(feed: feed, date: day, chrome: chrome).environmentObject(client).environment(\.newsHome, URL(string: client.normalizedBaseURL)?.host).id(day)
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
            // Rows are named by their section and story; a story id has no colon.
            dwell.seen = { [feed] rows in feed.see(Set(rows.map { String($0.split(separator: ":", maxSplits: 1).last ?? "") })) }
        }
        .onDisappear { feed.disappear() }
        .onChange(of: chrome.attentive && isFront, initial: true) { _, looking in dwell.attentive = looking }
    }

    // MARK: Masthead

    /// One quiet line: the day, then what the desk's runs say. It always tells the truth about the feed.
    private func masthead(_ page: NewsDesk.Page, line: NewsStatusLine?, words: NewsWords, now: Date) -> some View {
        let day = Text(words.weekday(page.date, now: now))
        let status = line.map { offline ? words("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : words.status($0, name: feed.route.title, now: now) }
        return Group {
            if let status, let line {
                Text("\(day) · \(Text(status).foregroundStyle(line.isFailing && !offline ? AppTheme.warning : AppTheme.secondaryText))")
                    .contentTransition(.opacity)
                    .animation(.easeInOut(duration: 0.15), value: line)
            } else { day }
        }
        .font(NewsType.quiet).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
        .fixedSize(horizontal: false, vertical: true)
        // The space under the bar belongs to this first row, so scrolling to it shows the page's very top.
        .padding(.top, 14).padding(.bottom, 14)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("newsStatus")
    }

    /// No story in two weeks: the character, the truth in one sentence, and nothing to press.
    private func empty(_ line: NewsStatusLine, words: NewsWords, now: Date) -> some View {
        VStack(spacing: 16) {
            ToneAvatar(appearance: chrome.profile?.resolvedAppearance, size: AvatarSize.hero + 16, working: line.isRunning && !offline, offline: offline || line.isFailing)
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

    @ViewBuilder private func sections(_ page: NewsDesk.Page, words: NewsWords, now: Date) -> some View {
        let hasFresh = !page.fresh.isEmpty, hasEdition = !page.edition.isEmpty, hasRadar = !page.radar.isEmpty
        if hasFresh {
            head(words.freshTitle(since: page.freshSince(feed.visit), count: page.fresh.count, now: now), accent: true).id("fresh")
            ForEach(feed.place.showsAllFresh ? page.fresh : Array(page.fresh.prefix(5))) { moment in
                compact(moment, page: page, row: "fresh:")
            }
            if page.fresh.count > 5 {
                Button(feed.place.showsAllFresh ? words("Свернуть") : words("Показать все · \(page.fresh.count)")) { feed.place.showsAllFresh.toggle() }
                    .buttonStyle(.plain).font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
                    .frame(minHeight: controlTarget)
                    .accessibilityIdentifier("newsMoreFresh")
                    .id("fresh:more")
            }
        }
        if hasEdition {
            head(words.editionTitle(page, named: feed.edition, now: now)).padding(.top, hasFresh ? 30 : 0).padding(.bottom, 6).id("edition")
            // One run of rows, so a story keeps its identity when the next edition makes it the lead.
            ForEach(Array(page.edition.enumerated()), id: \.element.id) { index, item in
                Group {
                    if index == 0 {
                        NewsLeadStory(item: item, developed: item.developed(since: feed.visit), tint: AgentAppearance.tint(chrome.profile?.resolvedAppearance, dark: scheme == .dark)) { open(item.id) }
                            .padding(.bottom, page.edition.count > 1 ? 22 : 0)
                    } else { NewsRow(item: item, developed: item.developed(since: feed.visit)) { open(item.id) } }
                }
                .onScrollVisibilityChange(threshold: 0.5) { dwell.rest("edition:" + item.id, $0) }
                .id("edition:" + item.id)
            }
        }
        if hasRadar {
            head(words("Радар за день")).padding(.top, hasFresh || hasEdition ? 30 : 0).id("radar")
            ForEach(page.radar) { moment in
                compact(moment, page: page, row: "radar:")
            }
        }
        if !page.earlier.isEmpty {
            head(words("Раньше")).padding(.top, hasFresh || hasEdition || hasRadar ? 30 : 0).id("earlier")
            ForEach(page.earlier) { day in
                Button { feed.place.day = day.date } label: {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) { dayTitle(day, words, now); Spacer(minLength: 16); daySummary(day, words) }
                        VStack(alignment: .leading, spacing: 4) { dayTitle(day, words, now); daySummary(day, words) }
                    }
                    .frame(maxWidth: .infinity, minHeight: controlTarget, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(NewsRowStyle())
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("newsDay-" + day.date)
                .id("day:" + day.date)
            }
        }
    }

    private func dayTitle(_ day: NewsDesk.Day, _ words: NewsWords, _ now: Date) -> some View {
        Text(words.weekday(day.date, now: now)).font(AppTypography.reading).multilineTextAlignment(.leading)
    }
    private func daySummary(_ day: NewsDesk.Day, _ words: NewsWords) -> some View {
        Text(words.summary(day)).font(NewsType.quiet).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
    }

    /// A group of stories opens under its own small name; what is new wears the signal colour.
    private func head(_ title: String, accent: Bool = false) -> some View {
        Text(title).font(NewsType.head).monospacedDigit()
            .foregroundStyle(accent ? AppTheme.signal : AppTheme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }

    private func compact(_ moment: NewsDesk.Moment, page: NewsDesk.Page, row: String) -> some View {
        NewsCompactRow(moment: moment, day: page.date) { open(moment.id) }
            .onScrollVisibilityChange(threshold: 0.5) { dwell.rest(row + moment.id, $0) }
            .id(row + moment.id)
    }

    private func open(_ story: String) {
        feed.storyScroll = nil
        feed.place.story = story
    }
}

/// A row to scan: when it happened and where it belongs in one quiet line, then what it is. The summary waits on the story's page.
private struct NewsCompactRow: View {
    let moment: NewsDesk.Moment
    /// The page's day: a time on another day shows as its date.
    let day: String
    let open: () -> Void
    @Environment(\.newsWords) private var words

    var body: some View {
        let clock = words.column(moment, on: day)
        Button(action: open) {
            VStack(alignment: .leading, spacing: 3) {
                // ↻ marks a development of a story reported earlier.
                QuietLine(text: clock + " · " + moment.item.story.section.lowercased(with: words.language.locale), developed: moment.isDevelopment)
                Text(moment.item.story.title).font(NewsType.headline(19, .title3, weight: .regular)).multilineTextAlignment(.leading)
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
        .help(moment.item.story.summary)
        #endif
    }
}

/// The edition's first story: a large tile with its picture, or the desk's own paper, then what it says, what the
/// desk makes of it and where it comes from.
private struct NewsLeadStory: View {
    let item: NewsDesk.Item
    let developed: Bool
    let tint: Color
    let open: () -> Void
    @Environment(\.newsWords) private var words
    @Environment(\.newsHome) private var home
    @State private var picture: CGImage?

    var body: some View {
        let story = item.story, shown = picture ?? StoryPictures.cached(story.image)
        Button(action: open) {
            VStack(alignment: .leading, spacing: 0) {
                Tile(label: (developed ? "↻ " : "") + newsLine(story, locale: words.language.locale), skin: shown.map { .picture($0) } ?? .paper(tint),
                     side: .infinity, height: NewsLayout.lead, radius: 40) {
                    Spacer(minLength: 8)
                    Text(story.title).font(NewsType.headline(30, .title2)).lineSpacing(1).tracking(-0.3)
                        .lineLimit(5).minimumScaleFactor(0.8).multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .animation(.smooth(duration: 0.3), value: shown != nil)
                Text(story.summary).font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
                    .lineLimit(4).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 18)
                if let view = story.view { ViewLine(text: view, limit: 3).padding(.top, 12) }
                if !story.domains.isEmpty {
                    Capsules { ForEach(story.domains.prefix(4), id: \.self) { SourceCapsule(title: $0) } }.padding(.top, 16)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(TilePressStyle())
        .task(id: story.image) {
            guard let address = story.image else { picture = nil; return }
            picture = await StoryPictures.load(address, home: home)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
    }
}

private struct NewsRow: View {
    let item: NewsDesk.Item
    let developed: Bool
    let open: () -> Void
    @Environment(\.newsWords) private var words

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 4) {
                QuietLine(text: newsLine(item.story, locale: words.language.locale), developed: developed)
                Text(item.story.title).font(NewsType.headline(21, .title3))
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                Text(item.story.summary).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).lineSpacing(AppTypography.readingLineSpacing)
                    .lineLimit(2).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12)
            .contentShape(.rect)
        }
        .buttonStyle(NewsRowStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
    }
}

// MARK: - One story

/// The story open over its page. Next and previous follow the page's reading order.
private struct NewsStoryPage: View {
    @ObservedObject var feed: NewsFeed
    let date: String?
    let chrome: NewsChrome
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The story on screen. It stays while the page slides away after `place.story` is cleared.
    @State private var shown: String?

    init(feed: NewsFeed, date: String?, chrome: NewsChrome) {
        self.feed = feed; self.date = date; self.chrome = chrome
        _shown = State(initialValue: feed.place.story)
    }

    var body: some View {
        let words = feed.words, order = feed.desk.page(date, read: feed.visit).order
        let item = feed.desk.item(shown)
        ZStack {
            if let item {
                let next = order.firstIndex(of: item.id).flatMap { order.indices.contains($0 + 1) ? feed.desk.item(order[$0 + 1]) : nil }
                NewsArticle(item: item, next: next, start: feed.storyScroll?.story == item.id ? feed.storyScroll?.offset ?? 0 : 0,
                            scrolled: { feed.storyScroll = (item.id, $0) }, open: { feed.place.story = $0 },
                            step: { move($0, in: order) }, close: { feed.place.story = nil })
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
                feed.place.story = nil; feed.place.day = nil
            }
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            // Takes this story to the chat as context; the discussion happens there, with everything else.
            if let item {
                AskCapsule(title: words("Спросить про историю")) { chrome.discuss(item.latest) }
                    .accessibilityIdentifier("discussStory")
            }
        }
        .newsToolbar(feed, chrome, title: item?.story.title ?? "")
        #if os(macOS)
        .background {
            // Esc goes back from anywhere in the window, also while the sidebar holds the keyboard.
            Button(words("Сегодня")) { feed.place.story = nil }.keyboardShortcut(.cancelAction).opacity(0).accessibilityHidden(true)
        }
        #endif
        .onAppear { feed.appear(); see() }
        .onDisappear { feed.disappear() }
        .onChange(of: feed.place.story) { _, story in
            if let story { shown = story; see() }
        }
        // A story that left the feed leaves the screen.
        .onChange(of: item == nil) { _, gone in if gone { feed.place.story = nil } }
    }

    /// Opening a story is the plainest way of seeing it.
    private func see() {
        if let story = feed.place.story { feed.see([story]) }
    }

    private func move(_ step: Int, in order: [String]) {
        guard let index = order.firstIndex(of: feed.place.story ?? ""), order.indices.contains(index + step) else { return }
        feed.storyScroll = nil
        feed.place.story = order[index + step]
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
    let scrolled: (CGFloat) -> Void
    let open: (String) -> Void
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

    init(item: NewsDesk.Item, next: NewsDesk.Item?, start: CGFloat, scrolled: @escaping (CGFloat) -> Void, open: @escaping (String) -> Void,
         step: @escaping (Int) -> Void, close: @escaping () -> Void) {
        self.item = item; self.next = next; self.scrolled = scrolled; self.open = open; self.step = step; self.close = close
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
                if !links.isEmpty {
                    Capsules {
                        ForEach(Array(links.enumerated()), id: \.offset) { _, source in
                            Link(destination: source.url) { SourceCapsule(title: source.title) }.buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 18)
                }

                section(words("Что произошло")) { MessageContent(source: story.body).equatable() }
                evidence.padding(.top, 32)
                if item.developments.count > 1 { history.padding(.top, 32) }
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
        return Text("\(Text("↻ " + when).foregroundStyle(AppTheme.signal).fontWeight(.medium)) — \(change)")
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
