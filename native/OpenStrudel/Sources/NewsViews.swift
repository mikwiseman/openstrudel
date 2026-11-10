import SwiftUI

/// The News employee's stories as one page a day: the status line, what is new since the last visit, the morning
/// edition, the day's radar and the earlier days. A story opens over its page with its evidence and its history.
/// Discussion happens in the chat: «Обсудить в чате» takes the story there as context.

/// The edition's voice: a serif for headlines (the system's New York), the interface face for reading.
private enum NewsType {
    static func headline(_ mac: CGFloat, _ style: Font.TextStyle) -> Font {
        #if os(macOS)
        .system(size: mac, design: .serif)
        #else
        .system(style, design: .serif)
        #endif
    }
    static var kicker: Font {
        #if os(macOS)
        .system(size: 10.5, weight: .semibold)
        #else
        .caption2.weight(.semibold)
        #endif
    }
    static var lead: Font {
        #if os(macOS)
        .system(size: 17)
        #else
        .body
        #endif
    }
}

private enum NewsLayout {
    /// The page's reading column, wider than the chat's for headlines; a story reads in a narrower one.
    static let column: CGFloat = 720
    static let story: CGFloat = 640
    /// Under this width a compact row puts its headline below its time and section.
    static let columns: CGFloat = 520
}

private extension EnvironmentValues {
    /// The language of the stories on screen. Every label and date of the reader follows it.
    @Entry var newsWords = NewsWords()
}

private extension NewsStory {
    /// Where the story comes from, as the reader would name it: each source's site once.
    var domains: [String] {
        var seen = Set<String>()
        return sources.compactMap { URL(string: $0.url)?.host() }.map { $0.hasPrefix("www.") ? String($0.dropFirst(4)) : $0 }.filter { seen.insert($0).inserted }
    }
}

private extension View {
    /// Under the Mac toolbar, text scrolls behind a hard edge, as in the chat.
    func newsScrollEdge() -> some View {
        #if os(macOS)
        scrollEdgeEffectStyle(.hard, for: .top)
        #else
        self
        #endif
    }
}

/// A row is its own button: it dims under the finger and springs back.
private struct NewsRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.55 : 1)
            .animation(.smooth(duration: 0.15), value: configuration.isPressed)
    }
}

private struct Kicker: View {
    let section: String
    let status: String?
    /// ↻: the story moved since the reader had it on screen.
    var developed = false
    @Environment(\.newsWords) private var words

    var body: some View {
        // Large text moves the status under the section rather than breaking the section's words.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                label.fixedSize()
                if let status {
                    Text("•").foregroundStyle(AppTheme.secondaryText).accessibilityHidden(true)
                    pill(status).fixedSize()
                }
            }
            // One over the other, both may wrap: at the largest text sizes neither is ever wider than the page.
            VStack(alignment: .leading, spacing: 6) {
                label
                if let status { pill(status) }
            }
        }
        .font(NewsType.kicker)
        .accessibilityElement(children: .combine)
    }

    private var label: some View {
        HStack(spacing: 6) {
            if developed {
                Text("↻").foregroundStyle(Color("NewsStatusText")).accessibilityLabel(words("Развитие истории"))
            }
            Text(section.uppercased()).tracking(1.4).foregroundStyle(AppTheme.secondaryText)
        }
    }

    private func pill(_ status: String) -> some View {
        Text(status.uppercased()).tracking(1)
            .foregroundStyle(Color("NewsStatusText"))
            .padding(.horizontal, 6).padding(.vertical, 3)
            .background(Color("NewsStatusFill"), in: .rect(cornerRadius: 4, style: .continuous))
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct ArrowLabel: View {
    let title: String
    var symbol = "arrow.right"
    var body: some View {
        HStack(spacing: 6) { Text(title); Image(systemName: symbol).imageScale(.small) }
            .font(AppTypography.interface.weight(.medium))
            .foregroundStyle(.primary)
    }
}

// MARK: - The screen

/// One feed, opened from the sidebar, from Insights or from the conversations list.
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

/// What every page of a feed shares: whose feed it is, whether the reader is looking, and the two ways out.
private struct NewsChrome {
    let profile: EmployeeProfile?
    let attentive: Bool
    let showDetails: () -> Void
    let discuss: (HomeMessage) -> Void
}

private extension View {
    /// The employee's name in the toolbar opens its settings, as in every reader. Its character lives in the status line.
    func newsToolbar(_ feed: NewsFeed, _ chrome: NewsChrome, title: String) -> some View {
        navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            // A pushed page would sit on the system's white; the edition reads on the app's own paper.
            .containerBackground(AppTheme.canvas, for: .navigation)
            #endif
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Button(action: chrome.showDetails) {
                        Text(feed.route.title).font(.body.weight(.semibold)).lineLimit(1)
                            .frame(maxWidth: 240)
                            #if os(iOS)
                            .frame(minHeight: controlTarget).contentShape(Rectangle())
                            #endif
                    }
                    .buttonStyle(.plain)
                    .disabled(chrome.profile == nil)
                    .accessibilityLabel(chrome.profile == nil ? feed.route.title : L("Настройки сотрудника"))
                    .accessibilityValue(feed.route.title)
                    .accessibilityIdentifier("readerTitle")
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
    @Environment(\.dynamicTypeSize) private var textSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var width = NewsLayout.column
    @State private var dwell = NewsDwell()

    /// Nothing is pushed over this page.
    private var isFront: Bool { feed.place.story == nil && feed.place.day == date }
    private var stacked: Bool { textSize.isAccessibilitySize || width < NewsLayout.columns }

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
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
                    .padding(.horizontal, Layout.edge)
                    .padding(.bottom, 48)
                    .frame(maxWidth: .infinity)
                }
                // Back from a story, from a day or from the chat, the page opens where the reader left it.
                .scrollPosition(id: Binding(get: { feed.anchors[date ?? ""] }, set: { feed.anchors[date ?? ""] = $0 }), anchor: .top)
                .scrollIndicators(.hidden)
                .newsScrollEdge()
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
        }
        .newsToolbar(feed, chrome, title: date.map { feed.words.day($0) } ?? feed.words("Сегодня"))
        .navigationDestination(isPresented: Binding(get: { feed.place.story != nil && feed.place.day == date }, set: { if !$0 { feed.closeStory() } })) {
            NewsStoryPage(feed: feed, date: date, chrome: chrome)
        }
        .navigationDestination(item: Binding(get: { date == nil ? feed.place.day : nil }, set: { if date == nil { if let day = $0 { feed.place.day = day } else { feed.closeDay() } } })) { day in
            NewsDayPage(feed: feed, date: day, chrome: chrome).environmentObject(client).id(day)
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

    private func masthead(_ page: NewsDesk.Page, line: NewsStatusLine?, words: NewsWords, now: Date) -> some View {
        let offline = feed.unreachable || client.homeUnreachable || client.connectionNeedsPairing
        // The space under the toolbar belongs to this first row, so scrolling to it shows the page's very top.
        return VStack(alignment: .leading, spacing: 8) {
            Text(words.masthead(page.date, now: now)).font(NewsType.kicker).tracking(2).foregroundStyle(AppTheme.secondaryText)
                .padding(.top, Layout.belowToolbar)
                .accessibilityAddTraits(.isHeader)
            if let line {
                HStack(alignment: .center, spacing: 12) {
                    if page.isToday {
                        WorkingCharacter(appearance: chrome.profile?.resolvedAppearance, working: line.isRunning && !offline, landings: feed.landings,
                                         offline: offline || line.isFailing)
                    }
                    Text(offline ? words("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : words.status(line, name: feed.route.title, now: now))
                        .font(AppTypography.meta).monospacedDigit()
                        .foregroundStyle(line.isFailing && !offline ? AppTheme.warning : AppTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                        .animation(.easeInOut(duration: 0.15), value: line)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("newsStatus")
            }
        }
        .padding(.bottom, 32)
    }

    /// No story in two weeks: the character, the truth in one sentence, and nothing to press.
    private func empty(_ line: NewsStatusLine, words: NewsWords, now: Date) -> some View {
        let offline = feed.unreachable || client.homeUnreachable || client.connectionNeedsPairing
        return VStack(spacing: 16) {
            WorkingCharacter(appearance: chrome.profile?.resolvedAppearance, size: AvatarSize.hero, working: line.isRunning && !offline, offline: offline || line.isFailing)
            Text(offline ? words("«\(client.displayName)» не на связи. Показано, что уже прочитано.") : words.status(line, name: feed.route.title, now: now))
                .font(NewsType.headline(26, .title2)).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            Text(words("Истории за последние две недели появятся здесь.")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: 420)
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("newsEmpty")
    }

    // MARK: Sections

    @ViewBuilder private func sections(_ page: NewsDesk.Page, words: NewsWords, now: Date) -> some View {
        let hasFresh = !page.fresh.isEmpty, hasEdition = !page.edition.isEmpty, hasRadar = !page.radar.isEmpty
        if hasFresh {
            head(words.freshTitle(since: page.freshSince(feed.visit), count: page.fresh.count, now: now), words: words, accent: true, ruled: false)
                .id("fresh")
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
            head(page.editionDate == page.date ? words("Утренний выпуск") : words("Выпуск за \(words.day(page.editionDate ?? page.date, now: now))"), words: words)
                .padding(.top, hasFresh ? 32 : 0).padding(.bottom, 16).id("edition")
            // One run of rows, so a story keeps its identity when the next edition makes it the lead.
            ForEach(Array(page.edition.enumerated()), id: \.element.id) { index, item in
                Group {
                    if index == 0 { NewsLeadStory(item: item, developed: item.developed(since: feed.visit)) { open(item.id) } }
                    else { NewsRow(number: index + 1, item: item, developed: item.developed(since: feed.visit), stacked: textSize.isAccessibilitySize) { open(item.id) } }
                }
                .onScrollVisibilityChange(threshold: 0.5) { dwell.rest("edition:" + item.id, $0) }
                .id("edition:" + item.id)
            }
        }
        if hasRadar {
            head(words("Радар за день"), words: words).padding(.top, hasFresh || hasEdition ? 48 : 0).id("radar")
            ForEach(page.radar) { moment in
                compact(moment, page: page, row: "radar:")
            }
        }
        if !page.earlier.isEmpty {
            head(words("Раньше"), words: words).padding(.top, hasFresh || hasEdition || hasRadar ? 48 : 0).id("earlier")
            ForEach(page.earlier) { day in
                Button { feed.place.day = day.date } label: {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline) { dayTitle(day, words, now); Spacer(minLength: 16); daySummary(day, words) }
                        VStack(alignment: .leading, spacing: 4) { dayTitle(day, words, now); daySummary(day, words) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 10)
                    .overlay(alignment: .bottom) { Hairline() }
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
        Text(words.summary(day)).font(AppTypography.meta).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
    }

    /// A section opens under an ink rule, as on a front page; «Новое» continues the status line and has none.
    private func head(_ title: String, words: NewsWords, accent: Bool = false, ruled: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if ruled { Rectangle().fill(Color.primary.opacity(0.75)).frame(height: 1.5) }
            Text(title.uppercased(with: words.language.locale)).font(NewsType.kicker).tracking(2).monospacedDigit()
                .foregroundStyle(accent ? Color("NewsStatusText") : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.bottom, 4)
    }

    private func compact(_ moment: NewsDesk.Moment, page: NewsDesk.Page, row: String) -> some View {
        NewsCompactRow(moment: moment, day: page.date, stacked: stacked) { open(moment.id) }
            .onScrollVisibilityChange(threshold: 0.5) { dwell.rest(row + moment.id, $0) }
            .id(row + moment.id)
    }

    private func open(_ story: String) {
        feed.storyScroll = nil
        feed.place.story = story
    }
}

/// One line to scan: when it happened, where it belongs, what it is. The summary waits on the story's page.
private struct NewsCompactRow: View {
    let moment: NewsDesk.Moment
    /// The page's day: a time on another day shows as its date.
    let day: String
    let stacked: Bool
    let open: () -> Void
    @Environment(\.newsWords) private var words

    var body: some View {
        Button(action: open) {
            Group {
                if stacked {
                    VStack(alignment: .leading, spacing: 4) {
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) { time; section }
                            VStack(alignment: .leading, spacing: 2) { time; section }
                        }
                        title
                    }
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        time.frame(width: 64, alignment: .leading)
                        section.lineLimit(1).frame(width: 128, alignment: .leading)
                        title.lineLimit(2)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, stacked ? 12 : 10)
            .overlay(alignment: .bottom) { Hairline() }
            .contentShape(.rect)
        }
        .buttonStyle(NewsRowStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
        #if os(macOS)
        .help(moment.item.story.summary)
        #endif
    }

    /// ↻ marks a development of a story reported earlier; a first report has its time alone.
    private var time: some View {
        let clock = words.column(moment, on: day)
        return Text(moment.isDevelopment ? "↻ " + clock : clock).font(AppTypography.meta).monospacedDigit()
            .foregroundStyle(moment.isDevelopment ? Color("NewsStatusText") : AppTheme.secondaryText)
            .accessibilityLabel(moment.isDevelopment ? words("Развитие истории") + ", " + clock : clock)
    }
    private var section: some View {
        Text(moment.item.story.section.uppercased()).font(NewsType.kicker).tracking(1.2).foregroundStyle(AppTheme.secondaryText)
    }
    private var title: some View {
        Text(moment.item.story.title).font(NewsType.headline(17, .body)).multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct NewsLeadStory: View {
    let item: NewsDesk.Item
    let developed: Bool
    let open: () -> Void
    @Environment(\.newsWords) private var words

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 12) {
                Kicker(section: item.story.section, status: item.story.status, developed: developed)
                Text(item.story.title).font(NewsType.headline(36, .title)).lineSpacing(2)
                    .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                Text(item.story.summary).font(NewsType.lead).foregroundStyle(AppTheme.secondaryText).lineSpacing(AppTypography.readingLineSpacing)
                    .lineLimit(3).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                if !item.story.domains.isEmpty {
                    Text(item.story.domains.joined(separator: " · ")).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
                        .lineLimit(1).padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 24)
            .overlay(alignment: .bottom) { Hairline() }
            .contentShape(.rect)
        }
        .buttonStyle(NewsRowStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
    }
}

private struct NewsRow: View {
    let number: Int
    let item: NewsDesk.Item
    let developed: Bool
    /// Large text puts the number over the story instead of beside it.
    let stacked: Bool
    let open: () -> Void
    @Environment(\.newsWords) private var words

    var body: some View {
        Button(action: open) {
            Group {
                if stacked { VStack(alignment: .leading, spacing: 8) { numeral; story } }
                else { HStack(alignment: .firstTextBaseline, spacing: 16) { numeral.frame(minWidth: 24, alignment: .leading); story } }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 16)
            .overlay(alignment: .bottom) { Hairline() }
            .contentShape(.rect)
        }
        .buttonStyle(NewsRowStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(words("Открыть историю"))
    }

    private var numeral: some View {
        Text(String(format: "%02d", number)).font(NewsType.headline(17, .body).italic()).foregroundStyle(AppTheme.secondaryText).monospacedDigit()
    }
    private var story: some View {
        VStack(alignment: .leading, spacing: 6) {
            Kicker(section: item.story.section, status: item.story.status, developed: developed)
            Text(item.story.title).font(NewsType.headline(22, .title3))
                .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
            Text(item.story.summary).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).lineSpacing(AppTypography.readingLineSpacing)
                .lineLimit(2).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
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
                            scrolled: { feed.storyScroll = (item.id, $0) }, open: { feed.place.story = $0 }, discuss: { chrome.discuss(item.latest) },
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
    /// Takes this story to the chat as context; the discussion happens there, with everything else.
    let discuss: () -> Void
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

    init(item: NewsDesk.Item, next: NewsDesk.Item?, start: CGFloat, scrolled: @escaping (CGFloat) -> Void, open: @escaping (String) -> Void, discuss: @escaping () -> Void,
         step: @escaping (Int) -> Void, close: @escaping () -> Void) {
        self.item = item; self.next = next; self.scrolled = scrolled; self.open = open; self.discuss = discuss; self.step = step; self.close = close
        // Three sources or fewer are the evidence at a glance; more wait behind their count.
        _showsSources = State(initialValue: item.story.sources.count <= 3)
        _position = State(initialValue: start > 0 ? ScrollPosition(point: CGPoint(x: 0, y: start)) : ScrollPosition(edge: .top))
    }

    private var story: NewsStory { item.story }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Kicker(section: story.section, status: story.status)
                Text(story.title).font(NewsType.headline(42, .largeTitle)).lineSpacing(2).padding(.top, 16)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text(story.summary).font(NewsType.lead).foregroundStyle(AppTheme.secondaryText).lineSpacing(5).padding(.top, 16)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if item.developments.count > 1, let change = item.newest.story?.change { development(item.newest, change).padding(.top, 16) }
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 24) { domains; Spacer(minLength: 0); discussButton.fixedSize() }
                    VStack(alignment: .leading, spacing: 12) { domains; discussButton }
                }
                .padding(.top, 24).padding(.bottom, 32)
                Hairline()

                section(words("Что произошло")) { MessageContent(source: story.body).equatable() }
                if let view = story.view { opinion(view) }
                evidence.padding(.top, 32)
                if item.developments.count > 1 { history.padding(.top, 32) }
                if let next {
                    Button { open(next.id) } label: {
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .firstTextBaseline) { nextLabel; Spacer(minLength: 16); ArrowLabel(title: next.story.title).multilineTextAlignment(.trailing) }
                            VStack(alignment: .leading, spacing: 8) { nextLabel; ArrowLabel(title: next.story.title).multilineTextAlignment(.leading) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 24).overlay(alignment: .top) { Hairline() }.contentShape(.rect)
                    }
                    .buttonStyle(NewsRowStyle()).padding(.top, 32)
                    .accessibilityIdentifier("nextStory")
                }
            }
            .frame(maxWidth: NewsLayout.story, alignment: .leading)
            .padding(.horizontal, Layout.edge)
            .padding(.top, Layout.belowToolbar)
            .padding(.bottom, 48)
            .frame(maxWidth: .infinity)
        }
        .scrollPosition($position)
        .onScrollGeometryChange(for: [CGFloat].self) { [$0.contentOffset.y + $0.contentInsets.top, $0.visibleRect.height, $0.contentSize.height - $0.visibleRect.height] } action: { _, now in
            scroll.offset = now[0]; scroll.page = now[1]; scroll.end = max(0, now[2])
            scrolled(now[0])
        }
        .scrollIndicators(.hidden)
        .newsScrollEdge()
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

    private var nextLabel: some View { Text(words("Дальше")).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText) }

    private var domains: some View {
        Text(story.domains.joined(separator: " · ")).font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
    }

    private var discussButton: some View {
        Button(action: discuss) { ArrowLabel(title: words("Обсудить в чате")).multilineTextAlignment(.leading) }
            .buttonStyle(.plain).accessibilityIdentifier("discussStory")
    }

    /// The latest development leads the story it changed.
    private func development(_ version: HomeMessage, _ change: String) -> some View {
        let when = version.sentAt.map { words.moment($0) } ?? ""
        // No text selection here: on the Mac a selectable text with its own accessibility label never finishes resolving it.
        return Text("\(Text("↻ " + when).foregroundStyle(Color("NewsStatusText")).fontWeight(.medium)) — \(change)")
            .font(AppTypography.reading).lineSpacing(AppTypography.readingLineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(words("Развитие истории") + ", " + when + ". " + change)
    }

    private func label(_ title: String) -> some View {
        Text(title.uppercased(with: words.language.locale)).font(NewsType.kicker).tracking(1.6).foregroundStyle(Color("NewsStatusText"))
            .accessibilityAddTraits(.isHeader)
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            label(title)
            content()
        }
        .padding(.top, 32)
    }

    private func opinion(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(words("Наш взгляд").uppercased(with: words.language.locale)).font(NewsType.kicker).tracking(1.6).foregroundStyle(AppTheme.secondaryText)
                .accessibilityAddTraits(.isHeader)
            Text(text).font(NewsType.headline(21, .title3)).lineSpacing(4).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 20)
        .overlay(alignment: .leading) { Rectangle().fill(Color("NewsStatusText").opacity(0.6)).frame(width: 2) }
        .padding(.top, 32)
        .accessibilityElement(children: .contain)
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
                                        Text(source.title).underline().multilineTextAlignment(.leading)
                                        Image(systemName: "arrow.up.right").imageScale(.small)
                                    }
                                }
                                .font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText)
                            }
                            Text([source.role, URL(string: source.url)?.host(), NewsDesk.instant(source.publishedAt, words.calendar).map { $0.hasClock ? words.moment($0.date) : words.day($0.date) }]
                                .compactMap { $0 }.joined(separator: " · "))
                                .font(AppTypography.meta).foregroundStyle(AppTheme.secondaryText)
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
        let name = Text(name).font(AppTypography.meta).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
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

// MARK: - Entry points

/// The Mac sidebar's row for a feed: its name and how much of today the reader has not seen.
struct NewsSidebarRow: View {
    @ObservedObject var feed: NewsFeed
    var body: some View {
        Label(feed.route.title, systemImage: "newspaper").badge(feed.unseen)
    }
}

/// The feed's row where the iPhone lists what to read: what leads today, and how much is new.
struct NewsEntryRow: View {
    @ObservedObject var feed: NewsFeed
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        let words = feed.words, unseen = feed.unseen
        let name = Text(feed.route.title.uppercased()).tracking(1.4).foregroundStyle(AppTheme.secondaryText)
        let fresh = Text(words.fresh(unseen).uppercased(with: words.language.locale)).tracking(1.4).foregroundStyle(Color("NewsStatusText"))
        VStack(alignment: .leading, spacing: 6) {
            // Large text puts the count under the name rather than breaking its words.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                    name.fixedSize()
                    if unseen > 0 {
                        Text("·").foregroundStyle(AppTheme.secondaryText).accessibilityHidden(true)
                        fresh.fixedSize()
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    name
                    if unseen > 0 { fresh }
                }
            }
            .font(NewsType.kicker)
            Text(feed.headline ?? words("Утренний выпуск")).font(NewsType.headline(22, .title3)).foregroundStyle(.primary)
                .lineLimit(textSize.isAccessibilitySize ? nil : 3).multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
