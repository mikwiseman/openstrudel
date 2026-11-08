import Foundation
import Combine

/// One Home's usage by day and by week in its owner's zone (`GET /v1/statistics`). Requests are executed turns;
/// tokens and cost exist from `usageSince` on and are API-price estimates, not a bill.
struct HomeStatistics: Decodable, Equatable {
    struct Spend: Decodable, Equatable { let requests: Int; let tokens: Int; let costUsd: Double? }
    struct Sources: Decodable, Equatable { var app = 0; var telegram = 0; var schedule = 0; var events = 0 }
    struct Outcomes: Decodable, Equatable { var answered = 0; var quiet = 0; var failed = 0 }
    struct Tokens: Decodable, Equatable { var input = 0; var cached = 0; var output = 0; var reasoning = 0 }
    struct ChatRow: Decodable, Equatable { let id: String; let requests: Int; let failed: Int; let tokens: Int; let costUsd: Double? }
    struct ModelRow: Decodable, Equatable { let provider: String?; let model: String?; let name: String; let requests: Int; let tokens: Int; let costUsd: Double? }
    struct ScheduleRow: Decodable, Equatable { let id: String; let runs: Int; let quiet: Int; let failed: Int; let tokens: Int; let costUsd: Double? }
    struct Period: Decodable, Equatable {
        let start: String
        let requests: Int
        let sources: Sources
        let outcomes: Outcomes
        let measured: Int
        let tokens: Tokens
        let costUsd: Double?
        let unpriced: Int
        let chats: [ChatRow]
        let models: [ModelRow]
        let schedules: [ScheduleRow]
        let previousToDate: Spend?
    }
    struct Chat: Decodable, Equatable { let title: String; let employee: String?; let kind: String }
    struct Schedule: Decodable, Equatable { let name: String; let chatId: String; let enabled: Bool }
    let checkedAt: String
    let timeZone: String
    let firstDay: String?
    let usageSince: String?
    let days: [Period]
    let weeks: [Period]
    let chats: [String: Chat]
    let schedules: [String: Schedule]
}

enum StatisticsReadError: Error, Equatable { case unsupported, ownerOnly }

enum UsagePeriod: String, CaseIterable, Identifiable {
    case day, week
    var id: Self { self }
    var title: String { self == .day ? L("По дням") : L("По неделям") }
}

/// The screen's numbers for one day or week, from one Home or all of them.
struct UsageSlice: Identifiable, Equatable {
    struct Home: Identifiable, Equatable { let id: String; let name: String; var requests: Int; var costUsd: Double? }
    struct Row: Identifiable, Equatable {
        let id: String
        let title: String
        var detail: String
        var requests: Int
        var costUsd: Double?
        var tokens: Int
        var failed: Int
        var quiet: Int
    }
    let start: String
    var id: String { start }
    var requests = 0
    var sources = HomeStatistics.Sources()
    var outcomes = HomeStatistics.Outcomes()
    var measured = 0
    var tokens = HomeStatistics.Tokens()
    var costUsd: Double?
    var unpriced = 0
    var previousToDate: HomeStatistics.Spend?
    var homes: [Home] = []
    var chats: [Row] = []
    var schedules: [Row] = []
    var models: [Row] = []
    var totalTokens: Int { tokens.input + tokens.output }
}

/// Costs add up when any part has one; a part without a price adds nothing.
private func sum(_ a: Double?, _ b: Double?) -> Double? { a == nil && b == nil ? nil : (a ?? 0) + (b ?? 0) }

enum StatisticsSummary {
    /// Homes in one list: their periods meet on the local date they start, which is the same date for Homes in one zone.
    static func slices(_ homes: [(id: String, name: String, statistics: HomeStatistics)], period: UsagePeriod) -> [UsageSlice] {
        var byStart: [String: UsageSlice] = [:]
        let multiple = homes.count > 1
        for home in homes {
            let periods = period == .day ? home.statistics.days : home.statistics.weeks
            for source in periods {
                var slice = byStart[source.start] ?? UsageSlice(start: source.start)
                slice.requests += source.requests
                slice.sources.app += source.sources.app; slice.sources.telegram += source.sources.telegram
                slice.sources.schedule += source.sources.schedule; slice.sources.events += source.sources.events
                slice.outcomes.answered += source.outcomes.answered; slice.outcomes.quiet += source.outcomes.quiet; slice.outcomes.failed += source.outcomes.failed
                slice.measured += source.measured; slice.unpriced += source.unpriced
                slice.tokens.input += source.tokens.input; slice.tokens.cached += source.tokens.cached
                slice.tokens.output += source.tokens.output; slice.tokens.reasoning += source.tokens.reasoning
                slice.costUsd = sum(slice.costUsd, source.costUsd)
                if let previous = source.previousToDate {
                    let earlier = slice.previousToDate
                    slice.previousToDate = HomeStatistics.Spend(requests: (earlier?.requests ?? 0) + previous.requests, tokens: (earlier?.tokens ?? 0) + previous.tokens, costUsd: sum(earlier?.costUsd, previous.costUsd))
                }
                slice.homes.append(.init(id: home.id, name: home.name, requests: source.requests, costUsd: source.costUsd))
                for chat in source.chats {
                    let info = home.statistics.chats[chat.id]
                    slice.chats.append(.init(id: home.id + "/" + chat.id, title: chatTitle(info), detail: [chatKind(info), multiple ? home.name : nil].compactMap { $0 }.joined(separator: " · "),
                                             requests: chat.requests, costUsd: chat.costUsd, tokens: chat.tokens, failed: chat.failed, quiet: 0))
                }
                for run in source.schedules {
                    let info = home.statistics.schedules[run.id]
                    let chat = info.flatMap { home.statistics.chats[$0.chatId] }
                    let detail = [chat.map(chatTitle), info?.enabled == false ? L("выключено") : nil, multiple ? home.name : nil].compactMap { $0 }.joined(separator: " · ")
                    slice.schedules.append(.init(id: home.id + "/" + run.id, title: info?.name ?? L("Расписание"), detail: detail,
                                                 requests: run.runs, costUsd: run.costUsd, tokens: run.tokens, failed: run.failed, quiet: run.quiet))
                }
                for model in source.models {
                    let key = (model.provider ?? "") + "/" + (model.model ?? "")
                    if let index = slice.models.firstIndex(where: { $0.id == key }) {
                        slice.models[index].requests += model.requests; slice.models[index].tokens += model.tokens
                        slice.models[index].costUsd = sum(slice.models[index].costUsd, model.costUsd)
                    } else {
                        // Requests from before the update have no route; naming a provider for them would be a guess.
                        slice.models.append(.init(id: key, title: model.model == nil ? L("Модель не записана") : model.name, detail: model.model == nil ? "" : providerName(model.provider),
                                                  requests: model.requests, costUsd: model.costUsd, tokens: model.tokens, failed: 0, quiet: 0))
                    }
                }
                byStart[source.start] = slice
            }
        }
        let order: (UsageSlice.Row, UsageSlice.Row) -> Bool = { a, b in a.requests != b.requests ? a.requests > b.requests : (a.costUsd ?? 0) != (b.costUsd ?? 0) ? (a.costUsd ?? 0) > (b.costUsd ?? 0) : a.title < b.title }
        let limit = period == .day ? 30 : 12
        return byStart.values.sorted { $0.start < $1.start }.suffix(limit).map { slice in
            var slice = slice
            slice.homes.sort { $0.requests != $1.requests ? $0.requests > $1.requests : $0.name < $1.name }
            slice.chats.sort(by: order); slice.models.sort(by: order)
            // Automation spends the most where it runs most often: cost first, then runs.
            slice.schedules.sort { ($0.costUsd ?? 0) != ($1.costUsd ?? 0) ? ($0.costUsd ?? 0) > ($1.costUsd ?? 0) : order($0, $1) }
            return slice
        }
    }

    static func chatTitle(_ chat: HomeStatistics.Chat?) -> String {
        guard let chat else { return L("Чат") }
        if chat.kind == "main" { return L("Главный чат") }
        return chat.employee ?? chat.title
    }
    static func chatKind(_ chat: HomeStatistics.Chat?) -> String? {
        switch chat?.kind {
        case "telegram": "Telegram"
        case "group": L("Группа в Telegram")
        case "employee": L("Сотрудник")
        default: nil
        }
    }
    static func providerName(_ id: String?) -> String {
        switch id {
        case "chatgpt", nil: "ChatGPT"
        case "openai": "OpenAI API"
        case "anthropic": "Anthropic"
        case "grok": "Grok"
        case "xai": "xAI"
        case let other?: other
        }
    }
}

/// Entry and manual refresh only, like Insights. Each Home answers for itself; a late answer cannot replace a newer one.
@MainActor
final class StatisticsModel: ObservableObject {
    enum State: Equatable {
        case loading
        case ready(HomeStatistics)
        /// The Home predates statistics.
        case unsupported
        case ownerOnly
        /// Not reachable now; the last statistics it gave, if any.
        case unavailable(HomeStatistics?)
    }
    @Published private(set) var states: [String: State] = [:]
    @Published private(set) var refreshing = false
    private var generation = 0

    func statistics(_ id: String) -> HomeStatistics? {
        switch states[id] {
        case .ready(let value): value
        case .unavailable(let value): value
        default: nil
        }
    }

    func load(_ homes: [(id: String, fetch: @Sendable @MainActor () async throws -> HomeStatistics)]) async {
        generation += 1
        let run = generation
        refreshing = true
        defer { if generation == run { refreshing = false } }
        for home in homes where states[home.id] == nil { states[home.id] = .loading }
        for id in states.keys where !homes.contains(where: { $0.id == id }) { states[id] = nil }
        await withTaskGroup(of: (String, State).self) { group in
            for home in homes {
                let previous = statistics(home.id)
                group.addTask {
                    do { return (home.id, .ready(try await home.fetch())) }
                    catch StatisticsReadError.unsupported { return (home.id, .unsupported) }
                    catch StatisticsReadError.ownerOnly { return (home.id, .ownerOnly) }
                    catch HomeClientError.authenticationExpired { return (home.id, .ownerOnly) }
                    catch { return (home.id, .unavailable(previous)) }
                }
            }
            for await (id, state) in group where generation == run && !Task.isCancelled { states[id] = state }
        }
    }
}
