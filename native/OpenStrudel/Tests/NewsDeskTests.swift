import Foundation
import Testing

/// The News reader's arithmetic: days and their editions, the radar's order, what is new to this reader,
/// the one status line, and stories that wait while a page is being read. Every story here is invented.
@Suite(.serialized)
@MainActor struct NewsDeskTests {
    private static let moscow: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Moscow")!
        return calendar
    }()
    /// Tuesday 10 November 2026, 14:50 in Moscow.
    private static let now = instant("2026-11-10T11:50:00.000Z")

    private static func instant(_ text: String) -> Date { try! Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) }

    private func version(_ id: String, story: String = "story", at created: String = "2026-11-01T06:00:00.000Z", edition: String? = nil, rank: Int? = nil,
                         change: String? = nil, eventAt: String? = nil, title: String = "Новый агент") -> HomeMessage {
        HomeMessage(id: id, conversationId: "news", channel: "api", direction: "outbound", replyToId: nil,
                    text: "Story", externalId: nil, createdAt: created, status: "completed", error: nil, kind: "text",
                    story: NewsStory(id: story, edition: edition, rank: rank ?? (edition == nil ? nil : 1), section: "Агенты", status: "Прототип",
                                     title: title, summary: "Суть", body: "Факты", view: nil, check: nil, verification: "Прочитан источник",
                                     eventAt: eventAt, change: change, sources: []))
    }
    private func desk(_ messages: [HomeMessage]) -> NewsDesk { NewsDesk(messages, calendar: Self.moscow) }

    // MARK: Versions

    @Test func anEditionAndCopyEditAreNotNewDevelopments() throws {
        let desk = desk([version("first"), version("edition", edition: "2026-11-01"), version("copy", edition: "2026-11-01")])
        let item = try #require(desk.item("story"))
        #expect(item.developments.map(\.id) == ["first"])
        #expect(item.latest.id == "copy")
        #expect(item.newest.id == "first")
        #expect(item.versions.count == 3)
        let day = try #require(desk.days.first)
        #expect(day.date == "2026-11-01")
        #expect(day.edition.map(\.id) == ["story"])
        #expect(day.radar.map(\.id) == ["story"])
    }

    @Test func aRealUpdateRemainsAfterCuration() throws {
        let desk = desk([version("first"), version("update", change: "Опубликованы веса."), version("edition", edition: "2026-11-01")])
        let item = try #require(desk.item("story"))
        #expect(item.developments.map(\.id) == ["first", "update"])
        #expect(item.newest.id == "update")
        #expect(item.latest.id == "edition")
    }

    // MARK: Days

    @Test func editionsAreGroupedByTheirDateAndKeepTheirOrder() throws {
        let desk = desk([
            version("a9", story: "kettle", at: "2026-11-09T04:04:00.000Z", edition: "2026-11-09", rank: 1),
            version("b9", story: "lantern", at: "2026-11-09T04:04:01.000Z", edition: "2026-11-09", rank: 2),
            // Tuesday's edition is curated twice: the second pass puts the kettle first.
            version("c10", story: "compass", at: "2026-11-10T04:04:00.000Z", edition: "2026-11-10", rank: 1),
            version("a10", story: "kettle", at: "2026-11-10T04:04:01.000Z", edition: "2026-11-10", rank: 2),
            version("a10b", story: "kettle", at: "2026-11-10T04:10:00.000Z", edition: "2026-11-10", rank: 1),
            version("c10b", story: "compass", at: "2026-11-10T04:10:01.000Z", edition: "2026-11-10", rank: 2),
        ])
        #expect(desk.days.map(\.date) == ["2026-11-10", "2026-11-09"])
        #expect(desk.days[0].edition.map(\.id) == ["kettle", "compass"])
        #expect(desk.days[1].edition.map(\.id) == ["kettle", "lantern"])
        #expect(desk.days[0].published == Self.instant("2026-11-10T04:04:00.000Z"))

        let today = desk.page(now: Self.now)
        #expect(today.isToday && today.date == "2026-11-10" && today.editionDate == "2026-11-10")
        #expect(today.edition.map(\.id) == ["kettle", "compass"])
        #expect(today.earlier.map(\.date) == ["2026-11-09"])
        #expect(today.order == ["kettle", "compass"])

        let monday = desk.page("2026-11-09", now: Self.now)
        #expect(!monday.isToday && monday.editionDate == "2026-11-09")
        #expect(monday.edition.map(\.id) == ["kettle", "lantern"])
        #expect(monday.fresh.isEmpty && monday.earlier.isEmpty)
        #expect(NewsStatusLine(status: NewsStatus(running: true), page: monday, calendar: Self.moscow)
                == .edition(published: Self.instant("2026-11-09T04:04:00.000Z"), stories: 2, checked: nil))
        let words = NewsWords(language: .russian, calendar: Self.moscow)
        #expect(words.summary(desk.days[1]) == "2 истории")
        #expect(words.weekday("2026-11-09", now: Self.now) == "Понедельник, 9 ноября")
    }

    @Test func withoutTodaysEditionTheLatestOneStandsInAndTheLineSaysSo() throws {
        let desk = desk([
            version("a8", story: "kettle", at: "2026-11-08T04:04:00.000Z", edition: "2026-11-08", rank: 1),
            version("r9", story: "lantern", at: "2026-11-09T09:00:00.000Z"),
        ])
        let today = desk.page(now: Self.now)
        #expect(today.edition.map(\.id) == ["kettle"] && today.editionDate == "2026-11-08")
        #expect(today.earlier.map(\.date) == ["2026-11-09", "2026-11-08"])
        let line = NewsStatusLine(status: NewsStatus(checkedAt: "2026-11-10T11:35:00.000Z", nextRunAt: "2026-11-10T11:50:00.000Z"), page: today, calendar: Self.moscow)
        #expect(line == .noEdition(standIn: "2026-11-08"))
        let words = NewsWords(language: .russian, calendar: Self.moscow)
        #expect(words.status(line, name: "News", now: Self.now) == "Сегодняшнего выпуска нет. Ниже выпуск за 8 ноября.")
        #expect(words.summary(desk.days[0]) == "в радаре 1")
        // A day that had a radar and no edition says so on its own page.
        let monday = desk.page("2026-11-09", now: Self.now)
        #expect(monday.edition.isEmpty && monday.radar.map(\.id) == ["lantern"])
        #expect(words.status(NewsStatusLine(status: nil, page: monday, calendar: Self.moscow), name: "News", now: Self.now) == "Выпуска в этот день не было.")
    }

    // MARK: Radar

    @Test func theRadarOrdersByEventTimeAndFallsBackToPublication() throws {
        let desk = desk([
            // Reported at 09:10, happened at 08:30.
            version("x", story: "x-harbour", at: "2026-11-10T06:10:00.000Z", eventAt: "2026-11-10T08:30:00+03:00"),
            // No event time: the report's own.
            version("y", story: "y-orchard", at: "2026-11-10T07:05:00.000Z"),
            // Only the day is known, and it is an earlier one.
            version("z", story: "z-quarry", at: "2026-11-10T09:00:00.000Z", eventAt: "2026-11-08"),
            // An announcement of something still to come is dated by its report.
            version("v", story: "v-meadow", at: "2026-11-10T08:00:00.000Z", eventAt: "2026-12-01T09:00:00.000Z"),
            // Reported on Sunday; developed today. The development is dated by its own report, not by the old event.
            version("w1", story: "w-bridge", at: "2026-11-08T10:00:00.000Z", eventAt: "2026-11-08T09:00:00.000Z"),
            version("w2", story: "w-bridge", at: "2026-11-10T10:00:00.000Z", change: "Мост открыли.", eventAt: "2026-11-08T09:00:00.000Z"),
            // A copy edit after that moves nothing.
            version("w3", story: "w-bridge", at: "2026-11-10T11:00:00.000Z", eventAt: "2026-11-08T09:00:00.000Z"),
        ])
        let today = desk.page(now: Self.now, read: NewsReadState(seen: ["x", "y", "z", "v", "w1", "w2"]))
        #expect(today.radar.map(\.id) == ["w-bridge", "v-meadow", "y-orchard", "x-harbour", "z-quarry"])
        #expect(today.radar.map(\.isDevelopment) == [true, false, false, false, false])
        let words = NewsWords(language: .russian, calendar: Self.moscow)
        #expect(today.radar.map { words.column($0, on: today.date) } == ["13:00", "11:00", "10:05", "08:30", "8 нояб."])
        // Sunday keeps the bridge's first report.
        let sunday = desk.page("2026-11-08", now: Self.now)
        #expect(sunday.radar.map(\.id) == ["w-bridge"] && sunday.radar[0].isDevelopment == false)
        #expect(words.column(sunday.radar[0], on: sunday.date) == "12:00")
    }

    @Test func theRadarDoesNotRepeatWhatTheEditionCarries() throws {
        let desk = desk([
            version("e1", story: "e-lighthouse", at: "2026-11-10T00:10:00.000Z"),
            version("e2", story: "e-lighthouse", at: "2026-11-10T04:04:00.000Z", edition: "2026-11-10", rank: 1),
            version("f1", story: "f-windmill", at: "2026-11-10T00:20:00.000Z"),
            version("f2", story: "f-windmill", at: "2026-11-10T04:04:01.000Z", edition: "2026-11-10", rank: 2),
            // The windmill moved after the edition went out.
            version("f3", story: "f-windmill", at: "2026-11-10T09:00:00.000Z", change: "Назвали цену."),
            version("g1", story: "g-ferry", at: "2026-11-10T08:00:00.000Z"),
        ])
        let today = desk.page(now: Self.now, read: NewsReadState(seen: ["e1", "f1", "f3", "g1"]))
        #expect(today.edition.map(\.id) == ["e-lighthouse", "f-windmill"])
        #expect(today.radar.map(\.id) == ["f-windmill", "g-ferry"])
        #expect(today.order == ["e-lighthouse", "f-windmill", "g-ferry"])
    }

    // MARK: What is new

    private var readerDesk: NewsDesk {
        desk([
            version("old", story: "n3-cellar", at: "2026-11-08T17:00:00.000Z"),
            version("d1", story: "d1-tunnel", at: "2026-11-09T07:00:00.000Z"),
            version("n2", story: "n2-attic", at: "2026-11-09T17:00:00.000Z"),
            version("ed", story: "e1-garden", at: "2026-11-10T04:04:00.000Z", edition: "2026-11-10", rank: 1),
            version("s1", story: "s1-porch", at: "2026-11-10T06:00:00.000Z"),
            version("n1", story: "n1-roof", at: "2026-11-10T09:10:00.000Z"),
            version("d2", story: "d1-tunnel", at: "2026-11-10T10:05:00.000Z", change: "Тоннель достроили."),
        ])
    }

    @Test func newIsWhatTheReaderHasNotHadOnScreenSinceYesterday() throws {
        let desk = readerDesk
        var read = NewsReadState(lastVisitAt: Self.instant("2026-11-10T08:40:00.000Z"), seen: ["d1", "s1"])
        let page = desk.page(now: Self.now, read: read)
        // The developed story, today's report and last night's; Sunday's is too old to be news, the edition shows its own.
        #expect(page.fresh.map(\.id) == ["d1-tunnel", "n1-roof", "n2-attic"])
        #expect(page.fresh.map { $0.item.developed(since: read) } == [true, false, false])
        #expect(page.radar.map(\.id) == ["s1-porch"])
        #expect(page.edition.map(\.id) == ["e1-garden"])
        #expect(page.unseen(read) == 4)
        #expect(page.order == ["d1-tunnel", "n1-roof", "n2-attic", "e1-garden", "s1-porch"])
        let words = NewsWords(language: .russian, calendar: Self.moscow)
        // Last night's report was already there at the last visit and was not seen then: the line cannot say "since".
        #expect(page.freshSince(read) == nil)
        let recent = desk.page(now: Self.now, read: NewsReadState(lastVisitAt: read.lastVisitAt, seen: ["d1", "s1", "n2"]))
        #expect(recent.fresh.map(\.id) == ["d1-tunnel", "n1-roof"] && recent.freshSince(read) == read.lastVisitAt)
        #expect(words.freshTitle(since: read.lastVisitAt, count: page.fresh.count, now: Self.now) == "Новое с 11:40 · 3")
        #expect(words.freshTitle(since: Self.instant("2026-11-08T08:40:00.000Z"), count: 2, now: Self.now) == "Новое с 8 ноября · 2")
        #expect(words.freshTitle(since: nil, count: 1, now: Self.now) == "Новое · 1")
        #expect(page.fresh.map { words.column($0, on: page.date) } == ["13:05", "12:10", "9 нояб."])

        // Seeing a story covers its developments so far, and nothing else.
        read.see(try #require(desk.item("d1-tunnel")))
        #expect(read.seen == ["d1", "s1", "d2"])
        let after = desk.page(now: Self.now, read: read)
        #expect(after.fresh.map(\.id) == ["n1-roof", "n2-attic"])
        #expect(after.radar.map(\.id) == ["d1-tunnel", "s1-porch"])
        #expect(after.unseen(read) == 3)
        // A later development makes it new again, as a story that moved.
        let later = self.desk(desk.items.flatMap(\.versions) + [version("d3", story: "d1-tunnel", at: "2026-11-10T11:00:00.000Z", change: "Пустили поезда.")])
        let moved = try #require(later.item("d1-tunnel"))
        #expect(moved.isUnseen(read) && moved.developed(since: read))
    }

    @Test func aCopyEditOrCurationNeverMakesAStoryNew() throws {
        let desk = desk([
            version("first", story: "kettle", at: "2026-11-10T06:00:00.000Z"),
            version("copy", story: "kettle", at: "2026-11-10T09:00:00.000Z", title: "Новый агент, исправлено"),
            version("blank", story: "kettle", at: "2026-11-10T09:30:00.000Z", change: "  ", title: "Новый агент, исправлено"),
        ])
        let read = NewsReadState(seen: ["first"])
        let item = try #require(desk.item("kettle"))
        #expect(!item.isUnseen(read) && !item.developed(since: read))
        let page = desk.page(now: Self.now, read: read)
        #expect(page.fresh.isEmpty && page.unseen(read) == 0)
        // It keeps its first report's place on the radar, with the corrected title.
        #expect(page.radar.map { $0.item.story.title } == ["Новый агент, исправлено"])
        #expect(NewsWords(language: .russian, calendar: Self.moscow).column(page.radar[0], on: page.date) == "09:00")
    }

    @Test func aDeviceThatMeetsAFeedFindsOnlyTodayNew() {
        let desk = readerDesk
        let read = desk.baseline(now: Self.now)
        #expect(read.seen == ["old", "d1", "n2"] && read.lastVisitAt == nil)
        let page = desk.page(now: Self.now, read: read)
        #expect(page.fresh.map(\.id) == ["d1-tunnel", "n1-roof", "s1-porch"])
        #expect(page.unseen(read) == 4)
    }

    @Test func arrivalsAreNewStoriesAndEditionsNotCopyEdits() {
        let shown = readerDesk
        let messages = shown.items.flatMap(\.versions)
        #expect(shown.arrivals(in: shown) == 0)
        #expect(shown.arrivals(in: desk(messages + [version("copy", story: "n1-roof", at: "2026-11-10T11:00:00.000Z", title: "Крыша, исправлено")])) == 0)
        #expect(shown.arrivals(in: desk(messages + [version("fresh", story: "p-gate", at: "2026-11-10T11:00:00.000Z")])) == 1)
        #expect(shown.arrivals(in: desk(messages + [version("d3", story: "d1-tunnel", at: "2026-11-10T11:00:00.000Z", change: "Пустили поезда.")])) == 1)
        // Tomorrow's edition arrives with two stories already known from the radar.
        let edition = [version("t1", story: "n1-roof", at: "2026-11-11T04:04:00.000Z", edition: "2026-11-11", rank: 1),
                       version("t2", story: "s1-porch", at: "2026-11-11T04:04:01.000Z", edition: "2026-11-11", rank: 2)]
        #expect(shown.arrivals(in: desk(messages + edition)) == 2)
    }

    // MARK: The status line

    @Test func theStatusLineTellsOneTruth() {
        let page = readerDesk.page(now: Self.now)
        let words = NewsWords(language: .russian, calendar: Self.moscow)
        func line(_ status: NewsStatus?) -> NewsStatusLine { NewsStatusLine(status: status, page: page, calendar: Self.moscow) }
        func text(_ status: NewsStatus?) -> String { words.status(line(status), name: "News", now: Self.now) }
        let next = "2026-11-10T12:05:00.000Z"

        #expect(text(NewsStatus(checkedAt: "2026-11-10T11:35:00.000Z", nextRunAt: next)) == "Выпуск 07:04 · 1 история · радар 14:35")
        // A check on another day carries its date.
        #expect(text(NewsStatus(checkedAt: "2026-11-09T20:35:00.000Z", nextRunAt: next)) == "Выпуск 07:04 · 1 история · радар 9 ноября, 23:35")
        // An older Home says nothing about its runs; the stories still do.
        #expect(text(nil) == "Выпуск 07:04 · 1 история")
        #expect(text(NewsStatus(running: true, checkedAt: "2026-11-10T11:35:00.000Z", failedAt: "2026-11-10T07:20:00.000Z", failure: "x", nextRunAt: next)) == "News проверяет источники…")
        #expect(line(NewsStatus(running: true)).isRunning)
        // The Home names its latest failed run; the radar stopped after the last check that worked.
        #expect(text(NewsStatus(checkedAt: "2026-11-10T07:05:00.000Z", failedAt: "2026-11-10T11:35:00.000Z", failure: " Закончился лимит модели. ", nextRunAt: next))
                == "Радар не работает с 10:05: Закончился лимит модели.")
        #expect(text(NewsStatus(failedAt: "2026-11-09T07:20:00.000Z", failure: nil, nextRunAt: next)) == "Радар не работает с 9 ноября, 10:20")
        #expect(line(NewsStatus(failedAt: "2026-11-09T07:20:00.000Z", nextRunAt: next)).isFailing)
        // Paused wins over an old failure: the owner stopped it.
        #expect(text(NewsStatus(checkedAt: "2026-11-08T10:40:00.000Z", failedAt: "2026-11-08T09:00:00.000Z", failure: "x", nextRunAt: nil)) == "News на паузе с 8 ноября")
        #expect(text(NewsStatus()) == "News на паузе")
        #expect(!line(NewsStatus()).isFailing && !line(NewsStatus()).isRunning)
    }

    @Test func theStatusDecodesInEveryVariantAndMayBeAbsent() throws {
        func feed(_ status: String?) throws -> NewsFeedEnvelope {
            let field = status.map { ",\"status\":" + $0 } ?? ""
            return try JSONDecoder().decode(NewsFeedEnvelope.self, from: Data(("{\"messages\":[],\"stamp\":\"1-1-0\"" + field + "}").utf8))
        }
        // An older Home.
        #expect(try feed(nil).status == nil)
        #expect(try feed(#"{"running":false,"checkedAt":"2026-11-10T11:35:00.000Z","failedAt":null,"failure":null,"nextRunAt":"2026-11-10T11:50:00.000Z"}"#).status
                == NewsStatus(checkedAt: "2026-11-10T11:35:00.000Z", nextRunAt: "2026-11-10T11:50:00.000Z"))
        #expect(try feed(#"{"running":true,"checkedAt":null,"failedAt":null,"failure":null,"nextRunAt":"2026-11-10T11:50:00.000Z"}"#).status
                == NewsStatus(running: true, nextRunAt: "2026-11-10T11:50:00.000Z"))
        #expect(try feed(#"{"running":false,"checkedAt":"2026-11-10T07:05:00.000Z","failedAt":"2026-11-10T07:20:00.000Z","failure":"Закончился лимит модели.","nextRunAt":"2026-11-10T11:50:00.000Z"}"#).status
                == NewsStatus(checkedAt: "2026-11-10T07:05:00.000Z", failedAt: "2026-11-10T07:20:00.000Z", failure: "Закончился лимит модели.", nextRunAt: "2026-11-10T11:50:00.000Z"))
        #expect(try feed(#"{"running":false,"checkedAt":"2026-11-08T10:40:00.000Z","failedAt":null,"failure":null,"nextRunAt":null}"#).status
                == NewsStatus(checkedAt: "2026-11-08T10:40:00.000Z"))
        // A field this app does not know, or one of a wrong kind, never costs the stories.
        #expect(try feed(#"{"running":"yes","later":1}"#).status == NewsStatus())
        // A story may say how it went out to Telegram; the reader does not need to know.
        let story = try JSONDecoder().decode(NewsStory.self, from: Data(#"{"id":"kettle","edition":null,"rank":null,"section":"Агенты","status":"Вышло","title":"Чайник","summary":"Суть","body":"Факты","view":null,"check":null,"verification":"Страница","eventAt":null,"change":null,"sources":[],"telegram":"card"}"#.utf8))
        #expect(story.id == "kettle" && story.sources.isEmpty)
    }

    // MARK: Language

    @Test func newsSpeaksTheLanguageOfItsStories() {
        let russian = [version("a", story: "a").story!, version("b", story: "b").story!, version("c", story: "c", title: "Lantern 2").story!]
        let english = [version("a", story: "a", title: "A new agent").story!]
        #expect(NewsWords(stories: russian, interface: .english).language == .russian)
        #expect(NewsWords(stories: russian, interface: .hebrew).language == .russian)
        #expect(NewsWords(stories: english, interface: .russian).language == .english)
        #expect(NewsWords(stories: english, interface: .french).language == .french)
        #expect(NewsWords(stories: [], interface: .spanish).language == .spanish)

        let words = NewsWords(stories: russian, interface: .english, calendar: Self.moscow)
        #expect(words("Радар за день") == "Радар за день")
        #expect(words.masthead("2026-11-10", now: Self.now) == "ВТОРНИК · 10 НОЯБРЯ")
        #expect(words.day("2025-12-31", now: Self.now).hasPrefix("31 декабря 2025"))
        #expect([1, 2, 5, 11, 21, 22].map(words.stories) == ["1 история", "2 истории", "5 историй", "11 историй", "21 история", "22 истории"])
        #expect([1, 2, 5, 11, 21].map(words.fresh) == ["1 новая", "2 новых", "5 новых", "11 новых", "21 новая"])
        let plain = NewsWords(stories: english, interface: .russian, calendar: Self.moscow)
        #expect(plain("Радар за день") == "Radar of the day")
        #expect([1, 3].map(plain.stories) == ["1 story", "3 stories"])
        #expect(plain.status(.running, name: "News") == "News is checking sources…")
    }

    // MARK: The feed

    @Test func whatWasSeenStaysWithTheHomeAndConversationAndArrivalsWait() async throws {
        let fixture = NewsFixture()
        // Reports from this minute and from three days ago, whatever day the test runs on.
        fixture.messages = [version("old", story: "cellar", at: fixture.stamp(-3 * 86_400)), version("now", story: "roof", at: fixture.stamp(-1))]
        fixture.status = #"{"running":true,"checkedAt":null,"failedAt":null,"failure":null,"nextRunAt":"2026-11-10T11:50:00.000Z"}"#
        let (client, session, defaults, suite) = makeClient(fixture)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        let route = ReaderRoute(connectionID: client.id, kind: .news("news"), title: "News")
        #expect(route.path == "/v1/agents/news/conversation" && route.profileID == "news" && route.usesTimeline)

        let feed = NewsFeed(client: client, route: route, defaults: defaults)
        #expect(!feed.loaded)
        await feed.refresh()
        #expect(feed.loaded && !feed.unreachable && feed.conversationID == "c-news")
        #expect(feed.desk.items.map(\.id) == ["cellar", "roof"])
        #expect(feed.status == NewsStatus(running: true, nextRunAt: "2026-11-10T11:50:00.000Z"))
        // Nothing is seen by loading; what was there before today is not news to a device that meets the feed.
        #expect(!feed.read.seen.contains("now"))
        #expect(feed.headline == "Новый агент")
        feed.see(["roof", "cellar"])
        #expect(feed.read.seen == ["old", "now"] && feed.unseen == 0)

        // The page is being read: a new story waits, a copy edit does not.
        feed.appear()
        fixture.messages.append(version("copy", story: "roof", at: fixture.stamp(0), title: "Исправлено"))
        fixture.revision += 1
        await eventually { await feed.refresh(); return feed.desk.item("roof")?.story.title == "Исправлено" }
        #expect(feed.arrivals == 0 && feed.incoming == nil)
        fixture.messages.append(version("gate", story: "gate", at: fixture.stamp(0)))
        fixture.revision += 1
        await eventually { await feed.refresh(); return feed.arrivals == 1 }
        #expect(feed.desk.items.count == 2 && feed.latest.items.count == 3 && feed.unseen == 1)
        let landed = feed.landings
        feed.showIncoming()
        #expect(feed.desk.items.count == 3 && feed.arrivals == 0 && feed.landings == landed + 1)
        // The visit starts over with what has been seen so far, so «Новое» is just what arrived.
        #expect(feed.desk.page(read: feed.visit).fresh.map(\.id) == ["gate"])

        // One page of the feed replacing another is the same visit: «Новое» keeps what it showed.
        feed.see(["gate"])
        #expect(feed.visit != feed.read)
        feed.disappear(); feed.appear()
        #expect(feed.isOpen && feed.desk.page(read: feed.visit).fresh.map(\.id) == ["gate"])
        // Leaving the feed and coming back is a new visit: what was seen is no longer new, and the place may be held.
        feed.place.story = "gate"
        feed.hold(); feed.closeStory()
        feed.disappear()
        try await Task.sleep(for: .milliseconds(900))
        #expect(!feed.isOpen && feed.place.story == "gate")
        feed.appear()
        #expect(feed.isOpen && feed.visit == feed.read && feed.desk.page(read: feed.visit).fresh.isEmpty)
        feed.closeStory()
        #expect(feed.place.story == nil)

        // Beside the home, choosing another place closes the desk's pages for real and keeps where the reader was.
        feed.place.story = "gate"; feed.place.day = "2026-11-09"
        feed.leave()
        #expect(feed.isAway)
        feed.closeStory(); feed.closeDay()
        #expect(feed.place.story == "gate" && feed.place.day == "2026-11-09")
        // Back at the desk, even at once, its pages may open again and closing one is the reader's own doing.
        // The pages over the paper say when they come and go, so the app knows when the last has closed.
        feed.cover(); feed.cover()
        #expect(feed.pagesOver == 2)
        feed.uncover(); feed.uncover(); feed.uncover()
        #expect(feed.pagesOver == 0)
        feed.arrive()
        #expect(!feed.isAway && feed.place.story == "gate")
        feed.closeStory(); feed.closeDay()
        #expect(feed.place.story == nil && feed.place.day == nil)

        // Another launch of the app reads the same Home and conversation: seen is still seen.
        let again = NewsFeed(client: client, route: route, defaults: defaults)
        await again.refresh()
        #expect(again.read.seen.isSuperset(of: ["old", "now", "gate"]) && again.unseen == 0)
        // A different conversation of the same Home starts clean.
        fixture.conversation = "c-other"
        let other = NewsFeed(client: client, route: ReaderRoute(connectionID: client.id, kind: .news("other"), title: "Other"), defaults: defaults)
        await other.refresh()
        #expect(other.conversationID == "c-other" && !other.read.seen.contains("now"))

        // An older Home sends no status, and one that stops answering keeps what is on screen.
        fixture.conversation = "c-news"; fixture.status = nil; fixture.revision += 1
        await eventually { await again.refresh(); return again.status == nil }
        fixture.failing = true
        await again.refresh()
        #expect(again.unreachable && again.desk.items.count == 3)

        // A feed whose stories have all aged out still speaks their language, also after a relaunch.
        #expect(again.words.language == .russian)
        fixture.failing = false; fixture.messages = []; fixture.revision += 1
        await eventually { await again.refresh(); return again.desk.items.isEmpty }
        #expect(again.words.language == .russian)
        let emptied = NewsFeed(client: client, route: route, defaults: defaults)
        await emptied.refresh()
        #expect(emptied.loaded && emptied.desk.items.isEmpty && emptied.words.language == .russian)
    }

    private func eventually(_ condition: () async -> Bool) async {
        for _ in 0..<200 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("The condition never became true.")
    }

    private func makeClient(_ fixture: NewsFixture) -> (HomeClient, URLSession, UserDefaults, String) {
        let suite = "OpenStrudel.news-test." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set("http://127.0.0.1:57578", forKey: "openstrudel.homeURL")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NewsProtocol.self]
        NewsProtocol.setHandler { request in await fixture.respond(request) }
        let session = URLSession(configuration: config)
        let client = HomeClient(defaults: defaults, session: session, pendingDirectory: FileManager.default.temporaryDirectory.appending(path: suite), connectionID: suite,
                                credentialReader: { _, _ in nil }, credentialWriter: { _, _ in })
        return (client, session, defaults, suite)
    }
}

/// A Home that serves one employee's conversation and its stories.
@MainActor private final class NewsFixture {
    var messages: [HomeMessage] = []
    var status: String?
    var conversation = "c-news"
    var revision = 1
    var failing = false

    /// A moment relative to now, as the Home writes it.
    func stamp(_ seconds: TimeInterval) -> String { Date.now.addingTimeInterval(seconds).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)) }

    func respond(_ request: URLRequest) -> (Int, Data) {
        let path = request.url?.path ?? ""
        if failing { return (503, Data(#"{"error":"down"}"#.utf8)) }
        if path.hasSuffix("/conversation") {
            return (200, Data(#"{"conversation":{"id":"\#(conversation)","channel":"api","externalId":null,"title":null,"codexThreadId":null,"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-01T00:00:00.000Z","news":"\#(revision)"},"messages":[],"interactions":[],"timeline":true}"#.utf8))
        }
        if path == "/v1/conversations/" + conversation + "/stories" {
            let stories = String(data: (try? JSONEncoder().encode(messages)) ?? Data("[]".utf8), encoding: .utf8) ?? "[]"
            let field = status.map { ",\"status\":" + $0 } ?? ""
            return (200, Data(("{\"messages\":" + stories + ",\"stamp\":\"\(revision)\"" + field + "}").utf8))
        }
        return (404, Data(#"{"error":"not_found"}"#.utf8))
    }
}

private final class NewsProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (URLRequest) async -> (Int, Data))?
    private var operation: Task<Void, Never>?
    static func setHandler(_ value: @escaping @Sendable (URLRequest) async -> (Int, Data)) { lock.lock(); defer { lock.unlock() }; handler = value }
    private static func getHandler() -> (@Sendable (URLRequest) async -> (Int, Data))? { lock.lock(); defer { lock.unlock() }; return handler }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        operation = Task { @Sendable [self] in
            guard let handler = Self.getHandler(), let url = request.url else { return }
            let (status, data) = await handler(request)
            guard !Task.isCancelled else { return }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { operation?.cancel() }
}

// MARK: - The paper

/// The front page's arithmetic, the week, the search and the copy of the paper a device keeps.
extension NewsDeskTests {
    private func report(_ id: String, at created: String, section: String = "Модели", status: String = "Вышло", telegram: String? = nil, edition: String? = nil, rank: Int? = nil,
                        change: String? = nil, topics: [String]? = nil, title: String? = nil, message: String? = nil) -> HomeMessage {
        HomeMessage(id: message ?? id + "@" + created, conversationId: "news", channel: "api", direction: "outbound", replyToId: nil,
                    text: "Story", externalId: nil, createdAt: created, status: "completed", error: nil, kind: "text",
                    story: NewsStory(id: id, edition: edition, rank: rank, section: section, status: status, title: title ?? id, summary: "Первый абзац.\n\nВторой абзац.",
                                     body: "Факты про " + id, view: nil, check: nil, verification: "Источник", eventAt: nil, change: change, sources: [],
                                     topics: topics, telegram: telegram))
    }

    @Test func thePaperLeadsWithWhatMustBeKnownThenTheEditionThenTheRadar() {
        let desk = desk([
            report("quiet", at: "2026-11-10T05:00:00.000Z"),
            report("second", at: "2026-11-10T04:04:00.000Z", edition: "2026-11-10", rank: 2),
            report("first", at: "2026-11-10T04:04:01.000Z", edition: "2026-11-10", rank: 1),
            report("card-early", at: "2026-11-10T06:00:00.000Z", telegram: "card"),
            report("card-late", at: "2026-11-10T09:00:00.000Z", section: "Роботы", telegram: "card"),
            report("urgent", at: "2026-11-10T08:00:00.000Z", telegram: "alert"),
            report("point", at: "2026-11-10T10:30:00.000Z", status: "Разбор", telegram: "card"),
            report("robot", at: "2026-11-10T07:00:00.000Z", section: "Роботы"),
        ])
        let front = desk.front(now: Self.now)
        #expect(front.stories.map(\.id) == ["urgent", "first", "second", "point", "card-late", "card-early", "robot", "quiet"])
        #expect(front.lead?.id == "urgent" && front.isToday && !front.standsIn)
        // The analysis stands in its own block, the next four are the top stories, the rest go under their sections.
        #expect(front.analysis.map(\.id) == ["point"])
        #expect(front.top.map(\.id) == ["first", "second", "card-late", "card-early"])
        #expect(front.sections.map(\.name) == ["Роботы", "Модели"])
        #expect(front.sections.map { $0.items.map(\.id) } == [["robot"], ["quiet"]])
        #expect(front.order == ["urgent", "first", "second", "card-late", "card-early", "point", "robot", "quiet"])
        #expect(Set(front.order).count == front.stories.count, "every story stands in one place")
        #expect(front.published == Self.instant("2026-11-10T04:04:00.000Z"))
        #expect(NewsStatusLine(status: NewsStatus(nextRunAt: "2026-11-10T12:05:00.000Z"), front: front, calendar: Self.moscow)
                == .edition(published: Self.instant("2026-11-10T04:04:00.000Z"), stories: 8, checked: nil))
    }

    @Test func newIsWhatWasReportedSinceTheReaderLastLeftTodaysPaper() {
        let messages = [
            report("morning", at: "2026-11-10T05:00:00.000Z", telegram: "card"),
            report("unread", at: "2026-11-10T06:00:00.000Z"),
            report("noon", at: "2026-11-10T09:10:00.000Z"),
            report("morning", at: "2026-11-10T10:00:00.000Z", change: "Назвали цену.", message: "morning-update"),
            report("urgent", at: "2026-11-10T11:00:00.000Z", telegram: "alert"),
        ]
        let desk = desk(messages)
        // The first look of the day: the paper is the paper, nothing is singled out.
        var read = NewsReadState(lastVisitAt: Self.instant("2026-11-09T18:00:00.000Z"))
        #expect(desk.front(now: Self.now, read: read).fresh.isEmpty)
        #expect(desk.front(now: Self.now, read: read).unseen(read) == 4)
        // Back at noon, having left at 09:00 with the morning story seen: what came since is new, the newest first.
        // The story left unread then is not new, and the lead is never repeated.
        read = NewsReadState(lastVisitAt: Self.instant("2026-11-10T06:30:00.000Z"), seen: ["morning@2026-11-10T05:00:00.000Z"])
        let front = desk.front(now: Self.now, read: read)
        #expect(front.lead?.id == "urgent")
        #expect(front.fresh.map(\.id) == ["morning", "noon"])
        #expect(front.fresh.first?.isDevelopment == true)
        #expect(front.top.map(\.id) == ["unread"])
        #expect(front.freshSince(read, calendar: Self.moscow) == Self.instant("2026-11-10T06:30:00.000Z"))
        // An earlier day's page singles nothing out.
        #expect(desk.front("2026-11-10", now: Self.instant("2026-11-11T08:00:00.000Z"), read: read).fresh.isEmpty)
    }

    @Test func beforeTodaysFirstStoryTheLatestPaperStandsInAndSaysSo() {
        let desk = desk([report("monday", at: "2026-11-09T09:00:00.000Z"), report("sunday", at: "2026-11-08T09:00:00.000Z")])
        let front = desk.front(now: Self.now)
        #expect(front.date == "2026-11-09" && front.isToday && front.standsIn && front.lead?.id == "monday")
        #expect(front.earlier.map(\.date) == ["2026-11-08"])
        #expect(NewsStatusLine(status: NewsStatus(nextRunAt: "2026-11-10T12:05:00.000Z"), front: front, calendar: Self.moscow) == .noEdition(standIn: "2026-11-09"))
        let empty = self.desk([]).front(now: Self.now)
        #expect(empty.isEmpty && empty.lead == nil && empty.date == "2026-11-10")
        // An earlier day is the page of that day alone.
        let sunday = desk.front("2026-11-08", now: Self.now)
        #expect(!sunday.isToday && sunday.stories.map(\.id) == ["sunday"] && sunday.earlier.map(\.date) == ["2026-11-09"])
    }

    @Test func theWeekCountsWhereTheStoriesWereAndWhomTheyWereAbout() {
        let desk = desk([
            report("old-model", at: "2026-10-30T09:00:00.000Z", topics: ["Клён"]),
            report("old-robot", at: "2026-10-31T09:00:00.000Z", section: "Роботы", topics: ["Скворец"]),
            report("old-robot-2", at: "2026-11-01T09:00:00.000Z", section: "Роботы"),
            report("model-a", at: "2026-11-05T09:00:00.000Z", telegram: "alert", topics: ["Клён", "Северный мост"]),
            report("model-b", at: "2026-11-08T09:00:00.000Z", topics: ["клён"]),
            report("model-c", at: "2026-11-10T09:00:00.000Z", topics: ["Ива"]),
            report("robot", at: "2026-11-09T09:00:00.000Z", section: "Роботы"),
            report("robot", at: "2026-11-10T10:00:00.000Z", section: "Роботы", change: "Показали вторую версию.", message: "robot-update"),
        ])
        var read = NewsReadState(seen: ["model-a@2026-11-05T09:00:00.000Z", "model-b@2026-11-08T09:00:00.000Z"])
        read.opened = ["model-a": Self.now]
        let week = NewsWeek(desk, read: read, now: Self.now)
        #expect(week.stories.map(\.id) == ["model-c", "robot", "model-b", "model-a"])
        #expect(week.storiesBefore == 3 && week.mustKnow == 1)
        #expect(week.sections.map(\.name) == ["Модели", "Роботы"])
        #expect(week.sections.map(\.count) == [3, 1] && week.sections.map(\.before) == [1, 2])
        #expect(week.sections.map(\.direction) == [1, -1])
        // A name counts once a story, however it is capitalised, and keeps the spelling it was first given this week.
        #expect(week.topics.map(\.name) == ["Клён", "Ива", "Северный мост"])
        #expect(week.topics.map(\.count) == [2, 1, 1] && week.topics.first?.before == 1 && week.topics.first?.latest.id == "model-b")
        #expect(week.storylines.map(\.item.id) == ["robot"] && week.storylines.first?.events == 2)
        #expect(week.seen == 2 && week.opened == 1)
        // A feed that does not reach the week before says nothing about it.
        let short = NewsWeek(self.desk([report("only", at: "2026-11-10T09:00:00.000Z")]), now: Self.now)
        #expect(short.storiesBefore == nil && short.sections.first?.before == nil && short.sections.first?.direction == nil)
        #expect(NewsWords(language: .russian).change(3, from: 1) == "+2" && NewsWords(language: .russian).change(1, from: 2) == "−1")
    }

    @Test func aStoryIsFoundByItsWordsAndByWhomItIsAbout() throws {
        let desk = desk([
            report("klen-open", at: "2026-11-08T09:00:00.000Z", topics: ["Клён", "Северный мост"], title: "Открыты веса модели"),
            report("klen-cloud", at: "2026-11-10T09:00:00.000Z", topics: ["клён"], title: "Модель появилась в облаках"),
            report("robot", at: "2026-11-09T09:00:00.000Z", section: "Роботы", title: "Робот собрал шкаф"),
        ])
        #expect(desk.search("модел").map(\.id) == ["klen-cloud", "klen-open"])
        #expect(desk.search("северный клён").map(\.id) == ["klen-open"])
        #expect(desk.search("роботы шкаф").map(\.id) == ["robot"])
        #expect(desk.search("  ").isEmpty && desk.search("трактор").isEmpty)
        #expect(desk.related(to: try #require(desk.item("klen-cloud"))).map(\.id) == ["klen-open"])
        #expect(desk.related(to: try #require(desk.item("robot"))).isEmpty)
    }

    @Test func aRunOfDaysEndsTodayOrYesterday() {
        var read = NewsReadState()
        #expect(read.streak(now: Self.now, calendar: Self.moscow) == 0)
        read.days = ["2026-11-10", "2026-11-09", "2026-11-08", "2026-11-06"]
        #expect(read.streak(now: Self.now, calendar: Self.moscow) == 3)
        read.days = ["2026-11-09", "2026-11-08"]
        #expect(read.streak(now: Self.now, calendar: Self.moscow) == 2)
        read.days = ["2026-11-07"]
        #expect(read.streak(now: Self.now, calendar: Self.moscow) == 0)
        // A state saved by an earlier version has neither days nor opened stories.
        let saved = try? JSONDecoder().decode(NewsReadState.self, from: Data(#"{"seen":["a"]}"#.utf8))
        #expect(saved?.seen == ["a"] && saved?.days == nil && saved?.opened == nil)
    }

    @Test func aStoryCarriesItsFiguresAndNamesAndAnOlderOneDoesWithout() throws {
        let json = #"{"id":"s","edition":null,"rank":null,"section":"Модели","status":"Вышло","title":"T","summary":"S","body":"B","view":null,"check":null,"verification":"V","eventAt":null,"change":null,"sources":[]"#
        let full = try JSONDecoder().decode(NewsStory.self, from: Data((json + #","telegram":"alert","numbers":[{"value":"30%","label":"было 16%"}],"topics":["Клён"]}"#).utf8))
        #expect(full.numbers == [NewsStory.Number(value: "30%", label: "было 16%")] && full.topics == ["Клён"] && full.telegram == "alert")
        let old = try JSONDecoder().decode(NewsStory.self, from: Data((json + "}").utf8))
        #expect(old.numbers == nil && old.topics == nil && old.telegram == nil && old.opening == "S")
        let edition = try JSONDecoder().decode(NewsEditionTitle.self, from: Data(#"{"date":"2026-11-10","title":"Утро"}"#.utf8))
        #expect(edition.intro == nil)
    }

    @Test func thePaperOpensFromTheCopyTheDeviceKeeps() async throws {
        let fixture = NewsFixture()
        fixture.messages = [version("now", story: "roof", at: fixture.stamp(-1))]
        let (client, session, defaults, suite) = makeClient(fixture)
        let folder = FileManager.default.temporaryDirectory.appending(path: "news-cache-" + UUID().uuidString)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: folder) }
        let route = ReaderRoute(connectionID: client.id, kind: .news("news"), title: "News")
        let first = NewsFeed(client: client, route: route, defaults: defaults, cache: folder)
        #expect(!first.loaded && first.lead == nil)
        await first.refresh()
        #expect(first.lead?.id == "roof")
        first.open("roof")
        #expect(first.read.opened?["roof"] != nil && first.unseen == 0)

        // The next launch has the paper before the Home has said a word, with what was read of it.
        let second = NewsFeed(client: client, route: route, defaults: defaults, cache: folder)
        #expect(second.loaded && second.lead?.id == "roof" && second.conversationID == "c-news" && second.unseen == 0)
        #expect(second.status == nil, "what the Home said about its runs then is not said again")
        // Another desk keeps its own copy.
        let other = NewsFeed(client: client, route: ReaderRoute(connectionID: client.id, kind: .news("startups"), title: "Startups"), defaults: defaults, cache: folder)
        #expect(!other.loaded && other.lead == nil)
    }
}

extension NewsDeskTests {
    @Test func anEditionReadsUnderTheNameItsDeskGaveIt() {
        let words = NewsWords(language: .russian, calendar: Self.moscow)
        let edition = desk([version("a", story: "kettle", at: "2026-11-10T04:04:00.000Z", edition: "2026-11-10", rank: 1)]).front(now: Self.now)
        #expect(words.paperTitle(edition, named: NewsEditionTitle(date: "2026-11-10", title: "Стартапы дня"), now: Self.now) == "Стартапы дня")
        #expect(words.paperTitle(edition, named: NewsEditionTitle(date: "2026-11-09", title: "Вчерашнее"), now: Self.now) == "Выпуск")
        #expect(words.paperTitle(edition, named: nil, now: Self.now) == "Выпуск")
        let standIn = desk([version("b", story: "lantern", at: "2026-11-09T04:04:00.000Z", edition: "2026-11-09", rank: 1)]).front(now: Self.now)
        #expect(words.paperTitle(standIn, named: nil, now: Self.now) == "Выпуск за 9 ноября")
    }
}
