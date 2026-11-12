import Foundation
import Combine

/// The polls one chat is asked each day, read together: four questions become one board and each question a measure.
/// The numbers are the people's own answers. A missing answer is missing, never zero, and nothing here folds
/// different measures into one figure.
struct CheckInBoard: Identifiable, Equatable {
    struct Person: Identifiable, Equatable {
        let id: String
        let name: String
        /// Days answered in a row, as the Home counts them: the longest among the measures.
        let streak: Int
    }

    struct Measure: Identifiable, Equatable {
        let id: String
        let label: String
        let question: String
        let scale: Int
        /// Local date, then person, then the answer.
        let values: [String: [String: Int]]
    }

    /// The conversation the polls live in.
    let id: String
    let title: String
    let chat: String?
    /// The Home's own local date, which may not be this device's.
    let today: String
    /// Every local date the Home sent, oldest first.
    let dates: [String]
    let people: [Person]
    let measures: [Measure]
    /// The connection of the Home the polls live on, which is not always the chat's own.
    var home: String? = nil
    /// That Home's name, said when it is not the chat's own Home.
    var homeName: String? = nil
    /// The board's own place among several Homes: the same chat id can never meet itself on two Homes.
    var place: String { (home ?? "") + ":" + id }

    /// One board per chat, in the order the Home lists its polls.
    static func boards(_ checkIns: [HomeActivity.CheckIn]) -> [CheckInBoard] {
        var order: [String] = [], groups: [String: [HomeActivity.CheckIn]] = [:]
        for item in checkIns {
            if groups[item.conversationId] == nil { order.append(item.conversationId) }
            groups[item.conversationId, default: []].append(item)
        }
        return order.compactMap { id in groups[id].flatMap { board(id, $0) } }
    }

    private static func board(_ id: String, _ items: [HomeActivity.CheckIn]) -> CheckInBoard? {
        guard let first = items.first else { return nil }
        // «Exhale · calm», «Exhale · focus»: what the names share is the board's name and the rest names the measure.
        let parts = items.map { $0.name.components(separatedBy: " · ") }
        let shared = parts.allSatisfy { $0.count == 2 && $0[0] == parts[0][0] } && items.count > 1 ? parts[0][0] : nil
        let measures = zip(items, parts).map { item, part in
            Measure(id: item.id, label: shared != nil ? capitalised(part[1]) : heading(item.question) ?? item.name, question: item.question, scale: max(item.scale, 2),
                    values: Dictionary(item.days.filter { !$0.values.isEmpty }.map { ($0.date, $0.values) }, uniquingKeysWith: { _, latest in latest }))
        }
        var seen = Set<String>(), people: [Person] = []
        for person in items.flatMap(\.participants) where seen.insert(person.id).inserted {
            let streak = items.compactMap { $0.participants.first { $0.id == person.id }?.streak }.max() ?? 0
            people.append(Person(id: person.id, name: person.name, streak: streak))
        }
        return CheckInBoard(id: id, title: shared ?? first.chat ?? first.name, chat: first.chat, today: items.map(\.today).max() ?? first.today,
                            dates: Array(Set(items.flatMap { $0.days.map(\.date) })).sorted(), people: people, measures: measures)
    }

    private static func capitalised(_ text: String) -> String { text.prefix(1).uppercased(with: L10n.locale) + text.dropFirst() }

    /// «Calm: How calm was your day?» opens with its own name.
    private static func heading(_ question: String) -> String? {
        guard let colon = question.range(of: ": ") else { return nil }
        let head = question[..<colon.lowerBound].trimmingCharacters(in: .whitespaces)
        return (2...24).contains(head.count) && head.split(separator: " ").count <= 3 ? head : nil
    }

    // MARK: Reading

    func value(_ measure: Measure, _ person: Person, on date: String) -> Int? { measure.values[date]?[person.id] }

    /// The latest date anyone answered anything: before the evening's poll that is yesterday.
    var latestDay: String? { dates.last { date in measures.contains { $0.values[date] != nil } } }

    /// The dates worth drawing: from the first answer on, and never fewer than the last fourteen.
    var charted: [String] {
        let first = dates.firstIndex { date in measures.contains { $0.values[date] != nil } } ?? 0
        return Array(dates.suffix(max(14, dates.count - first)))
    }

    /// The last seven dates, and the seven before them.
    var thisWeek: [String] { Array(dates.suffix(7)) }
    var lastWeek: [String] { Array(dates.dropLast(7).suffix(7)) }

    func mean(_ measure: Measure, _ person: Person, over dates: [String]) -> (value: Double, answers: Int)? {
        let answers = dates.compactMap { value(measure, person, on: $0) }
        return answers.isEmpty ? nil : (Double(answers.reduce(0, +)) / Double(answers.count), answers.count)
    }

    /// A person's name as a column's head: the first name, or the whole of a name that opens with an initial.
    static func short(_ name: String) -> String {
        guard let first = name.split(separator: " ").first, first.count >= 3 else { return name }
        return String(first)
    }

    /// A local date as the Home wrote it, at noon in UTC, so its weekday and day never slip with this device's zone.
    static func date(_ day: String) -> Date? { try? Date.ISO8601FormatStyle().year().month().day().parse(day).addingTimeInterval(43_200) }

    // MARK: What stands out

    /// One thing worth a sentence. Every rule needs at least three answers on each side of its comparison.
    struct Standout: Identifiable, Equatable {
        enum Kind: Equatable {
            /// The shown day's answer against the person's own usual.
            case unusual(value: Int, usual: Double)
            /// A person's week against the week before.
            case week(now: Double, before: Double)
            /// Two people's weeks, the higher first.
            case apart(high: String, highMean: Double, low: String, lowMean: Double)
            /// A measure that sits well under the person's own other measures this week.
            case low(mean: Double, others: Double)
        }
        let id: String
        /// Nil when it is about two people.
        let person: String?
        let measure: String
        let kind: Kind
        let weight: Double
    }

    func standouts(on day: String, limit: Int = 3) -> [Standout] {
        var found: [Standout] = []
        for measure in measures {
            for person in people {
                if let value = value(measure, person, on: day), let usual = mean(measure, person, over: dates.filter { $0 != day }), usual.answers >= 3,
                   abs(Double(value) - usual.value) >= 2 {
                    found.append(Standout(id: "unusual:\(measure.id):\(person.id)", person: person.name, measure: measure.label,
                                          kind: .unusual(value: value, usual: usual.value), weight: abs(Double(value) - usual.value)))
                }
                if let now = mean(measure, person, over: thisWeek), let before = mean(measure, person, over: lastWeek), now.answers >= 3, before.answers >= 3,
                   abs(now.value - before.value) >= 1 {
                    // A week that moved says more than one day that did.
                    found.append(Standout(id: "week:\(measure.id):\(person.id)", person: person.name, measure: measure.label,
                                          kind: .week(now: now.value, before: before.value), weight: abs(now.value - before.value) * 1.5))
                }
            }
            for person in people {
                // Not one figure for the day: each measure keeps its own number, and one is set beside the rest.
                let others = measures.filter { $0.id != measure.id }.compactMap { other in mean(other, person, over: thisWeek).flatMap { $0.answers >= 3 ? $0.value : nil } }
                if let own = mean(measure, person, over: thisWeek), own.answers >= 3, others.count >= 2 {
                    let rest = others.reduce(0, +) / Double(others.count)
                    if rest - own.value >= 2 {
                        found.append(Standout(id: "low:\(measure.id):\(person.id)", person: person.name, measure: measure.label,
                                              kind: .low(mean: own.value, others: rest), weight: (rest - own.value) * 1.2))
                    }
                }
            }
            let weeks = people.compactMap { person in mean(measure, person, over: thisWeek).flatMap { $0.answers >= 3 ? (person.name, $0.value) : nil } }
            if let high = weeks.max(by: { $0.1 < $1.1 }), let low = weeks.min(by: { $0.1 < $1.1 }), high.1 - low.1 >= 2 {
                found.append(Standout(id: "apart:\(measure.id)", person: nil, measure: measure.label,
                                      kind: .apart(high: high.0, highMean: high.1, low: low.0, lowMean: low.1), weight: high.1 - low.1))
            }
        }
        // The strongest first; equal ones keep the order of the measures.
        return Array(found.enumerated().sorted { $0.element.weight != $1.element.weight ? $0.element.weight > $1.element.weight : $0.offset < $1.offset }.map(\.element).prefix(limit))
    }
}

/// The words of a board, in the interface language.
struct CheckInWords {
    var language: AppLanguage = L10n.shared.language

    private func callAsFunction(_ message: LocalizedMessage) -> String { L10n.text(message.key, arguments: message.arguments, language: language) }
    private var style: Date.FormatStyle {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .gmt
        return Date.FormatStyle(locale: language.locale, calendar: calendar, timeZone: .gmt)
    }

    func number(_ value: Double) -> String { value.formatted(.number.precision(.fractionLength(0...1)).locale(language.locale)) }

    /// «+0,8», «−1,2»; nothing for a week that did not move.
    func change(_ value: Double) -> String? {
        let rounded = (value * 10).rounded() / 10
        guard rounded != 0 else { return nil }
        return (rounded > 0 ? "+" : "−") + number(abs(rounded))
    }

    /// «Сегодня», «Вчера», or the weekday and the date: «Понедельник, 9 ноября».
    func day(_ day: String, today: String) -> String {
        if day == today { return self("Сегодня") }
        guard let date = CheckInBoard.date(day), let now = CheckInBoard.date(today) else { return day }
        if Int((now.timeIntervalSince(date) / 86_400).rounded()) == 1 { return self("Вчера") }
        let text = date.formatted(style.weekday(.wide).day().month(.wide))
        return text.prefix(1).uppercased(with: language.locale) + text.dropFirst()
    }

    /// The same, as short as a tile's corner or a chart's edge allows: «сегодня», «вчера», «9 нояб.»
    func shortDay(_ day: String, today: String) -> String {
        if day == today { return self("сегодня") }
        guard let date = CheckInBoard.date(day), let now = CheckInBoard.date(today) else { return day }
        if Int((now.timeIntervalSince(date) / 86_400).rounded()) == 1 { return self("вчера") }
        return date.formatted(style.day().month(.abbreviated)).lowercased(with: language.locale)
    }

    func title(_ standout: CheckInBoard.Standout) -> String {
        standout.person.map { standout.measure + " · " + CheckInBoard.short($0) } ?? standout.measure
    }

    func text(_ standout: CheckInBoard.Standout) -> String {
        switch standout.kind {
        case .unusual(let value, let usual): self("\(value.formatted()), обычно около \(number(usual))")
        case .week(let now, let before): self("За неделю \(number(now)), неделей раньше \(number(before))")
        case .low(let mean, let others): self("За неделю \(number(mean)), остальное около \(number(others))")
        case .apart(let high, let highMean, let low, let lowMean):
            self("За неделю: \(CheckInBoard.short(high)) \(number(highMean)) · \(CheckInBoard.short(low)) \(number(lowMean))")
        }
    }
}

/// The polls of every Home in sight: the team's daily questions may be asked on any of them, not only on the Home the
/// chat is connected to. Each Home's activity is read as its owner may read it; a Home that does not give it has no
/// polls here.
@MainActor
final class CheckInHomes: ObservableObject {
    struct Home: Equatable { let id: String; let name: String; let primary: Bool }
    struct Read: Equatable { let boards: [CheckInBoard]; let checkedAt: String }
    /// A Home that has polls, and when it was read.
    struct Checked: Identifiable, Equatable { let home: String; let name: String; let at: String; var id: String { home } }
    /// Each Home's boards that someone has answered, by connection.
    @Published private(set) var read: [String: Read] = [:]
    /// The Homes asked at least once, whatever they answered.
    @Published private(set) var asked: Set<String> = []

    /// What one Home's activity says; nil when the Home gives none to this device.
    func take(_ activity: HomeActivity?, from home: String) {
        let next = activity.map { Read(boards: CheckInBoard.boards($0.rituals).filter { $0.latestDay != nil }, checkedAt: $0.checkedAt) }
        if read[home] != next { read[home] = next }
        if !asked.contains(home) { asked.insert(home) }
    }

    /// Every answered board, the chat's own Home first and the others in the order they were connected. A board on
    /// another Home carries that Home's name; with one Home there is nothing to name.
    func boards(_ homes: [Home]) -> [CheckInBoard] {
        let several = homes.count > 1
        return homes.flatMap { home in
            (read[home.id]?.boards ?? []).map { board in
                var board = board
                board.home = home.id
                board.homeName = several && !home.primary ? home.name : nil
                return board
            }
        }
    }

    /// When each Home that has polls was read, for the page's last line.
    func checked(_ homes: [Home]) -> [Checked] {
        homes.compactMap { home in read[home.id].flatMap { $0.boards.isEmpty ? nil : Checked(home: home.id, name: home.name, at: $0.checkedAt) } }
    }

    /// Every Home in sight has been asked once: an empty page then means no polls, not not yet.
    func ready(_ homes: [Home]) -> Bool { homes.allSatisfy { asked.contains($0.id) } }

    /// Reads the activity of each of these Homes. One out of reach keeps what it last said; one that does not give its
    /// activity to this device, or predates it, has no polls here.
    func refresh(_ sources: [HomeClient]) async {
        for source in sources where !Task.isCancelled {
            do { take(try await source.readActivity(), from: source.id) }
            catch ActivityReadError.unsupported, ActivityReadError.ownerOnly, HomeClientError.authenticationExpired { take(nil, from: source.id) }
            catch { if !asked.contains(source.id) { asked.insert(source.id) } }
        }
    }
}

extension DeviceLibrary {
    /// The Homes of the team list as the polls know them.
    var pollHomes: [CheckInHomes.Home] { teamHomes.map { CheckInHomes.Home(id: $0.id, name: $0.displayName, primary: $0 === primary) } }
}
