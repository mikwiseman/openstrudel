import Foundation
import Testing

@MainActor
@Suite("Home activity") struct ActivityTests {
    private func snapshot(_ id: String = "receipt", completed: Int = 2) throws -> HomeActivity {
        try JSONDecoder().decode(HomeActivity.self, from: Data("""
        {"checkedAt":"2026-11-03T12:00:00.000Z","period":{"start":"2026-10-28T00:00:00.000Z","end":"2026-11-03T12:00:00.000Z","timeZone":"Europe/Moscow"},
         "insights":[{"id":"\(id)","kind":"result","title":"A result","text":"Claim: everything succeeded","occurredAt":"2026-11-03T10:00:00.000Z","conversationId":"source-chat","profileId":"employee","employeeName":"Editor","messageId":"actual-message","status":"completed"},
         {"id":"issue","kind":"attention","title":"Needs checking","text":"A task failed","occurredAt":"2026-11-03T11:00:00.000Z","conversationId":"other-chat","profileId":null,"employeeName":"OpenStrudel","messageId":null,"status":"failed"}],
         "progress":{"activeDays":2,"completedRequests":\(completed),"completedRuns":1,"quietRuns":4,"failedRuns":1,"activeSchedules":2,"milestones":[{"id":"first-request","reached":true},{"id":"first-automation","reached":true},{"id":"three-active-days","reached":false}]}}
        """.utf8))
    }

    @Test func sourceQuotesKeepTheActualMessageIdentityAndDoNotTrustThePreview() throws {
        let value = try snapshot(completed: 0)
        let quote = try #require(value.results.first?.context)
        #expect(quote.conversationId == "source-chat")
        #expect(quote.messageId == "actual-message")
        #expect(quote.type == .message && quote.quote == nil && quote.home == nil)
        #expect(value.attention.first?.context == nil)
        #expect(value.progress.completedRequests == 0) // The prose above cannot manufacture completion.
        #expect(value.progress.quietRuns == 4 && value.results.count == 1)
        #expect(value.progress.reached("first-automation") && !value.progress.reached("three-active-days"))
        #expect(HomeActivity.date(value.checkedAt) != nil)
        #expect(HomeActivity.date("2026-11-03T12:00:00Z") != nil)
    }

    @Test func aLateResponseCannotReplaceTheSelectedHomesActivity() async throws {
        let model = ActivityModel(), old = try snapshot("old"), current = try snapshot("new")
        var pending: CheckedContinuation<HomeActivity, Error>?
        let oldRequest = Task { await model.load(scope: "old-home") { try await withCheckedThrowingContinuation { pending = $0 } } }
        while pending == nil { await Task.yield() }
        await model.load(scope: "new-home") { current }
        pending!.resume(returning: old)
        await oldRequest.value
        #expect(model.scope == "new-home" && model.activity == current)
    }

    @Test func sameHomeOutageIsExplicitAndCapabilityOrAccessRefusalClearsCachedData() async throws {
        let model = ActivityModel(), value = try snapshot()
        await model.load(scope: "home") { value }
        await model.load(scope: "home") { throw URLError(.notConnectedToInternet) }
        #expect(model.activity == value && model.failure == .unavailable)
        await model.load(scope: "home") { throw ActivityReadError.unsupported }
        #expect(model.activity == nil && model.failure == .unsupported)
        await model.load(scope: "home") { value }
        await model.load(scope: "home") { throw ActivityReadError.ownerOnly }
        #expect(model.activity == nil && model.failure == .ownerOnly)
        await model.load(scope: "home") { value }
        await model.load(scope: "other-home") { throw URLError(.timedOut) }
        #expect(model.activity == nil && model.scope == "other-home")
    }

    @Test func clearingTheHomeInvalidatesAnOutstandingRead() async throws {
        let model = ActivityModel(), value = try snapshot()
        var pending: CheckedContinuation<HomeActivity, Error>?
        let request = Task { await model.load(scope: "home") { try await withCheckedThrowingContinuation { pending = $0 } } }
        while pending == nil { await Task.yield() }
        model.clear(); pending!.resume(returning: value); await request.value
        #expect(model.activity == nil && model.scope == nil && !model.refreshing)
    }

    @Test func limitsDoNotSurviveARefusedRefreshOrMoveToAnotherHome() async throws {
        let model = ActivityLimitsModel()
        let value = try JSONDecoder().decode(ManagedCodexAccounts.self, from: Data(#"{"accounts":[{"id":"a","name":"Account","account":{"connected":true},"usage":{"checkedAt":"2026-11-03T12:00:00Z","windows":[{"name":"primary","remainingPercent":null}]},"activeRuns":0,"loginPending":false}],"canManage":true}"#.utf8))
        await model.load(scope: "home") { value }
        #expect(model.accounts.count == 1)
        #expect(model.accounts.first?.usage.windows.first?.remainingPercent == nil)
        await model.load(scope: "other") { throw URLError(.timedOut) }
        #expect(model.accounts.isEmpty && model.unavailable && model.scope == "other")
        await model.load(scope: "home") { value }
        await model.load(scope: "home") { throw HomeClientError.authenticationExpired }
        #expect(model.accounts.isEmpty && model.unavailable)
    }
}
