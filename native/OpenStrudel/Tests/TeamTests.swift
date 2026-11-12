import Foundation
import Testing

/// The team list's arithmetic: the order of its rows, what a row says, the times and rhythms in words, what this
/// device has read, and what an older Home leaves unsaid. Every name and number here is invented.
@Suite(.serialized)
@MainActor struct TeamTests {
    private static let moscow: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Moscow")!
        return calendar
    }()
    /// Tuesday 10 November 2026, 14:50 in Moscow.
    private static let now = instant("2026-11-10T11:50:00.000Z")
    private static func instant(_ text: String) -> Date { try! Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) }
    private var russian: TeamWords { TeamWords(language: .russian, calendar: Self.moscow) }
    private var english: TeamWords { TeamWords(language: .english, calendar: Self.moscow) }

    private func profile(_ id: String, _ name: String, _ extra: String = "") throws -> EmployeeProfile {
        try JSONDecoder().decode(EmployeeProfile.self, from: Data(#"{"id":"\#(id)","name":"\#(name)","instructions":"","capabilities":[],"model":null,"tokenLimit":null,"createdAt":"2026-01-01T00:00:00.000Z"\#(extra)}"#.utf8))
    }
    private func schedule(_ id: String, cron: String, next: String, enabled: Bool = true, backupOf: String? = nil) throws -> ChatSchedule {
        try JSONDecoder().decode(ChatSchedule.self, from: Data("""
        {"id":"\(id)","conversationId":"c","name":"Run \(id)","prompt":"Check","cron":"\(cron)","timezone":"UTC","enabled":\(enabled),
         "nextRunAt":"\(next)","telegramChatId":null\(backupOf.map { ",\"backupOf\":\"\($0)\"" } ?? "")}
        """.utf8))
    }
    private func run(_ id: String, _ schedule: String, _ status: String, at: String, error: String? = nil) throws -> ScheduleRun {
        try JSONDecoder().decode(ScheduleRun.self, from: Data(#"{"id":"\#(id)","scheduleId":"\#(schedule)","status":"\#(status)","scheduledFor":"\#(at)","messageId":null,"error":\#(error.map { "\"" + $0 + "\"" } ?? "null")}"#.utf8))
    }

    // MARK: What a Home sends

    @Test func aHomeThatListsItsTeamsWorkIsReadAndAnOlderOneLeavesItUnsaid() throws {
        let alive = try profile("p1", "Scout", #","preview":"Done","previewAt":"2026-11-10T09:00:00.000Z","working":true,"nextRunAt":"2026-11-11T04:15:00.000Z","failing":false,"news":false"#)
        #expect(alive.previewAt == "2026-11-10T09:00:00.000Z" && alive.working == true && alive.failing == false && alive.nextRunAt == "2026-11-11T04:15:00.000Z")
        let older = try profile("p2", "Baker", #","preview":"Done""#)
        #expect(older.previewAt == nil && older.working == nil && older.failing == nil && older.nextRunAt == nil)
        // A saved catalogue keeps what it was told.
        #expect(try JSONDecoder().decode(EmployeeProfile.self, from: JSONEncoder().encode(alive)) == alive)
        #expect(Team.state(alive, offline: false) == .working)
        #expect(Team.state(alive, offline: true) == .offline)
        #expect(Team.state(older, offline: false) == .resting)
        #expect(Team.state(try profile("p3", "Clerk", #","working":true,"failing":true"#), offline: false) == .working)
        #expect(Team.state(try profile("p3", "Clerk", #","working":false,"failing":true"#), offline: false) == .failing)
    }

    @Test func aStoryMayCarryAPictureAndAnOlderHomeSendsNone() throws {
        let story = #"{"id":"s","edition":null,"rank":null,"section":"Models","status":"Out","title":"T","summary":"S","body":"B","view":null,"check":null,"verification":"V","eventAt":null,"change":null,"sources":[]"#
        #expect(try JSONDecoder().decode(NewsStory.self, from: Data((story + #","image":"https://pictures.example/chart_(1).png"}"#).utf8)).image == "https://pictures.example/chart_(1).png")
        #expect(try JSONDecoder().decode(NewsStory.self, from: Data((story + #","image":null}"#).utf8)).image == nil)
        #expect(try JSONDecoder().decode(NewsStory.self, from: Data((story + "}").utf8)).image == nil)
        let feed = try JSONDecoder().decode(NewsFeedEnvelope.self, from: Data(#"{"messages":[],"stamp":null,"edition":{"date":"2026-11-10","title":"Founders' brief"}}"#.utf8))
        #expect(feed.edition == NewsEditionTitle(date: "2026-11-10", title: "Founders' brief"))
        #expect(try JSONDecoder().decode(NewsFeedEnvelope.self, from: Data(#"{"messages":[],"stamp":null}"#.utf8)).edition == nil)
    }

    // MARK: Rows

    @Test func desksComeFirstThenNamesAndEqualNamesNeverTradePlaces() throws {
        let profiles = [try profile("b", "recipes"), try profile("z", "Startups", #","news":true"#), try profile("a2", "Atlas"), try profile("a1", "Atlas"),
                        try profile("n", "News", #","news":true"#), try profile("t", "Tutor 10"), try profile("s", "Tutor 9")]
        let ordered = Team.order(profiles, locale: Locale(identifier: "en"))
        #expect(ordered.map(\.id) == ["n", "z", "a1", "a2", "b", "s", "t"])
        #expect(Team.order(profiles.reversed(), locale: Locale(identifier: "en")).map(\.id) == ordered.map(\.id))
        let members = Team.members(profiles, on: "home")
        #expect(members.first?.route == ReaderRoute(connectionID: "home", kind: .news("n"), title: "News"))
        #expect(members.first?.isDesk == true)
        #expect(members.last?.route == ReaderRoute(connectionID: "home", kind: .employee("t"), title: "Tutor 10"))
    }

    @Test func aRowsSecondLineIsOnePlainLine() {
        #expect(Team.line("**Kettle 3 ships**\n\nIt boils faster.") == "Kettle 3 ships")
        #expect(Team.line("\n\n## Draft ready\n- first") == "Draft ready")
        #expect(Team.line("Read [the notes](<https://example.org/a_(b)>) and `run`") == "Read the notes and run")
        #expect(Team.line("   \n") == "" && Team.line(nil) == "")
    }

    // MARK: Times in words

    @Test func aRowsTimeIsAsShortAsItsCornerAllows() {
        let words = russian, now = Self.now
        #expect(words.ago(Self.instant("2026-11-10T11:49:30.000Z"), now: now) == "сейчас")
        #expect(words.ago(Self.instant("2026-11-10T11:45:00.000Z"), now: now) == "5 мин")
        #expect(words.ago(Self.instant("2026-11-10T08:50:00.000Z"), now: now) == "3 ч")
        // Late yesterday is yesterday, however few hours ago.
        #expect(words.ago(Self.instant("2026-11-09T20:30:00.000Z"), now: Self.instant("2026-11-09T21:30:00.000Z")) == "вчера")
        #expect(words.ago(Self.instant("2026-11-09T10:00:00.000Z"), now: now) == "вчера")
        #expect(words.ago(Self.instant("2026-11-06T10:00:00.000Z"), now: now).lowercased() == "пт")
        #expect(words.ago(Self.instant("2026-11-01T10:00:00.000Z"), now: now).contains("нояб"))
        #expect(words.ago(Self.instant("2025-12-31T10:00:00.000Z"), now: now).contains("2025"))
        // A clock that runs ahead of the Home's never shows a negative time.
        #expect(words.ago(Self.instant("2026-11-10T11:50:20.000Z"), now: now) == "сейчас")
        #expect(english.ago(Self.instant("2026-11-10T11:45:00.000Z"), now: now) == "5 min")
        #expect(english.ago(Self.instant("2026-11-09T10:00:00.000Z"), now: now) == "yesterday")
    }

    @Test func theNextRunIsSaidAsAPersonWould() {
        let words = russian, now = Self.now
        #expect(words.nextRun(Self.instant("2026-11-11T03:45:00.000Z"), now: now) == "Следующий запуск завтра в 06:45")
        #expect(words.nextRun(Self.instant("2026-11-10T15:30:00.000Z"), now: now) == "Следующий запуск сегодня в 18:30")
        #expect(words.nextRun(Self.instant("2026-11-14T04:15:00.000Z"), now: now) == "Следующий запуск 14 ноября в 07:15")
        #expect(english.nextRun(Self.instant("2026-11-11T03:45:00.000Z"), now: now).hasPrefix("Next run tomorrow at "))
    }

    @Test func anEmployeesRhythmNamesItsNearestScheduleItsNextRunAndHowManyMore() throws {
        let words = russian, now = Self.now
        let morning = try schedule("morning", cron: "15 4 * * *", next: "2026-11-11T04:15:00.000Z")
        // The rhythm names its hour, so the next run needs only its day; nothing more to add.
        #expect(words.rhythm([morning], now: now)?.line == "Каждый день в 07:15 · следующий завтра")
        #expect(words.rhythm([morning], now: now)?.more == nil)
        let radar = try schedule("radar", cron: "*/15 * * * *", next: "2026-11-10T12:00:00.000Z")
        let weekly = try schedule("weekly", cron: "30 15 * * 6", next: "2026-11-14T15:30:00.000Z")
        // The nearest one speaks; a paused one, a one-time reminder and a backup are not rhythms of their own.
        let others = [try schedule("paused", cron: "0 9 * * *", next: "2026-11-10T12:30:00.000Z", enabled: false),
                      try schedule("once", cron: "@once 2026-11-10T12:10:00Z", next: "2026-11-10T12:10:00.000Z"),
                      try schedule("backup", cron: "15 5 * * *", next: "2026-11-10T12:05:00.000Z", backupOf: "morning")]
        // A rhythm without an hour says the hour of its next run; how many more there are is kept apart.
        let busy = try #require(words.rhythm([morning, weekly, radar] + others, now: now))
        #expect(busy.line == "Раз в 15 мин · следующий в 15:00" && busy.more == "и ещё 2")
        #expect(words.rhythm([weekly], now: now)?.line == "По субботам в 18:30 · следующий 14 нояб.")
        let overnight = try schedule("hours", cron: "0 */3 * * *", next: "2026-11-11T00:00:00.000Z")
        #expect(words.rhythm([overnight], now: now)?.line == "Раз в 3 ч · следующий завтра в 03:00")
        #expect(words.rhythm(weekly) == "По субботам в 18:30")
        #expect(words.rhythm(try schedule("workdays", cron: "0 6 * * 1-5", next: "2026-11-11T06:00:00.000Z")) == "По будням в 09:00")
        #expect(words.rhythm(try schedule("hourly", cron: "5 * * * *", next: "2026-11-10T12:05:00.000Z")) == "Каждый час")
        #expect(words.rhythm(try schedule("hours", cron: "0 */3 * * *", next: "2026-11-10T12:00:00.000Z")) == "Раз в 3 ч")
        // A cron with no simpler words is known by its next run alone.
        let monthly = try schedule("monthly", cron: "0 9 1 * *", next: "2026-12-01T09:00:00.000Z")
        #expect(words.rhythm(monthly) == nil)
        #expect(words.rhythm([monthly], now: now)?.line == "Следующий запуск 1 декабря в 12:00")
        #expect(words.rhythm([others[0]], now: now)?.line == "Расписание на паузе")
        #expect(words.rhythm([others[1]], now: now) == nil)
        #expect(words.rhythm([], now: now) == nil)
        #expect(english.rhythm([morning], now: now)?.line.hasPrefix("Every day at ") == true)
    }

    @Test func aFailureIsDatedByTheFirstRunThatDidNotWorkSinceTheLastThatDid() throws {
        let morning = try schedule("morning", cron: "15 4 * * *", next: "2026-11-11T04:15:00.000Z")
        let backup = try schedule("backup", cron: "15 5 * * *", next: "2026-11-11T05:15:00.000Z", backupOf: "morning")
        let radar = try schedule("radar", cron: "*/15 * * * *", next: "2026-11-10T12:00:00.000Z")
        let working = [try run("r3", "radar", "running", at: "2026-11-10T11:45:00.000Z"), try run("r2", "radar", "quiet", at: "2026-11-10T11:30:00.000Z")]
        #expect(Team.failure(working, schedules: [radar]) == nil)
        let failing = working + [try run("m3", "morning", "failed", at: "2026-11-10T04:15:00.000Z", error: "The model's limit ran out.\\nSecond line"),
                                 try run("m2", "morning", "uncertain", at: "2026-11-09T04:15:00.000Z"), try run("m1", "morning", "completed", at: "2026-11-08T04:15:00.000Z")]
        let found = try #require(Team.failure(failing, schedules: [radar, morning]))
        #expect(found.since == Self.instant("2026-11-09T04:15:00.000Z"))
        #expect(found.reason == "The model's limit ran out.")
        #expect(russian.failure(since: found.since, reason: found.reason, now: Self.now) == "Не получается с 9 ноября, 07:15: The model's limit ran out.")
        #expect(russian.failure(since: Self.instant("2026-11-10T04:15:00.000Z"), reason: nil, now: Self.now) == "Не получается с 07:15.")
        #expect(russian.failure(since: nil, reason: nil, now: Self.now) == "Последний запуск не получился.")
        // A backup that worked answers for its main schedule; a paused schedule alarms nobody.
        #expect(Team.failure(failing + [try run("b1", "backup", "completed", at: "2026-11-10T05:15:00.000Z")], schedules: [radar, morning, backup]) == nil)
        #expect(Team.failure(failing, schedules: [radar, try schedule("morning", cron: "15 4 * * *", next: "2026-11-11T04:15:00.000Z", enabled: false)]) == nil)
    }

    @Test func anEditionIsHeadedByItsOwnNameOrByTheReadersWord() {
        let words = NewsWords(language: .russian, calendar: Self.moscow)
        var page = NewsDesk.Page(date: "2026-11-10", isToday: true)
        page.editionDate = "2026-11-10"
        #expect(words.editionTitle(page, named: nil, now: Self.now) == "Выпуск")
        #expect(words.editionTitle(page, named: NewsEditionTitle(date: "2026-11-10", title: "Стартапы за день"), now: Self.now) == "Стартапы за день")
        // Yesterday's name is not today's edition's.
        #expect(words.editionTitle(page, named: NewsEditionTitle(date: "2026-11-09", title: "Стартапы за день"), now: Self.now) == "Выпуск")
        page.editionDate = "2026-11-08"
        #expect(words.editionTitle(page, named: NewsEditionTitle(date: "2026-11-08", title: "Стартапы за день"), now: Self.now) == "Выпуск за 8 ноября")
    }

    // MARK: The home's shelf

    private func route(_ profile: String, news: Bool = false) -> ReaderRoute {
        ReaderRoute(connectionID: "home", kind: news ? .news(profile) : .employee(profile), title: profile)
    }
    private func account(_ windows: String) throws -> ManagedCodexAccount {
        try JSONDecoder().decode(ManagedCodexAccount.self, from: Data("""
        {"id":"main","name":"Main","activeRuns":0,"loginPending":false,"account":{"connected":true,"email":"reader@example.com","managed":true,"planType":"plus"},
         "usage":{"checkedAt":"2026-11-10T11:00:00.000Z","ordinaryUsageAllowed":true,"unavailable":false,"windows":[\(windows)]}}
        """.utf8))
    }

    @Test func theShelfShowsOnlyWhatIsRealInOneOrder() throws {
        let story = try JSONDecoder().decode(NewsStory.self, from: Data(#"{"id":"s1","edition":null,"rank":null,"section":"Models","status":"Out","title":"Maple opens its weights","summary":"Three sizes.","body":"B","view":null,"check":null,"verification":"V","eventAt":null,"change":null,"sources":[],"image":"https://example.com/p.png"}"#.utf8))
        let desk = Shelf.Desk(route: route("news", news: true), name: "News", appearance: AgentAppearance(kind: "coil", tone: 4), story: story, host: "example.com", unseen: 5)
        let silent = Shelf.Desk(route: route("quiet", news: true), name: "Quiet", appearance: AgentAppearance(kind: "knot", tone: 3), story: nil, host: nil, unseen: 0)
        let next = (route: route("coach"), name: "Coach", at: Self.instant("2026-11-11T03:45:00.000Z"))
        let limits = [try account(#"{"name":"5h","remainingPercent":81,"windowDurationMins":300,"resetsAt":1},{"name":"weekly","remainingPercent":32,"windowDurationMins":10080,"resetsAt":1}"#)]
        let picture = ShelfTile.result(route: route("cook"), name: "Cook", appearance: AgentAppearance(kind: "pillow", tone: 7), text: "Dinner", file: file)
        // A desk without a story and a Home without activity put nothing on the shelf.
        #expect(Shelf.tiles(desks: [silent], boards: [], next: nil).isEmpty)
        // A tile holds an answer. The limit is a figure at the foot of the home and on Statistics, never a gauge here.
        let tiles = Shelf.tiles(desks: [desk, silent], boards: [], next: next, results: [picture])
        #expect(tiles.map(\.id) == ["desk:" + desk.route.id, "next", "result:" + route("cook").id])
        #expect(tiles.map(\.place) == [.reader(desk.route), .reader(next.route), .reader(route("cook"))])
        // The fullest week decides the figure; without a weekly window, the fullest of the others.
        #expect(Shelf.limit(limits)?.weekly == true)
        #expect(abs((Shelf.limit(limits)?.used ?? 0) - 0.68) < 0.001)
        let short = try #require(Shelf.limit([try account(#"{"name":"5h","remainingPercent":81,"windowDurationMins":300,"resetsAt":1}"#)]))
        #expect(!short.weekly && abs(short.used - 0.19) < 0.001)
        #expect(Shelf.limit([try account("")]) == nil)
    }

    @Test func upToThreeTilesStandInOneRowAndMoreMakeTwo() {
        let tile = { (name: String) in ShelfTile.next(route: self.route(name), name: name, at: Self.now) }
        let rows = { (count: Int) in Shelf.columns((0..<count).map { tile("t" + String($0)) }).map(\.count) }
        #expect(Shelf.columns([]).isEmpty)
        #expect(rows(3) == [1, 1, 1])
        #expect(rows(4) == [2, 2])
        #expect(rows(7) == [2, 2, 2, 1])
        // The first half is the top row, in order.
        let five = ["a", "b", "c", "d", "e"].map { ShelfTile.result(route: self.route($0), name: $0, appearance: AgentAppearance(kind: "coil", tone: 1), text: $0, file: self.file) }
        #expect(Shelf.columns(five).map { $0.first?.id } == ["a", "b", "c"].map { "result:" + self.route($0).id })
    }

    private var file: ChatAttachment { ChatAttachment(id: "0a0a0a0a-1111-4222-8333-444444444444", conversationId: "c", name: "plate.png", mimeType: "image/png", size: 10) }

    @Test func anAnswerOfTheLastDayWithAPictureGetsATileAndADeskDoesNot() throws {
        let picture = #","previewImage":{"id":"0a0a0a0a-1111-4222-8333-444444444444","conversationId":"c","name":"plate.png","mimeType":"image/png","size":10}"#
        let fresh = try profile("cook", "Cook", #","preview":"**Dinner** is pasta","previewAt":"2026-11-10T08:00:00.000Z""# + picture)
        let old = try profile("painter", "Painter", #","preview":"A poster","previewAt":"2026-11-08T08:00:00.000Z""# + picture)
        let desk = try profile("news", "News", #","news":true,"preview":"A story","previewAt":"2026-11-10T08:00:00.000Z""# + picture)
        let words = try profile("writer", "Writer", #","preview":"Only words","previewAt":"2026-11-10T08:00:00.000Z""#)
        let notes = try profile("clerk", "Clerk", #","preview":"A report","previewAt":"2026-11-10T08:00:00.000Z","previewImage":{"id":"0a0a0a0a-1111-4222-8333-444444444444","conversationId":"c","name":"report.pdf","mimeType":"application/pdf","size":10}"#)
        let team = [fresh, old, desk, words, notes].map { (route: route($0.id, news: $0.news == true), profile: $0) }
        #expect(Shelf.results(team, now: Self.now) == [.result(route: route("cook"), name: "Cook", appearance: fresh.resolvedAppearance, text: "Dinner is pasta", file: file)])
        // An older Home sends no picture at all.
        #expect(try profile("p", "Plain").previewImage == nil)
    }

    @Test func theNearestRunAheadIsTheOneOnTheShelfAndItsDayIsAWord() throws {
        let late = try profile("a", "Late", #","nextRunAt":"2026-11-11T15:30:00.000Z""#), soon = try profile("b", "Soon", #","nextRunAt":"2026-11-10T15:30:00.000Z""#)
        let past = try profile("c", "Past", #","nextRunAt":"2026-11-10T09:00:00.000Z""#), none = try profile("d", "None")
        let next = try #require(Shelf.next([late, soon, past, none].map { (route: route($0.id), profile: $0) }, now: Self.now))
        #expect(next.name == "Soon" && next.route == route("b"))
        #expect(Shelf.next([(route: route("c"), profile: past), (route: route("d"), profile: none)], now: Self.now) == nil)
        #expect(russian.day(next.at, now: Self.now) == "сегодня")
        #expect(russian.day(Self.instant("2026-11-11T03:45:00.000Z"), now: Self.now) == "завтра")
        #expect(russian.day(Self.instant("2026-11-14T03:45:00.000Z"), now: Self.now) == "14 нояб.")
        #expect(english.day(Self.instant("2026-11-11T03:45:00.000Z"), now: Self.now) == "tomorrow")
    }

    @Test func aTitleThatOpensWithANameShowsTheNameFirstAndAHeadlineDoesNot() {
        let boat = Shelf.named("Лодка: аренда катеров на час, без капитана")
        #expect(boat?.name == "Лодка" && boat?.rest == "аренда катеров на час, без капитана")
        #expect(Shelf.named("Co-Review: the whole repository as one review")?.name == "Co-Review")
        // An ordinary headline, a clock, a clause before the colon and a lone letter are not names.
        #expect(Shelf.named("«Северный мост» открыл веса модели «Клён 3»") == nil)
        #expect(Shelf.named("Встреча в 12:30 на причале") == nil)
        #expect(Shelf.named("Сегодня, в полдень: совет собрался снова") == nil)
        #expect(Shelf.named("Совет по открытым моделям предложил: метка для текста") == nil)
        #expect(Shelf.named("A: b") == nil)
        #expect(Shelf.named("Лодка: ") == nil)
        // A rumour's mark is not a name.
        #expect(Shelf.named("Слух: «Северный мост» готовит версию для телефонов") == nil)
        // The small line under a name ends between words.
        #expect(Shelf.clipped("аренда катеров на час, без капитана", to: 38) == "аренда катеров на час, без капитана")
        #expect(Shelf.clipped("агент сам чинит ошибки в проекте и перезапускает проверку", to: 38) == "агент сам чинит ошибки в проекте и…")
        #expect(Shelf.clipped("безостановочноедлинноесловобезпробеловвообще", to: 10) == "безостанов…")
    }

    @Test func aPreviewOfSeveralLinesIsPlainWords() {
        #expect(Team.plain("**Ten words** are ready.\n\n1. itinerary\n2. [layover](<https://example.com/a_(b)>)") == "Ten words are ready. itinerary layover")
        #expect(Team.plain("") == "")
    }

    // MARK: What this device has read

    @Test func anEmployeeStartsReadAndANewAnswerIsNewUntilItsPageIsOnScreen() throws {
        let suite = "OpenStrudel.team." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        defaults.set("http://127.0.0.1:57712", forKey: "openstrudel.homeURL")
        let client = HomeClient(defaults: defaults, connectionID: "team", credentialReader: { _, _ in nil }, credentialWriter: { _, _ in })
        let marks = TeamReadMarks(defaults: defaults)
        // A catalogue saved by an earlier version knows no times: it is not a first meeting, and nothing in it is news.
        let saved = try profile("p1", "Scout", #","preview":"Old""#)
        marks.meet([saved], on: client)
        #expect(marks.seen.isEmpty && !marks.isUnread(saved, on: client))
        // The first catalogue of an updated Home: everything written so far counts as seen.
        let first = try profile("p1", "Scout", #","preview":"Old","previewAt":"2026-11-10T09:00:00.000Z","working":false"#)
        let silent = try profile("p2", "Baker", #","working":false"#)
        #expect(!marks.isUnread(first, on: client))
        marks.meet([first, silent], on: client)
        #expect(!marks.isUnread(first, on: client) && !marks.isUnread(silent, on: client))
        // A later answer is new, also an employee's very first one, and also after a relaunch.
        let next = try profile("p1", "Scout", #","preview":"New","previewAt":"2026-11-10T10:00:00.000Z","working":false"#)
        let spoke = try profile("p2", "Baker", #","preview":"Hello","previewAt":"2026-11-10T10:05:00.000Z","working":false"#)
        marks.meet([next, spoke], on: client)
        #expect(marks.isUnread(next, on: client) && marks.isUnread(spoke, on: client))
        #expect(TeamReadMarks(defaults: defaults).isUnread(next, on: client))
        // Its page on screen reads it; an older answer never unreads it.
        marks.see(next, on: client)
        #expect(!marks.isUnread(next, on: client) && marks.isUnread(spoke, on: client))
        marks.see(first, on: client)
        #expect(!marks.isUnread(next, on: client))
        #expect(!TeamReadMarks(defaults: defaults).isUnread(next, on: client))
    }

    // MARK: How this device arranges the list

    @Test func pinsAndTheChosenHomeAreKeptOnTheDevice() throws {
        let suite = "OpenStrudel.team." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        defaults.set("http://127.0.0.1:57712", forKey: "openstrudel.homeURL")
        let client = HomeClient(defaults: defaults, connectionID: "team", credentialReader: { _, _ in nil }, credentialWriter: { _, _ in })
        let arrangement = TeamArrangement(defaults: defaults)
        let scout = try profile("p1", "Scout"), baker = try profile("p2", "Baker")
        #expect(!arrangement.isPinned(scout, on: client))
        arrangement.setPinned(true, profile: scout, on: client)
        #expect(arrangement.isPinned(scout, on: client) && !arrangement.isPinned(baker, on: client))
        // After a relaunch too, and given back the same way.
        #expect(TeamArrangement(defaults: defaults).isPinned(scout, on: client))
        arrangement.setPinned(false, profile: scout, on: client)
        #expect(!TeamArrangement(defaults: defaults).isPinned(scout, on: client))
        // Every Home is listed until one is chosen; the choice outlives a relaunch and is given back the same way.
        #expect(arrangement.home == nil)
        arrangement.show(home: "cabin")
        #expect(TeamArrangement(defaults: defaults).home == "cabin")
        arrangement.show(home: nil)
        #expect(TeamArrangement(defaults: defaults).home == nil)
    }

    @Test func aRowSaysWhatIsNowTrueAndOtherwiseACleanExcerpt() throws {
        // The employee's own line leads; a Home that sends none, or an empty one, leaves the answer's first words.
        let told = try profile("1", "Продажи", #","preview":"**Отчёт за среду**\n1. Клён","outcome":"Клён оплатил. День 14.""#)
        #expect(told.previewText == "Клён оплатил. День 14.")
        #expect(try profile("2", "Продажи", #","preview":"**Отчёт за среду**\n1. Клён","outcome":null"#).previewText == "Отчёт за среду")
        #expect(try profile("3", "Продажи", #","preview":"**Отчёт за среду**","outcome":"  ""#).previewText == "Отчёт за среду")
        // Never markup, and never a block of a tool's output.
        #expect(Team.line("```json\n{\"sent\":3}\n```\n**Готово.** Три письма ушли.") == "Готово. Три письма ушли.")
        #expect(Team.line("***\n---\n**Продажи · среда**") == "Продажи · среда")
        #expect(Team.line("Вывод команды: ```text\nCWD=/data\n```\nДальше слова.") == "Вывод команды:")
        #expect(Team.line("Команда `ls` и ```одна строка``` целиком") == "Команда ls и")
        #expect(Team.line("```\nтолько код\n```") == "")
    }

    @Test func theOneListLeadsWithWhatWaitsThenWhoWorksThenTheLatestAnswer() throws {
        func member(_ id: String, _ name: String, _ extra: String = "", home: String = "home") throws -> TeamMember {
            TeamMember(profile: try profile(id, name, extra), route: ReaderRoute(connectionID: home, kind: .employee(id), title: name))
        }
        let old = try member("1", "Архив", #","previewAt":"2026-11-01T09:00:00.000Z","working":false"#)
        let fresh = try member("2", "Юрист", #","previewAt":"2026-11-10T09:00:00.000Z","working":false"#)
        let busy = try member("3", "Продажи", #","previewAt":"2026-11-02T09:00:00.000Z","working":true"#, home: "cabin")
        let asked = try member("4", "Бухгалтер", #","previewAt":"2026-10-30T09:00:00.000Z","working":false"#, home: "cabin")
        let silent = try member("5", "Новый")
        let order = { (rows: [TeamMember], waiting: Set<String>) in rows.sorted { Team.comesFirst($0, $1, waiting: waiting) }.map(\.profile.name) }
        #expect(order([old, silent, fresh, busy, asked], [asked.id]) == ["Бухгалтер", "Продажи", "Юрист", "Архив", "Новый"])
        // With nothing waiting and nobody at work the list is simply the latest answers first, whichever Home they are from.
        #expect(order([old, asked, fresh], []) == ["Юрист", "Архив", "Бухгалтер"])
        // Equal times fall back to the names, so two rows never trade places between two polls.
        let twin = try member("6", "Аналитик", #","previewAt":"2026-11-10T09:00:00.000Z","working":false"#)
        #expect(order([fresh, twin], []) == ["Аналитик", "Юрист"] && order([twin, fresh], []) == ["Аналитик", "Юрист"])
    }

    @Test func thePinnedOnesKeepTheOneOrderOfEveryList() throws {
        let rows = [try profile("3", "Тренер"), try profile("2", "News", #","news":true"#), try profile("1", "Репетитор"), try profile("4", "репетитор")]
        let russian = Locale(identifier: "ru")
        #expect(rows.sorted { Team.precedes($0, $1, locale: russian) }.map(\.id) == ["2", "1", "4", "3"])
        #expect(Team.order(rows, locale: russian).map(\.id) == ["2", "1", "4", "3"])
    }

    @Test func anEmployeeQuietForTwoWeeksIsTuckedAwayUnlessSomethingIsGoingOn() throws {
        let now = Self.now
        let recent = try profile("1", "Sales", #","previewAt":"2026-11-09T09:00:00.000Z","working":false"#)
        let old = try profile("2", "Архив", #","previewAt":"2026-10-20T09:00:00.000Z","working":false"#)
        let never = try profile("3", "Новый")
        let young = try JSONDecoder().decode(EmployeeProfile.self, from: Data(#"{"id":"4","name":"Вчерашний","instructions":"","capabilities":[],"model":null,"tokenLimit":null,"createdAt":"2026-11-09T00:00:00.000Z"}"#.utf8))
        #expect(!Team.isQuiet(recent, now: now) && Team.isQuiet(old, now: now))
        // One that has never answered is judged by the day it was made: made in January it is quiet, made yesterday it is not.
        #expect(Team.isQuiet(never, now: now) && !Team.isQuiet(young, now: now))
        // At work or failing, it is never out of sight.
        #expect(!Team.isQuiet(try profile("5", "Работает", #","previewAt":"2026-10-20T09:00:00.000Z","working":true"#), now: now))
        #expect(!Team.isQuiet(try profile("6", "Сломан", #","previewAt":"2026-10-20T09:00:00.000Z","failing":true"#), now: now))
    }

    @Test func aFailingEmployeeSaysWhyWhenItsHomeTells() throws {
        let suite = "OpenStrudel.team." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        defaults.set("http://127.0.0.1:57712", forKey: "openstrudel.homeURL")
        let client = HomeClient(defaults: defaults, connectionID: "team", credentialReader: { _, _ in nil }, credentialWriter: { _, _ in })
        func listed(_ id: String, profile: String?, failure: String?) throws -> HomeSchedule {
            try JSONDecoder().decode(HomeSchedule.self, from: Data("""
            {"id":"\(id)","conversationId":"c","name":"Run \(id)","prompt":"Check","cron":"30 18 * * *","timezone":"UTC","enabled":true,"nextRunAt":"2026-11-11T18:30:00.000Z","telegramChatId":null,
             "chat":{"title":"Chat","employee":null,"kind":"employee"},"week":{"runs":3,"quiet":0,"failed":2,"tokens":0,"costUsd":null}\(profile.map { ",\"profileId\":\"\($0)\"" } ?? "")\(failure.map { ",\"failure\":" + $0 } ?? "")}
            """.utf8))
        }
        let failures = TeamFailures()
        failures.take([
            try listed("a", profile: "tutor", failure: #"{"since":"2026-11-09T15:30:00.000Z","reason":"Закончился лимит модели."}"#),
            try listed("b", profile: "tutor", failure: #"{"since":"2026-11-10T06:00:00.000Z","reason":"Чат доставки изменился"}"#),
            try listed("c", profile: "coach", failure: nil),
            try listed("d", profile: nil, failure: #"{"since":"2026-11-10T04:30:00.000Z","reason":null}"#),
        ], from: client)
        // The schedule that began failing last speaks for its employee; the main assistant's own schedules too.
        #expect(failures.failure("tutor", on: client)?.reason == "Чат доставки изменился")
        #expect(failures.failure("coach", on: client) == nil)
        #expect(failures.failure(nil, on: client) == TeamFailures.Failure(since: Self.instant("2026-11-10T04:30:00.000Z"), reason: nil))
        // An older Home says nothing about failures, and what it said before is forgotten when it stops failing.
        failures.take([try listed("a", profile: "tutor", failure: nil)], from: client)
        #expect(failures.known.isEmpty)
    }
}
