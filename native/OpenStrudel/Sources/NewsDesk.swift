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

        /// How loudly the desk sent the story out: 2 for what the reader must know now, 1 for a card, 0 for the app alone.
        var weight: Int { versions.reduce(0) { max($0, $1.story?.telegram == "alert" ? 2 : $1.story?.telegram == "card" ? 1 : 0) } }
        /// «Разбор»: the point the headlines missed, published as a story of its own.
        var isAnalysis: Bool { ["разбор", "analysis"].contains(story.status.lowercased()) }
        /// The names the story is about, as its desk gave them.
        var topics: [String] { story.topics ?? [] }

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

    // MARK: The front page

    /// A day's paper: one lead, what came since the reader last looked, the top stories, the day's analysis and the
    /// rest under their sections. Every story stands in one place.
    struct Front {
        struct Section: Identifiable { let name: String; var items: [Item]; var id: String { name } }
        /// The day whose stories these are.
        let date: String
        /// The reader asked for today.
        let isToday: Bool
        /// Today has no story yet, and the latest day's paper stands in.
        var standsIn = false
        var lead: Item?
        /// «Новое с 14:05»: what was reported after the reader last left today's paper. Today only.
        var fresh: [Moment] = []
        var top: [Item] = []
        var analysis: [Item] = []
        var sections: [Section] = []
        /// The day's stories in their order of importance, the lead first.
        var stories: [Item] = []
        /// When the day's edition came out; nil when there was none.
        var published: Date?
        /// The other days, newest first.
        var earlier: [Day] = []

        var isEmpty: Bool { stories.isEmpty && earlier.isEmpty }
        /// Every story of the page once, as it reads from top to bottom: the way next and previous move.
        var order: [String] {
            var seen = Set<String>()
            return ((lead.map { [$0.id] } ?? []) + fresh.map(\.id) + top.map(\.id) + analysis.map(\.id) + sections.flatMap { $0.items.map(\.id) }).filter { seen.insert($0).inserted }
        }
        /// «Новое с 11:40»: the moment the reader last left the paper, when that was today.
        func freshSince(_ read: NewsReadState, calendar: Calendar = .current) -> Date? {
            read.lastVisitAt.flatMap { last in NewsDesk.dayKey(last, calendar) == date ? last : nil }
        }
        /// What the entry point counts: the day's stories the reader has not had on screen.
        func unseen(_ read: NewsReadState) -> Int { stories.filter { $0.isUnseen(read) }.count }
    }

    /// A day's stories in their order of importance: what the reader must know now, then the edition as its desk
    /// ranked it, then the cards and the rest of the radar, the newest first among equals.
    func paper(_ day: Day) -> [Item] {
        let inEdition = Set(day.edition.map(\.id))
        let radar = day.radar.filter { !inEdition.contains($0.id) }
            .sorted { $0.item.weight == $1.item.weight ? $0.published > $1.published : $0.item.weight > $1.item.weight }.map(\.item)
        return radar.filter { $0.weight == 2 } + day.edition + radar.filter { $0.weight < 2 }
    }

    /// Today's front page, or the paper of an earlier day.
    func front(_ date: String? = nil, now: Date = .now, read: NewsReadState = NewsReadState()) -> Front {
        let today = Self.dayKey(now, calendar)
        // Before anything comes out today, the latest day's paper stands in.
        let day = date.map { wanted in days.first { $0.date == wanted } } ?? days.first
        var front = Front(date: day?.date ?? date ?? today, isToday: date == nil || date == today)
        front.earlier = days.filter { $0.date != front.date && $0.date <= today }
        guard let day else { return front }
        front.standsIn = front.isToday && day.date < today
        front.published = day.edition.isEmpty ? nil : day.published
        let stories = paper(day)
        front.stories = stories
        front.lead = stories.first
        var placed = Set(front.lead.map { [$0.id] } ?? [])
        if front.isToday, !front.standsIn, let last = front.freshSince(read, calendar: calendar) {
            front.fresh = stories.compactMap { item in
                guard !placed.contains(item.id), item.isUnseen(read), let moment = Self.moment(item, item.newest, calendar), moment.published > last else { return nil }
                return moment
            }.sorted { $0.published > $1.published }
            placed.formUnion(front.fresh.map(\.id))
        }
        front.analysis = stories.filter { $0.isAnalysis && !placed.contains($0.id) }
        placed.formUnion(front.analysis.map(\.id))
        front.top = Array(stories.filter { !placed.contains($0.id) }.prefix(4))
        placed.formUnion(front.top.map(\.id))
        // The sections stand in the order of their best story.
        for item in stories where !placed.contains(item.id) {
            let name = item.story.section.trimmingCharacters(in: .whitespacesAndNewlines)
            if let index = front.sections.firstIndex(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) { front.sections[index].items.append(item) }
            else { front.sections.append(Front.Section(name: name, items: [item])) }
        }
        return front
    }

    /// What a row says about when: the story's latest report on a day, or its newest event.
    func moment(_ item: Item) -> Moment? { Self.moment(item, item.newest, calendar) }

    /// Other stories about the same names, the newest first: the earlier chapters of a storyline.
    func related(to item: Item, limit: Int = 5) -> [Item] {
        let names = Set(item.topics.map { $0.lowercased() })
        guard !names.isEmpty else { return [] }
        return items.filter { other in other.id != item.id && other.topics.contains { names.contains($0.lowercased()) } }
            .sorted { ($0.newest.sentAt ?? .distantPast) > ($1.newest.sentAt ?? .distantPast) }.prefix(limit).map { $0 }
    }

    /// The stories that say the words, the newest first. Every word must be somewhere in the story.
    func search(_ query: String) -> [Item] {
        let words = query.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        guard !words.isEmpty else { return [] }
        return items.filter { item in
            let story = item.story
            let text = ([story.title, story.summary, story.body, story.view ?? "", story.section, story.status] + item.topics + story.sources.map(\.title)).joined(separator: "\n").lowercased()
            return words.allSatisfy { text.contains($0) }
        }.sorted { ($0.newest.sentAt ?? .distantPast) > ($1.newest.sentAt ?? .distantPast) }
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

extension NewsStory {
    /// The story's first paragraph: what a front page has room for.
    var opening: String { summary.components(separatedBy: "\n\n").first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? summary }
}

/// What this device's reader has had on screen. Local to the device, kept per Home and conversation.
struct NewsReadState: Codable, Equatable {
    /// When the reader last left the page: «Новое с 11:40».
    var lastVisitAt: Date?
    /// A story's first report and each development, by message id.
    var seen: Set<String> = []
    /// The stories the reader opened, by story id, with when. Absent in a state saved by an earlier version.
    var opened: [String: Date]?
    /// The days the paper was read on, as 2026-11-10: the reader's run of days.
    var days: Set<String>?

    mutating func see(_ item: NewsDesk.Item) { seen.formUnion(item.developments.map(\.id)) }

    /// How many days in a row the paper was read, ending today or yesterday.
    func streak(now: Date = .now, calendar: Calendar = .current) -> Int {
        guard let days, !days.isEmpty else { return 0 }
        var day = calendar.startOfDay(for: now), count = 0
        if !days.contains(NewsDesk.dayKey(day, calendar)) { day = calendar.date(byAdding: .day, value: -1, to: day) ?? day }
        while days.contains(NewsDesk.dayKey(day, calendar)) {
            count += 1
            day = calendar.date(byAdding: .day, value: -1, to: day) ?? day.addingTimeInterval(-86_400)
        }
        return count
    }
}

/// What moved in a desk's stories over seven days, against the seven before: where the stories were, whom they were
/// about, which ones kept developing, and what the reader made of them.
struct NewsWeek {
    struct Count: Identifiable {
        let name: String
        let count: Int
        /// The seven days before; nil when the feed does not reach that far back.
        let before: Int?
        /// The newest story under the name.
        let latest: NewsDesk.Item
        var id: String { name.lowercased() }
        /// More, fewer or as many as the week before; nil when that is not known.
        var direction: Int? { before.map { count == $0 ? 0 : count > $0 ? 1 : -1 } }
    }
    struct Storyline: Identifiable {
        let item: NewsDesk.Item
        /// How many times it moved this week, its first report included when that was this week.
        let events: Int
        let latest: Date
        var id: String { item.id }
    }

    /// The week's stories, the newest first.
    var stories: [NewsDesk.Item] = []
    /// Nil when the feed does not reach the week before.
    var storiesBefore: Int?
    var sections: [Count] = []
    var topics: [Count] = []
    var storylines: [Storyline] = []
    /// Of the week's stories: on screen long enough to count, and opened.
    var seen = 0
    var opened = 0
    var mustKnow: Int { stories.filter { $0.weight == 2 }.count }

    init(_ desk: NewsDesk, read: NewsReadState = NewsReadState(), now: Date = .now) {
        let calendar = desk.calendar
        let start = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now)) ?? now
        let earlier = calendar.date(byAdding: .day, value: -7, to: start) ?? start
        func first(_ item: NewsDesk.Item) -> Date { item.versions.first?.sentAt ?? .distantPast }
        let week = desk.items.filter { first($0) >= start }, before = desk.items.filter { first($0) >= earlier && first($0) < start }
        // The week before is known only when the feed holds a story from before it began.
        let reaches = desk.items.contains { first($0) < start }
        stories = week.sorted { first($0) > first($1) }
        storiesBefore = reaches ? before.count : nil
        func counts(_ names: (NewsDesk.Item) -> [String]) -> [Count] {
            var now: [String: (name: String, items: [NewsDesk.Item])] = [:], then: [String: Int] = [:]
            // Oldest first, so a name keeps the spelling it was first given and its last story is its newest.
            for item in stories.reversed() { for name in Set(names(item).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }) where !name.isEmpty {
                now[name.lowercased(), default: (name, [])].items.append(item)
            } }
            for item in before { for name in Set(names(item).map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }) { then[name, default: 0] += 1 } }
            return now.map { key, value in Count(name: value.name, count: value.items.count, before: reaches ? then[key] ?? 0 : nil, latest: value.items[value.items.count - 1]) }
                .sorted { $0.count == $1.count ? $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending : $0.count > $1.count }
        }
        sections = counts { [$0.story.section] }
        topics = counts(\.topics)
        storylines = desk.items.compactMap { item in
            let moved = item.developments.compactMap(\.sentAt).filter { $0 >= start }
            guard item.developments.count > 1, let latest = moved.max() else { return nil }
            return Storyline(item: item, events: moved.count, latest: latest)
        }.sorted { $0.latest > $1.latest }
        seen = stories.filter { !$0.isUnseen(read) }.count
        opened = stories.filter { read.opened?[$0.id] != nil }.count
    }
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

    /// The same line over a day's front page: the day's stories count whether or not an edition carried them.
    init(status: NewsStatus?, front: NewsDesk.Front, calendar: Calendar = .current) {
        func instant(_ text: String?) -> Date? { NewsDesk.instant(text, calendar)?.date }
        if !front.isToday {
            self = front.stories.isEmpty ? .noEditionThatDay : .edition(published: front.published, stories: front.stories.count, checked: nil)
        } else if status?.running == true {
            self = .running
        } else if let status, status.nextRunAt == nil {
            self = .paused(since: [instant(status.checkedAt), instant(status.failedAt)].compactMap { $0 }.max())
        } else if let status, status.failedAt != nil {
            self = .failing(since: instant(status.checkedAt) ?? instant(status.failedAt), reason: status.failure?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty)
        } else if front.standsIn || front.stories.isEmpty {
            self = .noEdition(standIn: front.standsIn ? front.date : nil)
        } else {
            self = .edition(published: front.published, stories: front.stories.count, checked: instant(status?.checkedAt))
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
    /// «Вчера», otherwise «Пн, 9 ноября»: an earlier day's paper on the shelf of issues.
    func issue(_ key: String, now: Date = .now) -> String {
        guard let date = NewsDesk.day(key, calendar) else { return key }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return self("Вчера") }
        let text = date.formatted(style.weekday(.abbreviated)) + ", " + date.formatted(style.day().month(.wide))
        return text.prefix(1).uppercased(with: language.locale) + text.dropFirst()
    }
    /// «+6», «−2» or «=»: a week's count against the week before.
    func change(_ count: Int, from before: Int) -> String {
        count == before ? "=" : (count > before ? "+" : "−") + abs(count - before).formatted()
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
    /// "3 события": how many times a story moved.
    func events(_ count: Int) -> String {
        let one = isRussian ? count % 10 == 1 && count % 100 != 11 : count == 1
        let few = isRussian && (2...4).contains(count % 10) && !(12...14).contains(count % 100)
        return one ? self("\(count) событие") : few ? self("\(count) события") : self("\(count) событий")
    }
    /// «Telegram» or «LinkedIn»: where a draft is meant for.
    func channel(_ name: String) -> String { name == "linkedin" ? "LinkedIn" : "Telegram" }
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
    /// The line over a day's lead when its desk made an edition: the name the desk gave it, or «Выпуск»; a paper
    /// standing in for today's says whose day it is.
    func paperTitle(_ front: NewsDesk.Front, named: NewsEditionTitle?, now: Date = .now) -> String {
        front.standsIn ? self("Выпуск за \(day(front.date, now: now))") : named.flatMap { $0.date == front.date ? $0.title : nil } ?? self("Выпуск")
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
    /// A page behind the front page: the week, the post drafts or the search.
    var panel: NewsPanel?
}

enum NewsPanel: String, Hashable, Identifiable {
    case week, posts, search
    var id: String { rawValue }
}

/// What the post sheet opens with: stories to write a new draft from, or a draft already written.
struct NewsPostRequest: Identifiable {
    let id = UUID()
    var stories: [String]
    var post: String? = nil
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
    /// Where the home stands beside the open place, the reader chose another place. The desk's pages read this and
    /// close for real: a page left pushed would stay over the place chosen. What was open is kept in `place`.
    @Published private(set) var isAway = false

    nonisolated var id: String { route.id }

    /// The desk's post drafts, kept on its Home.
    let posts = NewsPostShelf()
    /// Where the last answer of the Home is kept, so the paper opens at once and reads without a connection.
    private let cache: URL?
    /// The Home has answered since the app started; until then it is asked every few seconds.
    private var answered = false

    init(client: HomeClient, route: ReaderRoute, defaults: UserDefaults = .standard, cache: URL? = nil) {
        self.client = client
        self.route = route
        self.defaults = defaults
        self.cache = cache.map { $0.appending(path: Self.fileName(client.catalogueIdentity + ":" + route.id) + ".json") }
        posts.feed = self
        open()
    }

    /// Everything the Home has sent, shown or waiting.
    var latest: NewsDesk { incoming ?? desk }
    var words: NewsWords { NewsWords(cyrillic: cyrillic) }
    var arrivals: Int { incoming.map(desk.arrivals(in:)) ?? 0 }
    /// What the entry point counts.
    var unseen: Int { latest.front(read: read).unseen(read) }
    /// The paper's lead: what the entry point shows.
    var lead: NewsDesk.Item? { latest.front(read: read).lead }
    var headline: String? { lead?.story.title }

    /// Called every few seconds while the app is in front: an open page asks the Home each time, a closed one
    /// twice a minute, which keeps the entry point's count and lead current. Until the Home's first answer it is
    /// asked every time, so a Home that connects a moment after the app starts is not left waiting.
    func poll() async {
        if isOpen || !answered || Date.now.timeIntervalSince(askedAt) >= 30 { await refresh() }
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
                    let data = try await client.readData("/v1/conversations/" + envelope.conversation.id + "/stories")
                    let feed = try JSONDecoder().decode(NewsFeedEnvelope.self, from: data)
                    receive(feed.messages, status: feed.status, edition: feed.edition)
                    keep(data, conversation: envelope.conversation.id)
                }
                stamp = envelope.conversation.news
            }
            answered = true
            if unreachable { unreachable = false }
        } catch is CancellationError {
        } catch {
            // What is on screen stays; the status line says the rest is out of reach. A Home that is still
            // connecting is not out of reach yet.
            let connecting = !answered && client.health == nil && !client.homeUnreachable && !client.connectionNeedsPairing
            if !unreachable, !connecting { unreachable = true }
            if !loaded, !connecting { loaded = true }
        }
    }

    // MARK: The saved copy

    /// The app's own folder for the copies. On a Mac the caches folder is shared by every app of the person, so the
    /// copies go under this app's name there; on a phone the caches folder is already the app's alone.
    static var cacheDirectory: URL? {
        guard var folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        #if os(macOS)
        folder.append(path: Bundle.main.bundleIdentifier ?? "is.openstrudel.mac", directoryHint: .isDirectory)
        #endif
        return folder.appending(path: "News", directoryHint: .isDirectory)
    }

    private static func fileName(_ key: String) -> String {
        // A stable name without the Home's address in it.
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 1_099_511_628_211 }
        return String(hash, radix: 16)
    }

    private struct Saved: Decodable { let conversation: String; let feed: NewsFeedEnvelope }

    /// The paper as it was last read from the Home: on screen before the Home answers, and when it does not.
    private func open() {
        guard let cache, let data = try? Data(contentsOf: cache), let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return }
        conversationID = saved.conversation
        restore()
        // What the Home said about its runs then is not true now; the stories are.
        receive(saved.feed.messages, status: nil, edition: saved.feed.edition)
    }

    private func keep(_ feed: Data, conversation: String) {
        guard let cache, let name = try? JSONEncoder().encode(conversation) else { return }
        var data = Data(#"{"conversation":"#.utf8)
        data.append(name); data.append(Data(#","feed":"#.utf8)); data.append(feed); data.append(Data("}".utf8))
        try? FileManager.default.createDirectory(at: cache.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: cache, options: .atomic)
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
                isAway = false
                showIncoming()
                Task { await refresh() }
            }
        }
        settle(now: now)
    }
    /// Called before the app takes the reader elsewhere. Navigation closes its pages then, and that must not read
    /// as the reader closing the story.
    func hold() { holdsPlace = true }
    /// The reader chose another place beside this desk: its pages close, and where the reader was is kept.
    func leave() { holdsPlace = true; isAway = true }
    /// Pages on screen over the desk's paper right now: a story, an earlier issue, the week, the drafts, the search.
    /// Each says when it comes and when it goes, so the app knows when the last of them has really closed.
    @Published private(set) var pagesOver = 0
    func cover() { pagesOver += 1 }
    func uncover() { pagesOver = max(0, pagesOver - 1) }
    /// The reader opened the desk again: its pages open where they were, and closing one is the reader's own doing.
    func arrive() { holdsPlace = false; isAway = false }
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
            // The day counts as read once its paper has been looked at.
            let day = NewsDesk.dayKey(now, desk.calendar)
            if !desk.items.isEmpty, read.days?.contains(day) != true { read.days = (read.days ?? []).union([day]); save(latest) }
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

    /// The reader opened the story's own page.
    func open(_ story: String, now: Date = .now) {
        guard let item = desk.item(story) else { return }
        var next = read
        next.see(item)
        if next.opened?[story] == nil { next.opened = (next.opened ?? [:]).merging([story: now]) { first, _ in first } }
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
        if !known.isEmpty {
            read.seen.formIntersection(known)
            let stories = Set(desk.items.map(\.id))
            read.opened = read.opened?.filter { stories.contains($0.key) }
            // Two months of days are enough to count a run of them.
            if let days = read.days, days.count > 60 { read.days = Set(days.sorted().suffix(60)) }
        }
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
        let feed = NewsFeed(client: client, route: route, cache: NewsFeed.cacheDirectory)
        feeds[route.id] = feed
        // The home's shelf shows every desk's lead, so a feed that changes tells whoever watches the newsroom.
        changes[route.id] = feed.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        return feed
    }

    /// The reader is being taken to the chat or to another place: every feed keeps where they were.
    func hold() { feeds.values.forEach { $0.hold() } }
    /// The home stands beside the open place and the reader chose another one: the pages of the desks on screen close.
    func leave() { feeds.values.filter(\.isOpen).forEach { $0.leave() } }
    /// A desk the reader has left still has a page on screen over its paper. The Mac takes a moment to close one, and
    /// a place shown before it has closed gets that page left standing over it.
    var pagesClosing: Bool { feeds.values.contains { $0.isAway && $0.pagesOver > 0 } }
    /// The reader opened a desk: it shows what they had open in it.
    func arrive(_ route: ReaderRoute) { feeds[route.id]?.arrive() }
}

/// One desk's post drafts. The Home writes them and keeps them; the app asks, edits and copies.
@MainActor
final class NewsPostShelf: ObservableObject {
    @Published private(set) var posts: [NewsPost] = []
    @Published private(set) var loaded = false
    /// Why drafts cannot be asked for here: an older Home, or a device that is not the owner's.
    @Published private(set) var refusal: String?
    fileprivate(set) weak var feed: NewsFeed?
    private var watching: Task<Void, Never>?

    private var path: String? { feed?.conversationID.map { "/v1/conversations/" + $0 + "/posts" } }

    func post(_ id: String?) -> NewsPost? { posts.first { $0.id == id } }
    /// The newest draft made from exactly these stories for the channel.
    func post(for stories: [String], channel: String) -> NewsPost? {
        posts.first { $0.channel == channel && Set($0.storyIds) == Set(stories) }
    }

    func load() async {
        guard let path, let client = feed?.client else { return }
        do {
            let answer: NewsPostsEnvelope = try await client.read(path)
            receive(answer.posts)
            refusal = nil
        } catch is CancellationError {
        } catch {
            // Drafts already on screen stay; a first read that fails says why nothing can be asked.
            if !loaded { refusal = error.localizedDescription }
        }
        loaded = true
    }

    /// Asks the desk for a draft from the stories; `from` is the draft a version for another channel starts from.
    @discardableResult func write(_ stories: [String], channel: String, from: NewsPost? = nil) async throws -> NewsPost {
        try await ask(["storyIds": stories, "channel": channel].merging(from.map { ["from": $0.id] } ?? [:]) { first, _ in first })
    }

    /// Asks for the draft again as the owner has it now, changed the way the words say.
    @discardableResult func revise(_ post: NewsPost, text: String, instruction: String) async throws -> NewsPost {
        try await ask(["id": post.id, "storyIds": post.storyIds, "channel": post.channel, "text": text, "instruction": instruction])
    }

    /// The owner's own edit.
    func save(_ post: NewsPost, text: String) async {
        guard text != post.text else { return }
        await change(post, ["text": text])
    }

    /// The owner copied or shared the draft: "copied" or "shared".
    func used(_ post: NewsPost, _ how: String) async { await change(post, ["used": how]) }

    func delete(_ post: NewsPost) async {
        guard let path, let client = feed?.client else { return }
        posts.removeAll { $0.id == post.id }
        let _: [String: Bool]? = try? await client.send(path + "/" + post.id, method: "DELETE")
    }

    private func ask(_ body: [String: Any]) async throws -> NewsPost {
        guard let path, let client = feed?.client else { throw CancellationError() }
        let answer: NewsPostEnvelope = try await client.send(path, json: body)
        receive([answer.post] + posts.filter { $0.id != answer.post.id })
        return answer.post
    }

    private func change(_ post: NewsPost, _ body: [String: Any]) async {
        guard let path, let client = feed?.client else { return }
        guard let answer: NewsPostEnvelope = try? await client.send(path + "/" + post.id, method: "PATCH", json: body) else { return }
        receive(posts.map { $0.id == post.id ? answer.post : $0 })
    }

    private func receive(_ next: [NewsPost]) {
        if next != posts { posts = next }
        // While the desk is writing, the Home is asked every two seconds; otherwise only when a page asks.
        if posts.contains(where: \.isWriting) {
            if watching == nil {
                watching = Task { [weak self] in
                    while !Task.isCancelled, self?.posts.contains(where: \.isWriting) == true {
                        try? await Task.sleep(for: .seconds(2))
                        await self?.load()
                    }
                    self?.watching = nil
                }
            }
        } else { watching?.cancel(); watching = nil }
    }
}
