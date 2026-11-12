import Foundation

/// One employee as the team list shows it: where it lives and the page its row opens.
struct TeamMember: Identifiable, Equatable {
    let profile: EmployeeProfile
    /// A News desk opens its reader; any other employee its page.
    let route: ReaderRoute
    var id: String { route.id }
    var isDesk: Bool { profile.news == true }
}

/// What a row's character and second line say about its employee. One thing at a time, in this order; what is new
/// to the reader is marked beside it whichever it is.
enum TeamRowState: Equatable {
    /// Its device is out of reach, so nothing below is known.
    case offline
    case working
    case failing
    case resting
}

enum Team {
    /// News desks first, then by name. The id settles equal names, so rows never trade places between two polls.
    static func order(_ profiles: [EmployeeProfile], locale: Locale = L10n.locale) -> [EmployeeProfile] {
        profiles.sorted { precedes($0, $1, locale: locale) }
    }

    /// The one order of every list of employees, also of the pinned ones that come from several Homes.
    static func precedes(_ first: EmployeeProfile, _ second: EmployeeProfile, locale: Locale = L10n.locale) -> Bool {
        if (first.news == true) != (second.news == true) { return first.news == true }
        let names = first.name.compare(second.name, options: [.caseInsensitive, .numeric], range: nil, locale: locale)
        return names == .orderedSame ? first.id < second.id : names == .orderedAscending
    }

    /// The order of the one list across Homes: whoever has something waiting for the owner, then whoever is working,
    /// then the latest answer first. Names settle the rest, so two rows never trade places without a reason.
    static func comesFirst(_ first: TeamMember, _ second: TeamMember, waiting: Set<String> = []) -> Bool {
        func rank(_ member: TeamMember) -> Int { waiting.contains(member.id) ? 0 : member.profile.working == true ? 1 : 2 }
        if rank(first) != rank(second) { return rank(first) < rank(second) }
        let times = (date(first.profile.previewAt), date(second.profile.previewAt))
        if times.0 != times.1 { return (times.0 ?? .distantPast) > (times.1 ?? .distantPast) }
        return precedes(first.profile, second.profile) || (first.profile.id == second.profile.id && first.id < second.id)
    }

    static func members(_ profiles: [EmployeeProfile], on connection: String) -> [TeamMember] {
        order(profiles).map { TeamMember(profile: $0, route: ReaderRoute(connectionID: connection, kind: $0.news == true ? .news($0.id) : .employee($0.id), title: $0.name)) }
    }

    static func state(_ profile: EmployeeProfile, offline: Bool) -> TeamRowState {
        offline ? .offline : profile.working == true ? .working : profile.failing == true ? .failing : .resting
    }

    /// Nothing from it for two weeks, and nothing going on now: its latest answer, or the day it was made when it has
    /// never answered. The home tucks such employees under one line so the ones at work are not lost among them.
    static func isQuiet(_ profile: EmployeeProfile, now: Date = .now) -> Bool {
        guard profile.working != true, profile.failing != true, let last = date(profile.previewAt) ?? date(profile.createdAt) else { return false }
        return now.timeIntervalSince(last) > 14 * 86_400
    }

    /// A message as one plain line: its first line that says something, without its Markdown. A block of code or of
    /// a tool's output is passed over, and so is a line of nothing but marks; a line that opens one ends before it.
    static func line(_ markdown: String?) -> String {
        var fenced = false
        for line in (markdown ?? "").split(whereSeparator: \.isNewline) {
            var source = String(line)
            if source.trimmingCharacters(in: .whitespaces).hasPrefix("```") { fenced.toggle(); continue }
            if fenced { continue }
            if let fence = source.range(of: "```") {
                // An odd number of fences on the line leaves the block open below it.
                fenced = source.components(separatedBy: "```").count % 2 == 0
                source = String(source[..<fence.lowerBound])
            }
            let plain = String(((try? AttributedString(markdown: source)) ?? AttributedString(source)).characters).trimmingCharacters(in: .whitespaces)
            if plain.contains(where: { $0.isLetter || $0.isNumber }) { return plain }
        }
        return ""
    }

    /// A message as plain words for a preview of a few lines: every line that says something, without its Markdown.
    static func plain(_ markdown: String) -> String {
        markdown.split(whereSeparator: \.isNewline).map { line($0.description) }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(iso)) ?? (try? Date.ISO8601FormatStyle().parse(iso))
    }

    /// Since when an employee's runs have not worked, and why: the first failure after the last run that did work, with
    /// what the latest failure said. `runs` are any of the employee's recent runs; a backup answers for its main schedule.
    static func failure(_ runs: [ScheduleRun], schedules: [ChatSchedule]) -> (since: Date, reason: String?)? {
        var streaks: [(since: Date, latest: Date, reason: String?)] = []
        let enabled = schedules.filter(\.enabled)
        for main in Set(enabled.map { $0.backupOf ?? $0.id }) {
            let group = Set(enabled.filter { ($0.backupOf ?? $0.id) == main }.map(\.id))
            let finished = runs.compactMap { run -> (at: Date, run: ScheduleRun)? in
                guard let schedule = run.scheduleId, group.contains(schedule), ["completed", "quiet", "failed", "uncertain"].contains(run.status),
                      let at = date(run.scheduledFor) else { return nil }
                return (at, run)
            }.sorted { $0.at > $1.at }
            let failed = finished.prefix { $0.run.status == "failed" || $0.run.status == "uncertain" }
            guard let latest = failed.first, let first = failed.last else { continue }
            let reason = latest.run.error?.split(whereSeparator: \.isNewline).first.map { $0.trimmingCharacters(in: .whitespaces) }
            streaks.append((first.at, latest.at, reason?.isEmpty == false ? reason : nil))
        }
        return streaks.max { $0.latest < $1.latest }.map { ($0.since, $0.reason) }
    }
}

/// A place the home opens: the chat, someone's page, or one of the pages behind a tile.
enum HomePlace: Hashable {
    case chat
    /// An employee's page, a desk's reader, another Home's assistant, a Telegram chat or an archive.
    case reader(ReaderRoute)
    case insights, progress, statistics
    /// The answers to a chat's daily polls.
    case checkIns
    /// One result or exception, opened from Insights.
    case insight(HomeActivity.Insight)
}

/// One tile of the home's shelf. A tile exists only when a Home has something real to put on it.
enum ShelfTile: Identifiable, Equatable {
    /// A desk's lead story, with its picture when it has one.
    case desk(route: ReaderRoute, name: String, appearance: AgentAppearance, title: String, image: String?, host: String?, unseen: Int)
    /// The nearest scheduled run.
    case next(route: ReaderRoute, name: String, at: Date)
    /// The latest day of a chat's daily polls.
    case checkIns(CheckInBoard)
    /// An employee's answer of the last day that came with a picture.
    case result(route: ReaderRoute, name: String, appearance: AgentAppearance, text: String, file: ChatAttachment)

    var id: String {
        switch self {
        case .desk(let route, _, _, _, _, _, _): "desk:" + route.id
        case .checkIns: "checkIns"
        case .next: "next"
        case .result(let route, _, _, _, _): "result:" + route.id
        }
    }
    var place: HomePlace {
        switch self {
        case .desk(let route, _, _, _, _, _, _), .next(let route, _, _), .result(let route, _, _, _, _): .reader(route)
        case .checkIns: .checkIns
        }
    }
}

enum Shelf {
    struct Desk { let route: ReaderRoute; let name: String; let appearance: AgentAppearance; let story: NewsStory?; let host: String?; let unseen: Int }

    /// Today's work in the order the shelf shows it: each desk's lead, the day's answers to a chat's polls, the next
    /// run, then the answers that came with a picture. A tile holds an answer; what waits for the owner leads the
    /// home as a card instead, and the gauges live on the Statistics page.
    /// `boards` are the answered polls of every Home in sight (`CheckInHomes`), the chat's own Home first.
    static func tiles(desks: [Desk], boards: [CheckInBoard], next: (route: ReaderRoute, name: String, at: Date)?, results: [ShelfTile] = []) -> [ShelfTile] {
        var tiles = desks.compactMap { desk in
            desk.story.map { ShelfTile.desk(route: desk.route, name: desk.name, appearance: desk.appearance, title: $0.title, image: $0.image, host: desk.host, unseen: desk.unseen) }
        }
        // A board with no answer in sight yet has nothing to show.
        if let board = boards.first(where: { $0.latestDay != nil }) { tiles.append(.checkIns(board)) }
        if let next { tiles.append(.next(route: next.route, name: next.name, at: next.at)) }
        return tiles + results
    }

    /// The employees whose latest answer is from the last day and came with a picture kept on their Home. A desk shows
    /// its story instead.
    static func results(_ team: [(route: ReaderRoute, profile: EmployeeProfile)], now: Date = .now) -> [ShelfTile] {
        team.compactMap { row in
            guard row.profile.news != true, let file = row.profile.previewImage, file.mimeType.hasPrefix("image/"), ChatAttachment.isHomeFileID(file.id),
                  let at = Team.date(row.profile.previewAt), now.timeIntervalSince(at) < 86_400 else { return nil }
            return .result(route: row.route, name: row.profile.name, appearance: row.profile.resolvedAppearance, text: row.profile.previewText, file: file)
        }
    }

    /// «Имя: что это»: a title that opens with a short name before a colon, the way a desk of launches writes them.
    /// The name stands large on its tile and the rest small under it. Nil for an ordinary headline.
    static func named(_ title: String) -> (name: String, rest: String)? {
        guard let colon = title.range(of: ": ") else { return nil }
        let name = title[..<colon.lowerBound].trimmingCharacters(in: .whitespaces), rest = title[colon.upperBound...].trimmingCharacters(in: .whitespaces)
        guard (2...24).contains(name.count), name.split(separator: " ").count <= 3, !rest.isEmpty, name.rangeOfCharacter(from: CharacterSet(charactersIn: ".!?,;")) == nil,
              // «Слух: …» marks a rumour; what follows is the headline, not what a thing named Слух is.
              !["слух", "rumor", "rumour"].contains(name.lowercased()) else { return nil }
        return (name, rest)
    }

    /// Words cut to a length between words, with an ellipsis, so a short line under a name never ends mid-word.
    static func clipped(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        let head = text.prefix(limit)
        let cut = head.lastIndex(of: " ").map { head[..<$0] } ?? head
        return cut.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:—-")) + "…"
    }

    /// The fullest window the subscriptions report: the week's when there is one, otherwise any.
    static func limit(_ accounts: [ManagedCodexAccount]) -> (used: Double, weekly: Bool)? {
        let windows = accounts.flatMap(\.usage.windows).compactMap { window in window.remainingPercent.map { (used: min(1, max(0, 1 - $0 / 100)), weekly: window.windowDurationMins == 10080) } }
        let weekly = windows.filter(\.weekly)
        return (weekly.isEmpty ? windows : weekly).max { $0.used < $1.used }
    }

    /// The nearest run among the employees in sight that have one ahead.
    static func next(_ team: [(route: ReaderRoute, profile: EmployeeProfile)], now: Date = .now) -> (route: ReaderRoute, name: String, at: Date)? {
        team.compactMap { row in Team.date(row.profile.nextRunAt).flatMap { $0 > now ? (route: row.route, name: row.profile.name, at: $0) : nil } }.min { $0.at < $1.at }
    }

    /// The shelf as columns: one row of tiles up to three, two rows beyond, the first half on top.
    static func columns(_ tiles: [ShelfTile]) -> [[ShelfTile]] {
        guard tiles.count > 3 else { return tiles.map { [$0] } }
        let top = (tiles.count + 1) / 2
        return (0..<top).map { index in [tiles[index]] + (top + index < tiles.count ? [tiles[top + index]] : []) }
    }
}

extension DeviceLibrary {
    /// The Homes of the team list: the chat's first, then the others in the order they were connected.
    var teamHomes: [HomeClient] { [primary] + visibleClients.filter { $0 !== primary } }
    /// A Home's employees as the team list shows them, without the ones hidden on this device.
    func team(on client: HomeClient) -> [TeamMember] { Team.members(visibleProfiles(on: client), on: client.id) }
    /// Every row of the team list, in its order.
    var team: [(source: HomeClient, member: TeamMember)] { teamHomes.flatMap { source in team(on: source).map { (source, $0) } } }

    /// The team as one list across the Homes in sight: the pinned employees in their own steady order, then everyone
    /// with something waiting, at work or with an answer to show, then whoever has said nothing for two weeks. With
    /// one Home chosen only its employees are listed.
    func teamList(_ arrangement: TeamArrangement, waiting: Set<String> = [], quiet: (TeamMember, HomeClient) -> Bool) -> TeamList {
        let chosen = shownHome(arrangement)
        let rows = team.filter { chosen == nil || $0.source === chosen }
        let pinned = rows.filter { arrangement.isPinned($0.member.profile, on: $0.source) }
        let rest = rows.filter { !arrangement.isPinned($0.member.profile, on: $0.source) }
        let silent = rest.filter { !waiting.contains($0.member.id) && quiet($0.member, $0.source) }
        return TeamList(pinned: pinned.sorted { Team.precedes($0.member.profile, $1.member.profile) },
                        live: rest.filter { row in !silent.contains { $0.member.id == row.member.id } }.sorted { Team.comesFirst($0.member, $1.member, waiting: waiting) },
                        quiet: silent.sorted { Team.precedes($0.member.profile, $1.member.profile) })
    }
}

extension DeviceLibrary {
    /// The one Home whose employees are listed, when several are connected and one was chosen. A Home that has left
    /// takes its choice with it.
    func shownHome(_ arrangement: TeamArrangement) -> HomeClient? {
        teamHomes.count > 1 ? teamHomes.first { $0.id == arrangement.home } : nil
    }
}

/// The rows of the home's one team list.
struct TeamList {
    typealias Row = (source: HomeClient, member: TeamMember)
    var pinned: [Row] = []
    var live: [Row] = []
    var quiet: [Row] = []
    /// Every row in sight without opening «Давно молчат», in the list's order.
    var shown: [Row] { pinned + live }
}

/// Why an employee's schedule is failing, as its Home's owner may read it: since when, and the first line of what the
/// latest run said. A Home that does not say, or does not let this device ask, leaves the row with «Не получилось».
@MainActor
final class TeamFailures: ObservableObject {
    struct Failure: Equatable { let since: Date?; let reason: String? }
    @Published private(set) var known: [String: Failure] = [:]

    static func key(_ profileID: String?, on client: HomeClient) -> String { client.catalogueIdentity + ":" + (profileID ?? "main") }
    func failure(_ profileID: String?, on client: HomeClient) -> Failure? { known[Self.key(profileID, on: client)] }

    /// Replaces what is known of one Home with its schedules' latest word.
    func take(_ schedules: [HomeSchedule], from client: HomeClient) {
        let prefix = client.catalogueIdentity + ":"
        var next = known.filter { !$0.key.hasPrefix(prefix) }
        // The schedule that began failing last speaks for its employee.
        for schedule in schedules.sorted(by: { ($0.failure?.since ?? "") < ($1.failure?.since ?? "") }) {
            guard let failure = schedule.failure else { continue }
            next[Self.key(schedule.profileId, on: client)] = Failure(since: Team.date(failure.since), reason: failure.reason)
        }
        if next != known { known = next }
    }
}

/// How this device arranges the team list: who is pinned to its top, and whether one Home alone is in sight. Several
/// Homes make one list; pins keep the few employees a person opens every day in reach, and a Home's name is a word
/// on a row and a filter over the list. Kept on the device, like what it has read.
@MainActor
final class TeamArrangement: ObservableObject {
    /// Pinned employees, each by its Home's catalogue and its own id.
    @Published private(set) var pinned: Set<String>
    /// The one Home whose employees are listed, by connection. Nil lists every Home's.
    @Published private(set) var home: String?
    private let defaults: UserDefaults
    private static let pins = "openstrudel.team.pinned", shown = "openstrudel.team.home"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        pinned = Set(defaults.stringArray(forKey: Self.pins) ?? [])
        home = defaults.string(forKey: Self.shown)
    }

    static func key(_ profile: EmployeeProfile, on client: HomeClient) -> String { client.catalogueIdentity + ":" + profile.id }
    func isPinned(_ profile: EmployeeProfile, on client: HomeClient) -> Bool { pinned.contains(Self.key(profile, on: client)) }
    func setPinned(_ pin: Bool, profile: EmployeeProfile, on client: HomeClient) { setPinned(pin, key: Self.key(profile, on: client)) }

    func setPinned(_ pin: Bool, key: String) {
        guard pinned.contains(key) != pin else { return }
        if pin { pinned.insert(key) } else { pinned.remove(key) }
        defaults.set(pinned.sorted(), forKey: Self.pins)
    }

    func show(home next: String?) {
        guard home != next else { return }
        home = next
        defaults.set(next, forKey: Self.shown)
    }
}

/// The times and rhythms of the team list, in the interface language.
struct TeamWords {
    var language: AppLanguage = L10n.shared.language
    var calendar: Calendar = .current

    private func callAsFunction(_ message: LocalizedMessage) -> String { L10n.text(message.key, arguments: message.arguments, language: language) }
    private var style: Date.FormatStyle { Date.FormatStyle(locale: language.locale, calendar: calendar, timeZone: calendar.timeZone) }
    func time(_ date: Date) -> String { date.formatted(style.hour().minute()) }

    /// How long ago, as short as a row's corner allows: «сейчас», «5 мин», «2 ч», «вчера», «пн», «3 нояб.»
    func ago(_ date: Date, now: Date = .now) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return self("сейчас") }
        if seconds < 3600 { return self("\(Int(seconds / 60)) мин") }
        if calendar.isDate(date, inSameDayAs: now) { return self("\(Int(seconds / 3600)) ч") }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 1 { return self("вчера") }
        // A row's corner is written small: «сб», «3 нояб.», as «вчера» is.
        if days < 7 { return date.formatted(style.weekday(.abbreviated)).lowercased(with: language.locale) }
        return date.formatted(calendar.isDate(date, equalTo: now, toGranularity: .year) ? style.day().month(.abbreviated) : style.day().month(.abbreviated).year()).lowercased(with: language.locale)
    }

    /// A moment as a person would say it: «сегодня в 18:30», «завтра в 06:45», «12 ноября в 07:15».
    func moment(_ date: Date, now: Date = .now) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return self("сегодня в \(time(date))") }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        if days == 1 { return self("завтра в \(time(date))") }
        if days == -1 { return self("вчера в \(time(date))") }
        let day = date.formatted(calendar.isDate(date, equalTo: now, toGranularity: .year) ? style.day().month(.wide) : style.day().month(.wide).year())
        return self("\(day) в \(time(date))")
    }

    /// The day alone, for a tile's small line: «сегодня», «завтра», «14 нояб.»
    func day(_ date: Date, now: Date = .now) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return self("сегодня") }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        return days == 1 ? self("завтра") : date.formatted(style.day().month(.abbreviated)).lowercased(with: language.locale)
    }

    /// «Следующий запуск завтра в 06:45»: what a row answers when the pointer rests on it.
    func nextRun(_ date: Date, now: Date = .now) -> String { self("Следующий запуск \(moment(date, now: now))") }

    /// How often a schedule runs, with its hour on this device's clock; nil when its cron says it no simpler than its next run does.
    func rhythm(_ schedule: ChatSchedule) -> String? {
        let fields = schedule.cron.split(separator: " ").map(String.init)
        guard fields.count == 5, let next = Team.date(schedule.nextRunAt) else { return nil }
        let every: (String) -> Int? = { field in field.hasPrefix("*/") ? Int(field.dropFirst(2)).flatMap { $0 > 1 ? $0 : nil } : nil }
        let always = Array(fields[2...]) == ["*", "*", "*"]
        if always, fields[1] == "*", let minutes = every(fields[0]) { return self("Раз в \(minutes) мин") }
        guard Int(fields[0]) != nil else { return nil }
        if always, fields[1] == "*" { return self("Каждый час") }
        if always, let hours = every(fields[1]) { return self("Раз в \(hours) ч") }
        guard Int(fields[1]) != nil, fields[2] == "*", fields[3] == "*" else { return nil }
        if fields[4] == "*" { return self("Каждый день в \(time(next))") }
        if fields[4] == "1-5" { return self("По будням в \(time(next))") }
        guard let day = Int(fields[4]), (0...7).contains(day) else { return nil }
        // The day is the next run's own on this device's calendar, which may differ from the schedule's across midnight.
        let names: [LocalizedMessage] = ["По воскресеньям", "По понедельникам", "По вторникам", "По средам", "По четвергам", "По пятницам", "По субботам"]
        return self("\(self(names[calendar.component(.weekday, from: next) - 1])) в \(time(next))")
    }

    /// The employee page's one line of rhythm: the nearest schedule in words and when it runs next, «Каждый день в
    /// 07:15 · следующий завтра». How many more there are, «и ещё 2», is kept apart: the page says it only when the
    /// line has room. Nil when it has no recurring schedule at all.
    func rhythm(_ schedules: [ChatSchedule], now: Date = .now) -> (line: String, more: String?)? {
        // A backup stands in for its main schedule; it is not a rhythm of its own.
        let recurring = schedules.filter { !$0.isOneTime && $0.backupOf == nil }
        let running = recurring.filter(\.enabled).compactMap { schedule in Team.date(schedule.nextRunAt).map { (schedule: schedule, next: $0) } }.sorted { $0.next < $1.next }
        guard let nearest = running.first else { return recurring.isEmpty ? nil : (self("Расписание на паузе"), nil) }
        let more = running.count > 1 ? self("и ещё \(running.count - 1)") : nil
        guard let rhythm = rhythm(nearest.schedule) else { return (nextRun(nearest.next, now: now), more) }
        // A rhythm that names its hour needs only the day of the next run; one that does not, the hour.
        let next = rhythm.hasSuffix(time(nearest.next)) ? self("следующий \(day(nearest.next, now: now))")
            : calendar.isDate(nearest.next, inSameDayAs: now) ? self("следующий в \(time(nearest.next))") : self("следующий \(moment(nearest.next, now: now))")
        return (rhythm + " · " + next, more)
    }

    /// «Не получается с 07:15: закончился лимит модели.» The day is named when it is not today.
    func failure(since: Date?, reason: String?, now: Date = .now) -> String {
        guard let since else { return self("Последний запуск не получился.") }
        let when = calendar.isDate(since, inSameDayAs: now) ? time(since)
            : since.formatted(calendar.isDate(since, equalTo: now, toGranularity: .year) ? style.day().month(.wide) : style.day().month(.wide).year()) + ", " + time(since)
        return reason.map { self("Не получается с \(when): \($0)") } ?? self("Не получается с \(when).")
    }
}

/// What this device has read of each employee: the time of the latest answer its page had on screen. Local to the
/// device, kept per Home and employee. A News desk counts its stories instead (`NewsReadState`).
@MainActor
final class TeamReadMarks: ObservableObject {
    @Published private(set) var seen: [String: String]
    private let defaults: UserDefaults
    private static let storage = "openstrudel.team.seen"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        seen = defaults.dictionary(forKey: Self.storage) as? [String: String] ?? [:]
    }

    private func key(_ profile: EmployeeProfile, on client: HomeClient) -> String { client.catalogueIdentity + ":" + profile.id }

    /// An employee this device meets for the first time starts read: nothing it wrote before is news here.
    /// Only a Home that lists its team's work is met: a catalogue saved by an earlier version knows no times, and
    /// reading it as "nothing written yet" would turn every old answer into news.
    func meet(_ profiles: [EmployeeProfile], on client: HomeClient) {
        var next = seen
        for profile in profiles where profile.working != nil && next[key(profile, on: client)] == nil { next[key(profile, on: client)] = profile.previewAt ?? "" }
        save(next)
    }

    func isUnread(_ profile: EmployeeProfile, on client: HomeClient) -> Bool {
        guard let latest = profile.previewAt, let mark = seen[key(profile, on: client)] else { return false }
        return latest > mark
    }

    /// The employee's page is on screen with its latest answer.
    func see(_ profile: EmployeeProfile, on client: HomeClient) {
        guard let latest = profile.previewAt, latest > seen[key(profile, on: client)] ?? "" else { return }
        var next = seen
        next[key(profile, on: client)] = latest
        save(next)
    }

    private func save(_ next: [String: String]) {
        guard next != seen else { return }
        seen = next
        defaults.set(next, forKey: Self.storage)
    }
}
