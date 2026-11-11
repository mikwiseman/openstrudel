import Combine
import Foundation

/// The stories of one News employee, arranged for reading: each day's morning edition, and what the radar reported that day.
/// Every story is a run of messages in the employee's chat; a later message with the same story id is its newer version.
struct NewsDesk {
    struct Item: Identifiable {
        let id: String
        /// Oldest first; the last one is the story as it stands now.
        var versions: [HomeMessage] = []
        var latest: HomeMessage { versions[versions.count - 1] }
        var story: NewsStory { latest.story! }
        /// Curation and copy edits keep versions for identity, but are not new events.
        var developments: [HomeMessage] {
            versions.filter { $0.id == versions.first?.id || $0.story?.change?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
        }
        /// The story's newest event: what "seen" is measured against.
        var newest: HomeMessage { developments[developments.count - 1] }

        func isUnseen(_ read: NewsReadState) -> Bool { !read.seen.contains(newest.id) }
        /// The reader had this story on screen before, and it has moved since.
        func developed(since read: NewsReadState) -> Bool {
            isUnseen(read) && developments.dropLast().contains { read.seen.contains($0.id) }
        }
    }

    /// One thing the radar reported on a day: a story's first report, or a later development.
    struct Moment: Identifiable {
        let item: Item
        let version: HomeMessage
        /// When News published it. Decides the day it belongs to.
        let published: Date
        /// What the row shows and sorts by: the event's own time for a first report that knows it, otherwise the publication.
        let time: Date
        /// False when only the event's day is known.
        let hasClock: Bool
        let isDevelopment: Bool
        var id: String { item.id }
    }

    struct Day: Identifiable {
        /// 2026-11-10
        let date: String
        /// The morning edition in its order; empty when none came out.
        var edition: [Item] = []
        /// When the edition first appeared.
        var published: Date?
        /// Newest event first.
        var radar: [Moment] = []
        var id: String { date }
    }

    /// What one screen shows: today, or an earlier day.
    struct Page {
        let date: String
        let isToday: Bool
        /// «Новое»: radar stories and developments the reader has not had on screen, back to yesterday. Today only.
        var fresh: [Moment] = []
        var edition: [Item] = []
        /// Differs from `date` when today has no edition and the latest one stands in.
        var editionDate: String?
        var published: Date?
        /// The day's radar without what «Новое» and the edition already show.
        var radar: [Moment] = []
        /// «Раньше», newest first.
        var earlier: [Day] = []

        var isEmpty: Bool { fresh.isEmpty && edition.isEmpty && radar.isEmpty && earlier.isEmpty }
        /// Every story of the page once, in reading order: the way next and previous move.
        var order: [String] {
            var seen = Set<String>()
            return (fresh.map(\.id) + edition.map(\.id) + radar.map(\.id)).filter { seen.insert($0).inserted }
        }
        /// «Новое с 11:40» is true only when everything in it came after the last visit. A row the reader left unseen
        /// then is still new to them, and the line drops its time.
        func freshSince(_ read: NewsReadState) -> Date? {
            read.lastVisitAt.flatMap { last in fresh.allSatisfy { $0.published > last } ? last : nil }
        }
        /// What the entry point counts: the «Новое» rows and the edition's stories not yet seen.
        func unseen(_ read: NewsReadState) -> Int { fresh.count + edition.filter { $0.isUnseen(read) }.count }
    }

    let items: [Item]
    /// Every day with an edition or a radar report, newest first.
    let days: [Day]
    let calendar: Calendar

    init(_ messages: [HomeMessage], calendar: Calendar = .current) {
        self.calendar = calendar
        var byID: [String: Item] = [:], order: [String] = []
        for message in messages {
            guard let id = message.story?.id else { continue }
            if byID[id] == nil { byID[id] = Item(id: id); order.append(id) }
            byID[id]!.versions.append(message)
        }
        let items = order.compactMap { byID[$0] }
        var days: [String: Day] = [:], placed: [String: [(item: Item, rank: Int, at: String)]] = [:]
        for item in items {
            // A story's last version in an edition decides its place there.
            var place: [String: HomeMessage] = [:]
            for version in item.versions {
                guard let edition = version.story?.edition else { continue }
                place[edition] = version
                if let at = version.sentAt, at < days[edition]?.published ?? .distantFuture { days[edition, default: Day(date: edition)].published = at }
            }
            for (edition, version) in place { placed[edition, default: []].append((item, version.story?.rank ?? .max, version.createdAt)) }
            // One radar row for a story on a day: its latest event that day.
            var reported: [String: Moment] = [:]
            for version in item.developments where version.story?.edition == nil {
                guard let moment = Self.moment(item, version, calendar) else { continue }
                reported[Self.dayKey(moment.published, calendar)] = moment
            }
            for (day, moment) in reported { days[day, default: Day(date: day)].radar.append(moment) }
        }
        for (edition, rows) in placed {
            days[edition, default: Day(date: edition)].edition = rows.sorted { $0.rank == $1.rank ? $0.at < $1.at : $0.rank < $1.rank }.map(\.item)
        }
        self.items = items
        self.days = days.values.map { day in
            var day = day
            day.radar.sort { $0.time == $1.time ? $0.published > $1.published : $0.time > $1.time }
            return day
        }.sorted { $0.date > $1.date }
    }

    func item(_ id: String?) -> Item? { items.first { $0.id == id } }

    /// Today's page, or the page of an earlier day.
    func page(_ date: String? = nil, now: Date = .now, read: NewsReadState = NewsReadState()) -> Page {
        let today = Self.dayKey(now, calendar)
        guard let date, date != today else { return todayPage(today, now: now, read: read) }
        var page = Page(date: date, isToday: false)
        if let day = days.first(where: { $0.date == date }) {
            page.edition = day.edition; page.published = day.published
            if !day.edition.isEmpty { page.editionDate = date }
            page.radar = radar(of: day, under: day, without: [])
        }
        page.earlier = days.filter { $0.date < today && $0.date != date }
        return page
    }

    private func todayPage(_ today: String, now: Date, read: NewsReadState) -> Page {
        var page = Page(date: today, isToday: true)
        // An edition dated today or later is the current one; otherwise the latest one stands in.
        let edition = days.first { !$0.edition.isEmpty }
        if let edition { page.edition = edition.edition; page.editionDate = edition.date; page.published = edition.published }
        let inEdition = Set(page.edition.map(\.id))
        let floor = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now)) ?? now
        page.fresh = items.compactMap { item in
            guard item.isUnseen(read), item.newest.story?.edition == nil, !inEdition.contains(item.id),
                  let moment = Self.moment(item, item.newest, calendar), moment.published >= floor else { return nil }
            return moment
        }.sorted { $0.time == $1.time ? $0.published > $1.published : $0.time > $1.time }
        if let day = days.first(where: { $0.date == today }) { page.radar = radar(of: day, under: edition, without: Set(page.fresh.map(\.id))) }
        page.earlier = days.filter { $0.date < today }
        return page
    }

    /// A story the edition above already carries is not repeated in the radar, unless it developed after the edition.
    private func radar(of day: Day, under edition: Day?, without shown: Set<String>) -> [Moment] {
        day.radar.filter { moment in
            guard !shown.contains(moment.id) else { return false }
            guard let edition, let placed = moment.item.versions.last(where: { $0.story?.edition == edition.date })?.sentAt else { return true }
            return moment.published > placed
        }
    }

    /// How many stories, developments or edition places `next` has that this desk does not: what «N новых» counts.
    func arrivals(in next: NewsDesk) -> Int {
        let known = Set(items.flatMap { $0.developments.map(\.id) }), editions = Set(days.filter { !$0.edition.isEmpty }.map(\.date))
        return next.items.filter { item in
            !known.contains(item.newest.id) || item.versions.contains { $0.story?.edition.map { !editions.contains($0) } ?? false }
        }.count
    }

    /// The first time a device reads a feed, nothing before today is news to it.
    func baseline(now: Date = .now) -> NewsReadState {
        let start = calendar.startOfDay(for: now)
        return NewsReadState(seen: Set(items.flatMap { $0.developments.filter { ($0.sentAt ?? now) < start }.map(\.id) }))
    }

    private static func moment(_ item: Item, _ version: HomeMessage, _ calendar: Calendar) -> Moment? {
        guard let published = version.sentAt else { return nil }
        let isDevelopment = version.id != item.versions.first?.id
        var time = published, hasClock = true
        // A development is dated by its report; a first report by the event, when the story knows it.
        if !isDevelopment, let event = instant(version.story?.eventAt, calendar), event.date <= published {
            if event.hasClock { time = event.date }
            else if !calendar.isDate(event.date, inSameDayAs: published) { time = event.date; hasClock = false }
        }
        return Moment(item: item, version: version, published: published, time: time, hasClock: hasClock, isDevelopment: isDevelopment)
    }

    /// A story's own time: an instant, or a day alone when that is all the source gave.
    static func instant(_ text: String?, _ calendar: Calendar) -> (date: Date, hasClock: Bool)? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        if let date = (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text)) ?? (try? Date.ISO8601FormatStyle().parse(text)) { return (date, true) }
        return day(text, calendar).map { ($0, false) }
    }

    static func dayKey(_ date: Date, _ calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// Noon of a 2026-11-10 day, so the date reads the same in the calendar's own zone.
    static func day(_ key: String, _ calendar: Calendar) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard key.count == 10, parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }
}

/// What this device's reader has had on screen. Local to the device, kept per Home and conversation.
struct NewsReadState: Codable, Equatable {
    /// When the reader last left the page: «Новое с 11:40».
    var lastVisitAt: Date?
    /// A story's first report and each development, by message id.
    var seen: Set<String> = []

    mutating func see(_ item: NewsDesk.Item) { seen.formUnion(item.developments.map(\.id)) }
}

/// The one line under the date. It always tells the truth about the feed.
enum NewsStatusLine: Equatable {
    case edition(published: Date?, stories: Int, checked: Date?)
    case running
    case failing(since: Date?, reason: String?)
    case paused(since: Date?)
    /// No edition today; `standIn` is the date of the edition shown instead.
    case noEdition(standIn: String?)
    /// An earlier day that had a radar and no edition.
    case noEditionThatDay

    init(status: NewsStatus?, page: NewsDesk.Page, calendar: Calendar = .current) {
        func instant(_ text: String?) -> Date? { NewsDesk.instant(text, calendar)?.date }
        let current = page.editionDate.map { $0 >= page.date } ?? false
        if !page.isToday {
            self = current ? .edition(published: page.published, stories: page.edition.count, checked: nil) : .noEditionThatDay
        } else if status?.running == true {
            self = .running
        } else if let status, status.nextRunAt == nil {
            // The pause began with or after the last run of any kind.
            self = .paused(since: [instant(status.checkedAt), instant(status.failedAt)].compactMap { $0 }.max())
        } else if let status, status.failedAt != nil {
            // The Home names its latest failed run, which moves with every retry. The radar stopped working after the
            // last check that succeeded, so that is the time the line gives when there is one.
            self = .failing(since: instant(status.checkedAt) ?? instant(status.failedAt), reason: status.failure?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty)
        } else if current {
            self = .edition(published: page.published, stories: page.edition.count, checked: instant(status?.checkedAt))
        } else {
            self = .noEdition(standIn: page.editionDate)
        }
    }

    var isRunning: Bool { self == .running }
    var isFailing: Bool { if case .failing = self { true } else { false } }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// News speaks the language of its stories, not of the interface, so Russian stories never sit inside English labels.
struct NewsWords {
    var language: AppLanguage = L10n.shared.language
    var calendar: Calendar = .current

    /// Whether most of the stories are written in Cyrillic; nil when there is none to tell by.
    static func isCyrillic(_ stories: [NewsStory]) -> Bool? {
        stories.isEmpty ? nil : stories.filter { $0.title.range(of: "[А-Яа-яЁё]", options: .regularExpression) != nil }.count * 2 > stories.count
    }
    /// Cyrillic stories read in Russian. Anything else keeps the interface language, or English when that is Russian.
    init(cyrillic: Bool?, interface: AppLanguage = L10n.shared.language, calendar: Calendar = .current) {
        self.calendar = calendar
        language = cyrillic == nil ? interface : cyrillic == true ? .russian : interface == .russian ? .english : interface
    }
    init(stories: [NewsStory], interface: AppLanguage = L10n.shared.language, calendar: Calendar = .current) {
        self.init(cyrillic: Self.isCyrillic(stories), interface: interface, calendar: calendar)
    }
    init(language: AppLanguage = L10n.shared.language, calendar: Calendar = .current) { self.language = language; self.calendar = calendar }

    func callAsFunction(_ message: LocalizedMessage) -> String { L10n.text(message.key, arguments: message.arguments, language: language) }

    private var style: Date.FormatStyle {
        Date.FormatStyle(locale: language.locale, calendar: calendar, timeZone: calendar.timeZone)
    }
    /// 14:35
    func time(_ date: Date) -> String { date.formatted(style.hour().minute()) }
    /// 8 ноября, with the year when it is not this one.
    func day(_ date: Date, now: Date = .now) -> String {
        date.formatted(calendar.isDate(date, equalTo: now, toGranularity: .year) ? style.day().month(.wide) : style.day().month(.wide).year())
    }
    func day(_ key: String, now: Date = .now) -> String { NewsDesk.day(key, calendar).map { day($0, now: now) } ?? key }
    /// 8 нояб.: a row's time column on another day.
    func shortDay(_ date: Date) -> String { date.formatted(style.day().month(.abbreviated)) }
    /// 14:35 today, otherwise 8 ноября, 14:35.
    func moment(_ date: Date, now: Date = .now) -> String {
        calendar.isDate(date, inSameDayAs: now) ? time(date) : day(date, now: now) + ", " + time(date)
    }
    /// ВТОРНИК · 10 НОЯБРЯ
    func masthead(_ key: String, now: Date = .now) -> String {
        guard let date = NewsDesk.day(key, calendar) else { return key }
        return (date.formatted(style.weekday(.wide)) + " · " + day(date, now: now)).uppercased(with: language.locale)
    }
    /// Понедельник, 9 ноября
    func weekday(_ key: String, now: Date = .now) -> String {
        guard let date = NewsDesk.day(key, calendar) else { return key }
        let text = date.formatted(style.weekday(.wide)) + ", " + day(date, now: now)
        return text.prefix(1).uppercased(with: language.locale) + text.dropFirst()
    }
    /// The time column of a compact row: the clock on the page's day, the day itself otherwise.
    func column(_ moment: NewsDesk.Moment, on day: String) -> String {
        moment.hasClock && NewsDesk.dayKey(moment.time, calendar) == day ? time(moment.time) : shortDay(moment.time)
    }

    private var isRussian: Bool { language == .russian }
    /// "3 истории" with the plural the language needs.
    func stories(_ count: Int) -> String {
        let one = isRussian ? count % 10 == 1 && count % 100 != 11 : count == 1
        let few = isRussian && (2...4).contains(count % 10) && !(12...14).contains(count % 100)
        return one ? self("\(count) история") : few ? self("\(count) истории") : self("\(count) историй")
    }
    /// "3 новых"
    func fresh(_ count: Int) -> String {
        isRussian && count % 10 == 1 && count % 100 != 11 || !isRussian && count == 1 ? self("\(count) новая") : self("\(count) новых")
    }
    /// НОВОЕ С 11:40 · 3
    func freshTitle(since: Date?, count: Int, now: Date = .now) -> String {
        guard let since else { return self("Новое · \(count)") }
        return self("Новое с \(calendar.isDate(since, inSameDayAs: now) ? time(since) : day(since, now: now)) · \(count)")
    }
    /// The line over an edition's stories: the name its desk gave it, or «Выпуск»; an edition standing in for today's says whose day it is.
    func editionTitle(_ page: NewsDesk.Page, named: NewsEditionTitle?, now: Date = .now) -> String {
        guard let date = page.editionDate, date != page.date else { return named.flatMap { $0.date == page.date ? $0.title : nil } ?? self("Выпуск") }
        return self("Выпуск за \(day(date, now: now))")
    }
    /// «8 историй», or what an earlier day had instead of an edition.
    func summary(_ day: NewsDesk.Day) -> String {
        if !day.edition.isEmpty { return stories(day.edition.count) }
        return day.radar.isEmpty ? self("выпуска нет") : self("в радаре \(day.radar.count)")
    }

    func status(_ line: NewsStatusLine, name: String, now: Date = .now) -> String {
        switch line {
        case .edition(let published, let stories, let checked):
            return [published.map { self("Выпуск \(time($0))") }, self.stories(stories), checked.map { self("радар \(moment($0, now: now))") }]
                .compactMap { $0 }.joined(separator: " · ")
        case .running: return self("\(name) проверяет источники…")
        case .failing(let since, let reason):
            return (since.map { self("Радар не работает с \(moment($0, now: now))") } ?? self("Радар не работает")) + (reason.map { ": " + $0 } ?? "")
        case .paused(let since): return since.map { self("\(name) на паузе с \(day($0, now: now))") } ?? self("\(name) на паузе")
        case .noEdition(let standIn):
            return standIn.map { self("Сегодняшнего выпуска нет. Ниже выпуск за \(day($0, now: now)).") } ?? self("Сегодняшнего выпуска нет.")
        case .noEditionThatDay: return self("Выпуска в этот день не было.")
        }
    }
}

/// Where the reader is in a feed. It outlives the screen, so leaving to discuss a story and coming back lands in the same place.
struct NewsPlace: Equatable {
    /// An earlier day opened over today.
    var day: String?
    /// The story open over its page.
    var story: String?
    var showsAllFresh = false
    /// Bumped to bring today's page back to its top.
    var top = 0
}

/// One employee's News on one Home: its stories, what the Home says about its runs, and what this device has read.
@MainActor
final class NewsFeed: ObservableObject, Identifiable {
    let client: HomeClient
    let route: ReaderRoute
    private let defaults: UserDefaults
    /// What the page shows. Stories that arrive while it is being read wait in `incoming`.
    @Published private(set) var desk = NewsDesk([])
    @Published private(set) var incoming: NewsDesk?
    @Published private(set) var status: NewsStatus?
    /// The name the desk gave its latest edition, when it gave one.
    @Published private(set) var edition: NewsEditionTitle?
    @Published private(set) var read = NewsReadState()
    /// What had been seen when this visit began. «Новое» is measured against it, so it stays put while it is read.
    @Published private(set) var visit = NewsReadState()
    @Published private(set) var loaded = false
    @Published private(set) var unreachable = false
    /// Counts the times new stories joined the page: the character plops once for each.
    @Published private(set) var landings = 0
    /// The language of the feed's stories, remembered so an empty feed still speaks it.
    @Published private(set) var cyrillic: Bool?
    @Published var place = NewsPlace()
    /// Each page's top row, by the page's date ("" for today), and how far the open story was read. Scrolling
    /// writes these all the time, so they are not published.
    var anchors: [String: String] = [:]
    var storyScroll: (story: String, offset: CGFloat)?
    /// A page of this feed is open in a window: what arrives waits, and the Home is asked more often.
    var isOpen: Bool { screens > 0 }
    /// The reader is there too: the window is the active one.
    private var attended = false
    private(set) var conversationID: String?
    private var messages: [HomeMessage] = []
    private var stamp: String?
    private var askedAt = Date.distantPast
    private var refreshing = false
    private var hasBaseline = false
    private var screens = 0
    private var attentive = true
    private var leftAt: Date?
    private var leaving: Task<Void, Never>?
    /// The reader is leaving for the chat or another place and will come back: the pages go away, the place stays.
    private(set) var holdsPlace = false

    nonisolated var id: String { route.id }

    init(client: HomeClient, route: ReaderRoute, defaults: UserDefaults = .standard) {
        self.client = client
        self.route = route
        self.defaults = defaults
    }

    /// Everything the Home has sent, shown or waiting.
    var latest: NewsDesk { incoming ?? desk }
    var words: NewsWords { NewsWords(cyrillic: cyrillic) }
    var arrivals: Int { incoming.map(desk.arrivals(in:)) ?? 0 }
    /// What the entry point counts.
    var unseen: Int { latest.page(read: read).unseen(read) }
    /// The edition's lead, or the newest report when there is no edition.
    var headline: String? {
        let page = latest.page(read: read)
        return (page.edition.first ?? page.fresh.first?.item ?? page.radar.first?.item)?.story.title
    }

    /// Called every few seconds while the app is in front: an open page asks the Home each time, a closed one
    /// twice a minute, which keeps the entry point's count and lead current.
    func poll() async {
        if isOpen || Date.now.timeIntervalSince(askedAt) >= 30 { await refresh() }
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        askedAt = .now
        defer { refreshing = false }
        do {
            let envelope: ConversationEnvelope = try await client.read(route.path + "?page=true&limit=1" + (route.usesTimeline ? "&timeline=true" : ""))
            if conversationID != envelope.conversation.id { conversationID = envelope.conversation.id; restore() }
            // The stamp moves with every story and with every change in what the Home says about its runs.
            if envelope.conversation.news != stamp || !loaded {
                if envelope.conversation.news == nil { receive([], status: nil) }
                else {
                    let feed: NewsFeedEnvelope = try await client.read("/v1/conversations/" + envelope.conversation.id + "/stories")
                    receive(feed.messages, status: feed.status, edition: feed.edition)
                }
                stamp = envelope.conversation.news
            }
            if unreachable { unreachable = false }
        } catch is CancellationError {
        } catch {
            // What is on screen stays; the status line says the rest is out of reach.
            if !unreachable { unreachable = true }
            if !loaded { loaded = true }
        }
    }

    func receive(_ messages: [HomeMessage], status: NewsStatus?, edition: NewsEditionTitle? = nil, now: Date = .now) {
        if self.status != status { self.status = status }
        if self.edition != edition { self.edition = edition }
        guard messages != self.messages || !loaded else { return }
        defer { if !loaded { loaded = true } }
        self.messages = messages
        let next = NewsDesk(messages)
        if let told = NewsWords.isCyrillic(next.items.map(\.story)), told != cyrillic {
            cyrillic = told
            if let key { defaults.set(told, forKey: key + ".cyrillic") }
        }
        if !hasBaseline, !next.items.isEmpty {
            read = next.baseline(now: now); visit = read; hasBaseline = true
            save(next)
        }
        // New stories wait for the reader instead of moving what is being read; curation and copy edits do not,
        // and an empty page has nothing to protect.
        let arrived = loaded && desk.arrivals(in: next) > 0
        if isOpen, arrived, !desk.items.isEmpty { incoming = next } else { desk = next; incoming = nil; if arrived { landings += 1 } }
    }

    /// The reader asked for what arrived: it joins the page, and the visit starts over so «Новое» shows just that.
    func showIncoming() {
        if let incoming { desk = incoming; self.incoming = nil; landings += 1 }
        if visit != read { visit = read }
    }

    /// A page of this feed came on screen, or left it. A push inside the feed is not a departure.
    func appear(now: Date = .now) {
        if let leaving {
            // The last page left a moment ago and this one took its place: the same visit.
            leaving.cancel(); self.leaving = nil
        } else {
            screens += 1
            if screens == 1 {
                // Opened anew, the page shows everything the Home has sent and starts a visit.
                holdsPlace = false
                showIncoming()
                Task { await refresh() }
            }
        }
        settle(now: now)
    }
    /// Called before the app takes the reader elsewhere. Navigation closes its pages then, and that must not read
    /// as the reader closing the story.
    func hold() { holdsPlace = true }
    /// The reader closed the open story, or the earlier day.
    func closeStory() { if !holdsPlace { place.story = nil } }
    func closeDay() { if !holdsPlace { place.day = nil } }
    func disappear() {
        guard screens > 0 else { return }
        if screens > 1 { screens -= 1; return }
        // The last page waits a moment: one page replacing another is not leaving.
        leaving = Task { [weak self] in
            try? await Task.sleep(for: .seconds(0.6))
            guard !Task.isCancelled, let self else { return }
            self.leaving = nil
            self.screens = 0
            self.settle(now: .now)
        }
    }
    /// The window went behind another app, or came back.
    func attend(_ active: Bool, now: Date = .now) {
        attentive = active
        settle(now: now)
    }

    private func settle(now: Date) {
        let next = screens > 0 && attentive
        guard next != attended else { return }
        attended = next
        if next {
            // Back within ten minutes of looking away, the page is as it was left; later, it starts over.
            if let leftAt, now.timeIntervalSince(leftAt) >= 600 { showIncoming() }
        } else {
            leftAt = now
            read.lastVisitAt = now
            save(latest)
        }
    }

    /// The stories whose rows rested on screen, or the one that was opened.
    func see(_ ids: Set<String>) {
        var next = read
        for item in desk.items where ids.contains(item.id) { next.see(item) }
        guard next != read else { return }
        read = next
        save(latest)
    }

    private var key: String? { conversationID.map { "openstrudel.news.read." + client.catalogueIdentity + ":" + $0 } }

    private func restore() {
        cyrillic = key.flatMap { defaults.object(forKey: $0 + ".cyrillic") as? Bool }
        guard let key, let data = defaults.data(forKey: key), let saved = try? JSONDecoder().decode(NewsReadState.self, from: data) else { hasBaseline = false; return }
        read = saved; visit = saved; hasBaseline = true
    }

    private func save(_ desk: NewsDesk) {
        guard let key else { return }
        // Stories leave the feed after two weeks, and what was seen of them goes with them.
        let known = Set(desk.items.flatMap { $0.versions.map(\.id) })
        if !known.isEmpty { read.seen.formIntersection(known) }
        defaults.set(try? JSONEncoder().encode(read), forKey: key)
    }
}

/// The feeds the app has open or counts in its sidebar, one per employee and Home.
@MainActor
final class Newsroom: ObservableObject {
    private var feeds: [String: NewsFeed] = [:]
    private var changes: [String: AnyCancellable] = [:]

    func feed(_ route: ReaderRoute, on client: HomeClient) -> NewsFeed {
        if let feed = feeds[route.id], feed.client === client { return feed }
        let feed = NewsFeed(client: client, route: route)
        feeds[route.id] = feed
        // The home's shelf shows every desk's lead, so a feed that changes tells whoever watches the newsroom.
        changes[route.id] = feed.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        return feed
    }

    /// The reader is being taken to the chat or to another place: every feed keeps where they were.
    func hold() { feeds.values.forEach { $0.hold() } }
}
