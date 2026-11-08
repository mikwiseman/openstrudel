import Foundation
import Testing

@MainActor
@Suite("Usage statistics") struct StatisticsTests {
    /// A Home's answer with two days and one week; `scale` multiplies its numbers so two Homes differ.
    private func home(_ scale: Int, cost: Double?, chat: String = "main", kind: String = "main", employee: String? = nil) throws -> HomeStatistics {
        let price = cost.map { String($0) } ?? "null"
        func period(_ start: String, _ requests: Int, previous: Bool) -> String {
            """
            {"start":"\(start)","requests":\(requests),"sources":{"app":\(requests - 1),"telegram":0,"schedule":1,"events":0},
             "outcomes":{"answered":\(requests - 1),"quiet":1,"failed":0},"measured":1,"tokens":{"input":\(1000 * scale),"cached":0,"output":\(10 * scale),"reasoning":0},
             "costUsd":\(price),"unpriced":0,
             "chats":[{"id":"\(chat)","requests":\(requests),"failed":0,"tokens":\(1010 * scale),"costUsd":\(price)}],
             "models":[{"provider":"chatgpt","model":"gpt-6-astra","name":"GPT-6-Astra","requests":\(requests),"tokens":\(1010 * scale),"costUsd":\(price)}],
             "schedules":[{"id":"radar","runs":1,"quiet":1,"failed":0,"tokens":0,"costUsd":null}]
             \(previous ? #","previousToDate":{"requests":\#(scale),"tokens":0,"costUsd":null}"# : "")}
            """
        }
        return try JSONDecoder().decode(HomeStatistics.self, from: Data("""
        {"checkedAt":"2026-11-08T12:00:00.000Z","timeZone":"Europe/Moscow","firstDay":"2026-11-07","usageSince":"2026-11-08",
         "days":[\(period("2026-11-07", 2 * scale, previous: false)),\(period("2026-11-08", 3 * scale, previous: true))],
         "weeks":[\(period("2026-11-02", 5 * scale, previous: true))],
         "chats":{"\(chat)":{"title":"Главный чат","employee":\(employee.map { "\"\($0)\"" } ?? "null"),"kind":"\(kind)"}},
         "schedules":{"radar":{"name":"Радар","chatId":"\(chat)","enabled":false}}}
        """.utf8))
    }

    @Test func oneHomeKeepsItsOwnNumbersAndNamesItsChats() throws {
        let slices = StatisticsSummary.slices([(id: "personal", name: "WaiClaw", statistics: try home(1, cost: 0.5))], period: .day)
        #expect(slices.map(\.start) == ["2026-11-07", "2026-11-08"])
        let today = try #require(slices.last)
        #expect(today.requests == 3 && today.costUsd == 0.5 && today.previousToDate?.requests == 1)
        #expect(today.chats.first?.title == L("Главный чат"))
        // With one Home there is no Home to name beside each row.
        #expect(today.chats.first?.detail == "")
        #expect(today.schedules.first?.title == "Радар" && today.schedules.first?.detail.contains(L("выключено")) == true)
        #expect(today.totalTokens == 1010)
    }

    @Test func homesMeetOnTheirLocalDatesAndAddUpWithoutInventingCost() throws {
        let slices = StatisticsSummary.slices([
            (id: "personal", name: "WaiClaw", statistics: try home(1, cost: 0.5)),
            (id: "work", name: "Wolf Wolf", statistics: try home(10, cost: nil, chat: "group", kind: "group")),
        ], period: .day)
        let today = try #require(slices.last)
        #expect(today.requests == 33)
        // Wolf had no price: the total is WaiClaw's known cost, not a guess for Wolf.
        #expect(today.costUsd == 0.5)
        #expect(today.previousToDate?.requests == 11)
        #expect(today.homes.map(\.name) == ["Wolf Wolf", "WaiClaw"] && today.homes.map(\.requests) == [30, 3])
        #expect(today.chats.map(\.detail) == [L("Группа в Telegram") + " · Wolf Wolf", "WaiClaw"])
        // One model across both Homes is one row.
        #expect(today.models.count == 1 && today.models.first?.requests == 33 && today.models.first?.costUsd == 0.5)
        #expect(today.sources.app == 31 && today.sources.schedule == 2 && today.outcomes.quiet == 2)
        let weeks = StatisticsSummary.slices([(id: "personal", name: "WaiClaw", statistics: try home(1, cost: nil))], period: .week)
        #expect(weeks.map(\.start) == ["2026-11-02"] && weeks.first?.costUsd == nil)
    }

    @Test func eachHomeAnswersForItselfAndAnOfflineOneKeepsItsLastNumbers() async throws {
        let model = StatisticsModel(), first = try home(1, cost: 0.5)
        await model.load([(id: "personal", fetch: { first }), (id: "old", fetch: { throw StatisticsReadError.unsupported }), (id: "member", fetch: { throw StatisticsReadError.ownerOnly })])
        #expect(model.states["personal"] == .ready(first) && model.states["old"] == .unsupported && model.states["member"] == .ownerOnly)
        await model.load([(id: "personal", fetch: { throw URLError(.notConnectedToInternet) })])
        #expect(model.states["personal"] == .unavailable(first) && model.statistics("personal") == first)
        // A Home that left the list leaves no stale state behind.
        #expect(model.states["old"] == nil && model.states["member"] == nil)
    }
}
