import SwiftUI

/// The pages behind a desk's front page: the week in its stories, the search, and everything about one name. They
/// read like the paper: one column, sentence-case labels, a story one press away.

/// One name the desk writes about, as a page to open.
struct NewsTopic: Hashable, Identifiable { let name: String; var id: String { name.lowercased() } }

struct NewsPanelPage: View {
    @ObservedObject var feed: NewsFeed
    let panel: NewsPanel
    let chrome: NewsChrome

    var body: some View {
        switch panel {
        case .week: NewsWeekPage(feed: feed, posts: feed.posts, chrome: chrome)
        case .posts: NewsPostsPage(feed: feed, posts: feed.posts, chrome: chrome)
        case .search: NewsListPage(feed: feed, kind: .search, chrome: chrome)
        }
    }
}

private extension View {
    /// A page of the desk: the paper's canvas, its capsule in the bar, the desk's column.
    func newsPage(_ feed: NewsFeed, _ chrome: NewsChrome, title: String) -> some View {
        paperTop()
            .environment(\.newsWords, feed.words)
            .newsToolbar(feed, chrome, title: title)
            .onAppear { feed.appear() }
            .onDisappear { feed.disappear() }
    }
}

// MARK: - The week

/// What moved in seven days: how much came out and what the reader made of it as tiles, then where the stories were,
/// whom they were about, which ones kept developing, and the posts written from them.
struct NewsWeekPage: View {
    @ObservedObject var feed: NewsFeed
    @ObservedObject var posts: NewsPostShelf
    let chrome: NewsChrome
    @State private var story: String?
    @State private var topic: NewsTopic?
    @State private var showsAllTopics = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        TimelineView(.everyMinute) { timeline in
            let words = feed.words, now = timeline.date
            let week = NewsWeek(feed.desk, read: feed.read, now: now)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(words("Неделя")).font(NewsType.dayTitle).displayTracking(-0.7).accessibilityAddTraits(.isHeader)
                    Text(words("Семь дней по \(words.day(now, now: now))")).font(NewsType.quiet).foregroundStyle(AppTheme.secondaryText).padding(.top, 5)
                    tiles(week, words: words, now: now).padding(.top, 18)
                    if !week.sections.isEmpty { group(words("Что движется")) { ForEach(week.sections) { bar($0, most: week.sections[0].count, words: words) } } }
                    if !week.topics.isEmpty {
                        group(words("Компании и люди")) {
                            ForEach(showsAllTopics ? week.topics : Array(week.topics.prefix(6))) { name in
                                Button { topic = NewsTopic(name: name.name) } label: { nameRow(name, words: words) }
                                    .buttonStyle(NewsRowStyle()).accessibilityIdentifier("weekTopic-" + name.id)
                            }
                            if week.topics.count > 6 {
                                Button(showsAllTopics ? words("Свернуть") : words("Показать все · \(week.topics.count)")) { showsAllTopics.toggle() }
                                    .buttonStyle(.plain).font(AppTypography.interface.weight(.medium)).foregroundStyle(AppTheme.accentText).frame(minHeight: controlTarget)
                            }
                        }
                    }
                    if !week.storylines.isEmpty {
                        group(words("Истории с продолжением")) {
                            ForEach(week.storylines.prefix(8)) { line in
                                NewsCompactRow(item: line.item, line: words.events(line.events) + " · " + words.moment(line.latest, now: now), developed: true) { story = line.item.id }
                            }
                        }
                    }
                    if !posts.posts.isEmpty {
                        group(words("Посты")) {
                            ForEach(posts.posts.prefix(5)) { post in NewsPostRow(post: post) { chrome.post(NewsPostRequest(stories: post.storyIds, post: post.id)) } }
                        }
                    }
                }
                .frame(maxWidth: NewsLayout.column, alignment: .leading)
                .padding(.horizontal, Layout.edge).padding(.top, 10).padding(.bottom, 32)
                .frame(maxWidth: .infinity)
            }
            .scrollIndicators(.hidden)
            .accessibilityIdentifier("newsWeek")
        }
        .newsPage(feed, chrome, title: feed.words("Неделя"))
        .task { await posts.load() }
        .navigationDestination(isPresented: Binding(get: { story != nil }, set: { if !$0 { story = nil } })) {
            NewsStoryPage(feed: feed, story: $story, order: NewsWeek(feed.desk, read: feed.read).storylines.map(\.item.id), chrome: chrome)
        }
        .navigationDestination(item: $topic) { NewsListPage(feed: feed, kind: .topic($0.name), chrome: chrome) }
    }

    /// The week as numbers: what came out, what the reader read, what became posts, and the run of days.
    private func tiles(_ week: NewsWeek, words: NewsWords, now: Date) -> some View {
        let used = posts.posts.filter { $0.usedAt != nil }.count, streak = feed.read.streak(now: now, calendar: feed.desk.calendar)
        return DataShelf {
            NumberTile(label: words("Истории"), value: week.stories.count.formatted(),
                       caption: week.storiesBefore.map { words("неделей раньше: \($0)") } ?? (week.mustKnow > 0 ? words("срочных: \(week.mustKnow)") : nil), skin: .ink)
            NumberTile(label: words("Прочитано"), value: week.opened.formatted(), caption: words("на экране было: \(week.seen)"))
            NumberTile(label: words("Посты"), value: posts.posts.count.formatted(), caption: used > 0 ? words("взято в работу: \(used)") : words("черновики"),
                       skin: .paper(AgentAppearance.tint(chrome.profile?.resolvedAppearance, dark: scheme == .dark)))
            if streak > 1 { NumberTile(label: words("Дней подряд"), value: streak.formatted(), caption: words("с газетой")) }
        }
    }

    private func group(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(NewsType.head).foregroundStyle(AppTheme.secondaryText).padding(.bottom, 6).accessibilityAddTraits(.isHeader)
            content()
        }
        .padding(.top, 34)
    }

    /// A section's share of the week as an ink capsule on a quiet track, its count, and how that compares.
    private func bar(_ section: NewsWeek.Count, most: Int, words: NewsWords) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(section.name).font(AppTypography.reading)
                Spacer(minLength: 12)
                Text(section.count.formatted()).font(AppTypography.reading.weight(.medium)).monospacedDigit()
                if let before = section.before { direction(section.count, before, words) }
            }
            GeometryReader { room in
                ZStack(alignment: .leading) {
                    Capsule().fill(AppTheme.separator)
                    Capsule().fill(AppTheme.accentText).frame(width: max(4, room.size.width * CGFloat(section.count) / CGFloat(max(most, 1))))
                }
            }
            .frame(height: 4)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(section.name)
        .accessibilityValue(words.stories(section.count) + (section.before.map { ", " + words("неделей раньше: \($0)") } ?? ""))
    }

    /// «+6» with an arrow up, «−2» with an arrow down: the week against the one before. Words and a shape, never colour alone.
    private func direction(_ count: Int, _ before: Int, _ words: NewsWords) -> some View {
        HStack(spacing: 3) {
            Image(systemName: count == before ? "equal" : count > before ? "arrow.up.right" : "arrow.down.right").imageScale(.small)
            if count != before { Text(words.change(count, from: before)) }
        }
        .font(NewsType.quiet).monospacedDigit()
        .foregroundStyle(count > before ? AppTheme.signalText : AppTheme.secondaryText)
        .frame(minWidth: 44, alignment: .trailing)
    }

    private func nameRow(_ name: NewsWeek.Count, words: NewsWords) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(name.name).font(NewsType.headline(19, .title3))
                Spacer(minLength: 12)
                Text(words.stories(name.count)).font(NewsType.quiet).monospacedDigit().foregroundStyle(AppTheme.secondaryText)
                if let before = name.before { direction(name.count, before, words) }
            }
            Text(name.latest.story.title).font(AppTypography.reading).foregroundStyle(AppTheme.secondaryText).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 9).contentShape(.rect)
    }
}

// MARK: - A list of stories

/// Stories found by words, or everything about one name: rows to scan, the newest first.
struct NewsListPage: View {
    enum Kind: Hashable { case search, topic(String) }
    @ObservedObject var feed: NewsFeed
    let kind: Kind
    let chrome: NewsChrome
    @State private var query = ""
    @State private var story: String?
    @FocusState private var typing: Bool

    private var found: [NewsDesk.Item] {
        switch kind {
        case .search: feed.desk.search(query)
        case .topic(let name):
            feed.desk.items.filter { $0.topics.contains { $0.caseInsensitiveCompare(name) == .orderedSame } }
                .sorted { ($0.newest.sentAt ?? .distantPast) > ($1.newest.sentAt ?? .distantPast) }
        }
    }

    var body: some View {
        let words = feed.words, found = found
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                switch kind {
                case .topic(let name):
                    Text(name).font(NewsType.dayTitle).displayTracking(-0.7).accessibilityAddTraits(.isHeader)
                    Text(words.stories(found.count) + " · " + words("за две недели")).font(NewsType.quiet).foregroundStyle(AppTheme.secondaryText).padding(.top, 5).padding(.bottom, 14)
                case .search:
                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass").foregroundStyle(AppTheme.secondaryText)
                        TextField(words("Компания, модель, слово"), text: $query).textFieldStyle(.plain).font(AppTypography.reading).focused($typing)
                            .autocorrectionDisabled().submitLabel(.search).accessibilityIdentifier("newsSearchField")
                        if !query.isEmpty {
                            Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(AppTheme.faint) }.buttonStyle(.plain)
                                .accessibilityLabel(words("Стереть"))
                        }
                    }
                    .padding(.horizontal, 16).frame(minHeight: AskCapsule.height).background(AppTheme.surface, in: Capsule()).padding(.bottom, 14)
                    if query.trimmingCharacters(in: .whitespaces).isEmpty {
                        Text(words("Ищет в историях за последние две недели: в заголовках, текстах и источниках.")).font(AppTypography.interface)
                            .foregroundStyle(AppTheme.secondaryText).fixedSize(horizontal: false, vertical: true)
                    } else if found.isEmpty {
                        Text(words("Ничего не нашлось.")).font(AppTypography.interface).foregroundStyle(AppTheme.secondaryText)
                    }
                }
                ForEach(found) { item in
                    NewsCompactRow(item: item, line: [item.newest.sentAt.map { words.shortDay($0) }, item.story.section.lowercased(with: words.language.locale)].compactMap { $0 }.joined(separator: " · ")) { story = item.id }
                }
            }
            .frame(maxWidth: NewsLayout.column, alignment: .leading)
            .padding(.horizontal, Layout.edge).padding(.top, 10).padding(.bottom, 32)
            .frame(maxWidth: .infinity)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier(kind == .search ? "newsSearch" : "newsTopic")
        .newsPage(feed, chrome, title: { if case .topic(let name) = kind { name } else { words("Найти") } }())
        .onAppear { if kind == .search, query.isEmpty { typing = true } }
        .navigationDestination(isPresented: Binding(get: { story != nil }, set: { if !$0 { story = nil } })) {
            NewsStoryPage(feed: feed, story: $story, order: found.map(\.id), chrome: chrome)
        }
    }
}
