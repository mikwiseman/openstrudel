import Foundation
import Combine

/// One thing that waits for the owner: what is true, why now, and the step itself as a button.
/// A Home that keeps cards sends them (`GET /v1/cards`). A Home that does not yet is read for what it can already
/// tell: an employee whose runs fail, with the reason, and a question waiting in its chat.
struct NeedCard: Identifiable, Equatable {
    enum Kind: String, Equatable { case send, answer, due, connect, failed }

    struct Action: Identifiable, Equatable {
        enum Role: Equatable { case primary, plain, link }
        let id: String
        let label: String
        var role = Role.plain
        /// It is answered in words: a new date, something else.
        var needsText = false
        /// A link is opened, never sent to the Home.
        var url: URL?
    }

    /// Words that will leave, whole, with who receives them and through what.
    struct Draft: Equatable {
        var to: String?
        var via: String?
        var subject: String?
        let text: String
    }

    struct Detail: Equatable, Identifiable {
        let label: String
        let value: String
        var id: String { label }
    }

    /// How a card was decided, by whom and when: the quiet line it leaves behind.
    struct Decision: Equatable {
        /// What the Home did, or what the button said.
        let words: String
        var by: String?
        var at: Date?
    }

    enum Origin: Equatable {
        /// A card its Home keeps; the Home carries out the button.
        case card(String)
        /// An employee whose latest runs failed, read from its row.
        case failing(ReaderRoute)
        /// A question waiting in the Home's chat.
        case question(ChatInteraction)
    }

    let id: String
    /// The connection of the Home it is from.
    let home: String
    let kind: Kind
    let origin: Origin
    /// Nil is the Home's main assistant.
    var profileID: String?
    var employee: String
    /// What is true, in one line.
    var title: String
    /// Why now, in a sentence.
    var text: String?
    var draft: Draft?
    var details: [Detail] = []
    /// The day a promise or a deadline falls on.
    var due: Date?
    /// When it was raised, or since when it has been so.
    var at: Date?
    /// When a failed run is tried again, when its Home knows.
    var nextTry: Date?
    /// The first is the step the card proposes.
    var actions: [Action] = []
    /// The people it waits for, when this device cannot answer for them.
    var waitsFor: [String]?
    var decision: Decision?

    /// Words that leave are read before they leave: such a card is answered on its page, never from the home.
    var readsFirst: Bool { draft != nil }

    /// The Home's own choices for words that leave: send them, or keep them as a draft.
    static let send = "send", keep = "draft"
    /// The person may change the words before they go. A connector's own request to send is allowed or refused as
    /// it stands; it offers no draft to keep.
    var editable: Bool { kind == .send && draft != nil && actions.contains { $0.id == Self.send } && actions.contains { $0.id == Self.keep } }
}

enum NeedsYou {
    /// The buttons the app itself carries out, on what an older Home can already tell.
    static let open = "open", later = "later", option = "option:"

    /// An employee whose runs keep failing. The card says why when the Home does, and since when.
    static func failing(_ member: TeamMember, failure: TeamFailures.Failure?, words: TeamWords = TeamWords(), now: Date = .now) -> NeedCard {
        let reason = failure?.reason.map { Shelf.clipped($0, to: 120) }
        let since = words.failure(since: failure?.since, reason: nil, now: now).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return NeedCard(id: "failing:" + member.route.id, home: member.route.connectionID, kind: .failed, origin: .failing(member.route),
                        profileID: member.profile.id, employee: member.profile.name,
                        title: reason ?? since, text: reason == nil ? nil : since + ".", at: failure?.since,
                        actions: [.init(id: open, label: L("Открыть"), role: .primary), .init(id: later, label: L("Завтра"))])
    }

    /// A question waiting in a Home's chat. One question with a few short choices is answered where it is seen;
    /// anything longer is answered in the chat.
    static func question(_ interaction: ChatInteraction, home: String, assistant: String) -> NeedCard {
        let detail = interaction.detail.map { InteractionDetail($0).text } ?? ""
        let asked = interaction.questions.first?.question ?? ""
        let choices = interaction.questions.count == 1 && interaction.url == nil ? interaction.questions[0].options : []
        let short = !choices.isEmpty && choices.count <= 3 && choices.allSatisfy { $0.count <= 28 }
        // A yes-or-no decision leads with its yes, as its card in the chat does.
        let decision = interaction.questions.first?.id == "decision" && choices.count == 2
        let actions: [NeedCard.Action] = short
            ? choices.enumerated().map { index, choice in .init(id: option + choice, label: L10n.text(choice), role: decision && index == 0 ? .primary : .plain) }
            : [.init(id: open, label: L("Ответить"), role: .primary)]
        return NeedCard(id: "question:" + home + ":" + interaction.id, home: home, kind: .answer, origin: .question(interaction),
                        profileID: nil, employee: interaction.sourceTitle ?? assistant,
                        title: L10n.text(interaction.title), text: [detail, L10n.text(asked)].first { !$0.isEmpty }, actions: actions)
    }

    /// A decision comes before a notice that something failed; within each, what has waited longest leads. A question
    /// in a chat holds up a turn that is running, so it stands first of all.
    static func ordered(_ cards: [NeedCard]) -> [NeedCard] {
        func rank(_ card: NeedCard) -> Int {
            if case .question = card.origin { return 0 }
            return card.kind == .failed ? 2 : 1
        }
        return cards.enumerated().sorted { first, second in
            let a = first.element, b = second.element
            if rank(a) != rank(b) { return rank(a) < rank(b) }
            if a.at != b.at { return (a.at ?? .distantPast) < (b.at ?? .distantPast) }
            return first.offset < second.offset
        }.map(\.element)
    }

    /// «через 3 дня», «завтра», «сегодня», «вчера»: how far a card's day is, as a person would say it.
    static func until(_ date: Date, now: Date = .now, language: AppLanguage = L10n.shared.language, calendar: Calendar = .current) -> String {
        var calendar = calendar
        calendar.locale = language.locale
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = language.locale; formatter.calendar = calendar; formatter.dateTimeStyle = .named; formatter.unitsStyle = .full
        return formatter.localizedString(from: DateComponents(day: days))
    }

    /// A local calendar date as the Home writes it, «2026-11-14», at noon on this device's calendar.
    static func day(_ text: String?, calendar: Calendar = .current) -> Date? {
        let parts = (text ?? "").split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }
}

/// What waits for the owner on every Home this device is connected to.
@MainActor
final class NeedsYouModel: ObservableObject {
    /// Each Home's own open cards, by connection. A Home that keeps no cards yet is not here.
    @Published private(set) var listed: [String: [NeedCard]] = [:]
    /// What was decided on each Home in the last day, the newest first.
    @Published private(set) var decided: [String: [NeedCard]] = [:]
    /// The cards whose button is on its way to the Home.
    @Published private(set) var busy: Set<String> = []
    /// Why a card's button did not work, until it is pressed again.
    @Published private(set) var errors: [String: String] = [:]
    /// What this device set aside, and until when.
    @Published private(set) var aside: [String: Date]
    /// The card its page brings into sight.
    @Published var focus: String?
    /// When a Home last said it keeps no cards; it is asked again after an update could have reached it.
    private var without: [String: Date] = [:]
    private let defaults: UserDefaults
    private static let storage = "openstrudel.needs.aside"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = defaults.dictionary(forKey: Self.storage) as? [String: Double] ?? [:]
        aside = saved.mapValues(Date.init(timeIntervalSince1970:)).filter { $0.value > .now }
    }

    /// Every Home's cards as one list. A Home without cards of its own gives what it can already tell: the questions
    /// waiting in its chat and its failing employees. A Home with cards asks its own questions; an employee whose runs
    /// fail is still said, unless the Home already raised a card about it.
    func cards(_ library: DeviceLibrary, failures: TeamFailures, now: Date = .now) -> [NeedCard] {
        var all: [NeedCard] = []
        for source in library.teamHomes {
            let own = listed[source.id]
            all += own ?? source.interactions.map { NeedsYou.question($0, home: source.id, assistant: source.activeAgentName) }
            let told = Set((own ?? []).filter { $0.kind == .failed }.compactMap(\.profileID))
            all += library.team(on: source).filter { $0.profile.failing == true && !source.isOffline($0.profile) && !told.contains($0.profile.id) }
                .map { NeedsYou.failing($0, failure: failures.failure($0.profile.id, on: source), now: now) }
        }
        return NeedsYou.ordered(all.filter { (aside[$0.id] ?? .distantPast) <= now })
    }

    /// What was decided in the last day on the Homes in sight, the newest first.
    func recent(_ library: DeviceLibrary) -> [NeedCard] {
        library.teamHomes.flatMap { decided[$0.id] ?? [] }.sorted { ($0.decision?.at ?? .distantPast) > ($1.decision?.at ?? .distantPast) }
    }

    /// Reads each Home's cards. One that answers 404 keeps none yet and is asked again in ten minutes; one that
    /// refuses this connection (403) gives nothing only its owner may read.
    func refresh(_ homes: [HomeClient], now: Date = .now) async {
        for source in homes {
            if let asked = without[source.id], now.timeIntervalSince(asked) < 600 { continue }
            var refusal: Int?
            do {
                let data = try await source.managementFile(HomeCards.path, refused: { refusal = $0 })
                take(try JSONDecoder().decode(HomeCards.self, from: data), from: source.id)
                without[source.id] = nil
            } catch {
                // A Home out of reach keeps its last word.
                guard refusal == 404 || refusal == 403 else { continue }
                without[source.id] = now
                if listed[source.id] != nil { listed[source.id] = nil }
                if decided[source.id] != nil { decided[source.id] = nil }
            }
        }
        let known = Set(homes.map(\.id))
        if listed.keys.contains(where: { !known.contains($0) }) { listed = listed.filter { known.contains($0.key) } }
        if decided.keys.contains(where: { !known.contains($0) }) { decided = decided.filter { known.contains($0.key) } }
    }

    func take(_ cards: HomeCards, from home: String) {
        let open = cards.open.compactMap { $0.card(home: home) }, recent = (cards.recent ?? []).compactMap { $0.card(home: home) }
        if listed[home] != open { listed[home] = open }
        if decided[home] != recent { decided[home] = recent }
    }

    /// Sends a card's button, with words when it takes words, to its Home. The card leaves at once; one that was
    /// already decided elsewhere, or that the Home no longer has, is simply read again.
    func press(_ action: NeedCard.Action, on card: NeedCard, text: String? = nil, home: HomeClient) async {
        guard case .card(let id) = card.origin, !busy.contains(card.id) else { return }
        busy.insert(card.id); errors[card.id] = nil
        defer { busy.remove(card.id) }
        var payload: [String: Any] = ["choice": action.id]
        if let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { payload["text"] = text }
        var refusal: Int?
        do {
            _ = try await home.managementFile(HomeCards.path + "/" + id + "/answer", method: "POST", payload: payload, refused: { refusal = $0 })
        } catch {
            guard refusal == 404 || refusal == 409 else { errors[card.id] = error.localizedDescription; return }
        }
        listed[home.id]?.removeAll { $0.id == card.id }
        await refresh([home])
    }

    /// Carries out a button the app itself answers, with the card busy meanwhile and what went wrong kept beside it.
    func run(_ card: NeedCard, _ work: () async throws -> Void) async {
        guard !busy.contains(card.id) else { return }
        busy.insert(card.id); errors[card.id] = nil
        defer { busy.remove(card.id) }
        do { try await work() } catch { errors[card.id] = error.localizedDescription }
    }

    /// «Завтра»: out of the list on this device until tomorrow morning.
    func setAside(_ card: NeedCard, now: Date = .now, calendar: Calendar = .current) {
        let morning = calendar.date(byAdding: DateComponents(day: 1, hour: 6), to: calendar.startOfDay(for: now)) ?? now.addingTimeInterval(86_400)
        aside = aside.filter { $0.value > now }
        aside[card.id] = morning
        defaults.set(aside.mapValues(\.timeIntervalSince1970), forKey: Self.storage)
    }
}

/// A Home's cards as it sends them: what is open, the oldest first, and what was decided in the last day.
/// Fields this version does not know are ignored, and so is a card of a kind it does not know.
struct HomeCards: Decodable {
    static let path = "/v1/cards"

    struct Card: Decodable {
        struct Raiser: Decodable { let profileId: String?; let name: String? }
        struct Detail: Decodable { let label: String; let value: String }
        struct Content: Decodable {
            let to: String?; let via: String?; let subject: String?; let text: String?
            let details: [Detail]?; let due: String?; let url: String?; let nextTry: String?
        }
        struct Choice: Decodable { let id: String; let label: String; let role: String?; let needsText: Bool?; let url: String? }
        struct Person: Decodable { let name: String }
        struct Answer: Decodable { let label: String?; let text: String?; let by: String?; let via: String?; let at: String?; let outcome: String? }
        let id: String
        let kind: String
        let createdAt: String?
        let raiser: Raiser?
        let title: String
        let reason: String?
        let content: Content?
        let choices: [Choice]?
        let `for`: [Person]?
        let canAnswer: Bool?
        let answer: Answer?

        func card(home: String) -> NeedCard? {
            guard let kind = NeedCard.Kind(rawValue: kind) else { return nil }
            let filled = { (text: String?) in text?.isEmpty == false ? text : nil }
            let actions = (choices ?? []).map { choice in
                let role: NeedCard.Action.Role = choice.role == "primary" ? .primary : choice.role == "link" ? .link : .plain
                return NeedCard.Action(id: choice.id, label: choice.label, role: role, needsText: choice.needsText == true,
                                       url: role == .link ? (choice.url ?? content?.url).flatMap(URL.init(string:)) : nil)
            }
            let draft = filled(content?.text).map { NeedCard.Draft(to: filled(content?.to), via: filled(content?.via), subject: filled(content?.subject), text: $0) }
            // What the Home did; or the button with the words it was given; or the button alone. Who decided is said
            // when it was someone in Telegram, not this app.
            let decision = answer.flatMap { answer -> NeedCard.Decision? in
                let said = filled(answer.text).map { Shelf.clipped($0, to: 60) }
                let button = filled(answer.label).map { label in said.map { $0 == label ? label : label + ": " + $0 } ?? label }
                guard let words = filled(answer.outcome) ?? button ?? said else { return nil }
                return NeedCard.Decision(words: words, by: answer.via == "app" ? nil : filled(answer.by), at: Team.date(answer.at))
            }
            return NeedCard(id: home + ":" + id, home: home, kind: kind, origin: .card(id), profileID: raiser?.profileId, employee: filled(raiser?.name) ?? "OpenStrudel",
                            title: title, text: filled(reason), draft: draft,
                            details: (content?.details ?? []).map { NeedCard.Detail(label: $0.label, value: $0.value) },
                            due: NeedsYou.day(content?.due), at: Team.date(createdAt), nextTry: Team.date(content?.nextTry), actions: actions,
                            waitsFor: canAnswer == false ? (`for` ?? []).map(\.name) : nil, decision: decision)
        }
    }
    let open: [Card]
    let recent: [Card]?
}
