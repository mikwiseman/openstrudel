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
        profiles.sorted { first, second in
            if (first.news == true) != (second.news == true) { return first.news == true }
            let names = first.name.compare(second.name, options: [.caseInsensitive, .numeric], range: nil, locale: locale)
            return names == .orderedSame ? first.id < second.id : names == .orderedAscending
        }
    }

    static func members(_ profiles: [EmployeeProfile], on connection: String) -> [TeamMember] {
        order(profiles).map { TeamMember(profile: $0, route: ReaderRoute(connectionID: connection, kind: $0.news == true ? .news($0.id) : .employee($0.id), title: $0.name)) }
    }

    static func state(_ profile: EmployeeProfile, offline: Bool) -> TeamRowState {
        offline ? .offline : profile.working == true ? .working : profile.failing == true ? .failing : .resting
    }

    /// A message as one plain line: its first line that says something, without its Markdown.
    static func line(_ markdown: String?) -> String {
        for line in (markdown ?? "").split(whereSeparator: \.isNewline) {
            let source = String(line)
            let plain = String(((try? AttributedString(markdown: source)) ?? AttributedString(source)).characters).trimmingCharacters(in: .whitespaces)
            if !plain.isEmpty { return plain }
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
    /// One result or exception, opened from Insights.
    case insight(HomeActivity.Insight)
}

/// One tile of the home's shelf. A tile exists only when a Home has something real to put on it.
enum ShelfTile: Identifiable, Equatable {
    /// A desk's lead story, with its picture when it has one.
    case desk(route: ReaderRoute, name: String, appearance: AgentAppearance, title: String, image: String?, host: String?, unseen: Int)
    /// What needs the owner, then what was done.
    case important(open: [String], done: [String])
    /// The nearest scheduled run.
    case next(route: ReaderRoute, name: String, at: Date)
    /// How much of a subscription's window is used, 0…1.
    case limit(used: Double, weekly: Bool)
    case progress(done: Int)
    /// An employee's answer of the last day that came with a picture.
    case result(route: ReaderRoute, name: String, appearance: AgentAppearance, text: String, file: ChatAttachment)

    var id: String {
        switch self {
        case .desk(let route, _, _, _, _, _, _): "desk:" + route.id
        case .important: "important"
        case .next: "next"
        case .limit: "limit"
        case .progress: "progress"
        case .result(let route, _, _, _, _): "result:" + route.id
        }
    }
    var place: HomePlace {
        switch self {
        case .desk(let route, _, _, _, _, _, _), .next(let route, _, _), .result(let route, _, _, _, _): .reader(route)
        case .important: .insights
        case .limit: .statistics
        case .progress: .progress
        }
    }
}

enum Shelf {
    struct Desk { let route: ReaderRoute; let name: String; let appearance: AgentAppearance; let story: NewsStory?; let host: String?; let unseen: Int }

    /// Today's work in the order the shelf shows it: each desk's lead, what matters, the next run, the limit, progress,
    /// then the answers that came with a picture.
    static func tiles(desks: [Desk], activity: HomeActivity?, next: (route: ReaderRoute, name: String, at: Date)?, accounts: [ManagedCodexAccount],
                      results: [ShelfTile] = []) -> [ShelfTile] {
        var tiles = desks.compactMap { desk in
            desk.story.map { ShelfTile.desk(route: desk.route, name: desk.name, appearance: desk.appearance, title: $0.title, image: $0.image, host: desk.host, unseen: desk.unseen) }
        }
        if let activity {
            // Who needs the owner, each once; the Home's own sentence about it is the same for all and waits on the page.
            var seen = Set<String>()
            let open = activity.attention.map(\.employeeName).filter { seen.insert($0).inserted }.prefix(3)
            let done = activity.results.prefix(3 - open.count).map(\.title)
            if !open.isEmpty || !done.isEmpty { tiles.append(.important(open: Array(open), done: Array(done))) }
        }
        if let next { tiles.append(.next(route: next.route, name: next.name, at: next.at)) }
        if let limit = limit(accounts) { tiles.append(.limit(used: limit.used, weekly: limit.weekly)) }
        if let progress = activity?.progress, progress.completedRequests + progress.completedRuns > 0 {
            tiles.append(.progress(done: progress.completedRequests + progress.completedRuns))
        }
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

    /// The employee page's one line of rhythm: the nearest schedule in words, its next run, and how many more there are.
    /// «Каждый день в 07:15 · следующий запуск завтра в 07:15 · и ещё 2». Nil when it has no recurring schedule at all.
    func rhythm(_ schedules: [ChatSchedule], now: Date = .now) -> String? {
        // A backup stands in for its main schedule; it is not a rhythm of its own.
        let recurring = schedules.filter { !$0.isOneTime && $0.backupOf == nil }
        let running = recurring.filter(\.enabled).compactMap { schedule in Team.date(schedule.nextRunAt).map { (schedule: schedule, next: $0) } }.sorted { $0.next < $1.next }
        guard let nearest = running.first else { return recurring.isEmpty ? nil : self("Расписание на паузе") }
        let more = running.count > 1 ? self("и ещё \(running.count - 1)") : nil
        guard let rhythm = rhythm(nearest.schedule) else { return [nextRun(nearest.next, now: now), more].compactMap { $0 }.joined(separator: " · ") }
        return [rhythm, self("следующий запуск \(moment(nearest.next, now: now))"), more].compactMap { $0 }.joined(separator: " · ")
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
