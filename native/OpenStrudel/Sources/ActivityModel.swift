import Foundation
import Combine

/// Read-only facts from the selected Home. Completion describes a request/run, never a business outcome.
struct HomeActivity: Decodable, Equatable {
    struct Period: Decodable, Equatable { let start: String; let end: String; let timeZone: String }
    struct Insight: Decodable, Identifiable, Hashable {
        let id: String
        let kind: String
        let title: String
        let text: String
        let occurredAt: String
        let conversationId: String
        let profileId: String?
        let employeeName: String
        let messageId: String?
        let status: String
        var needsAttention: Bool { kind == "attention" }
        /// Home resolves its own record again; the preview is never substituted for source evidence.
        var context: ChatContext? {
            guard let messageId, !messageId.isEmpty, !conversationId.isEmpty else { return nil }
            return ChatContext(type: .message, conversationId: conversationId, messageId: messageId, title: needsAttention ? L("Needs attention") : title, author: employeeName, date: occurredAt)
        }
    }
    struct Progress: Decodable, Equatable {
        struct Milestone: Decodable, Identifiable, Equatable {
            let id: String; let reached: Bool
            var known: Bool { ["first-request", "first-automation", "three-active-days"].contains(id) }
        }
        let activeDays: Int
        let completedRequests: Int
        let completedRuns: Int
        let quietRuns: Int
        let failedRuns: Int
        let activeSchedules: Int
        let milestones: [Milestone]
        func reached(_ id: String) -> Bool { milestones.contains { $0.id == id && $0.reached } }
    }
    let checkedAt: String
    let period: Period
    let insights: [Insight]
    let progress: Progress
    var attention: [Insight] { insights.filter(\.needsAttention) }
    var results: [Insight] { insights.filter { $0.kind == "result" } }
    static func date(_ value: String) -> Date? {
        (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
    }
}

enum ActivityReadError: Error, Equatable { case unsupported, ownerOnly }

/// Entry/manual refresh only. A late response cannot cross a Home change or a newer request.
@MainActor
final class ActivityModel: ObservableObject {
    enum Failure: Equatable { case unsupported, ownerOnly, unavailable }
    @Published private(set) var scope: String?
    @Published private(set) var activity: HomeActivity?
    @Published private(set) var failure: Failure?
    @Published private(set) var refreshing = false
    private var generation = 0

    func clear() {
        generation += 1; scope = nil; activity = nil; failure = nil; refreshing = false
    }

    func load(scope next: String, fetch: () async throws -> HomeActivity) async {
        generation += 1
        let run = generation
        if scope != next { activity = nil; failure = nil; scope = next }
        refreshing = true
        defer { if generation == run { refreshing = false } }
        do {
            let value = try await fetch()
            guard generation == run, !Task.isCancelled else { return }
            activity = value; failure = nil
        } catch is CancellationError {
        } catch {
            guard generation == run, !Task.isCancelled else { return }
            switch error {
            case ActivityReadError.unsupported: activity = nil; failure = .unsupported
            case ActivityReadError.ownerOnly, HomeClientError.authenticationExpired: activity = nil; failure = .ownerOnly
            default: failure = .unavailable
            }
        }
    }
}

/// Limits are account facts, separate from progress. A failed refresh never presents old balances as current.
@MainActor
final class ActivityLimitsModel: ObservableObject {
    @Published private(set) var scope: String?
    @Published private(set) var accounts: [ManagedCodexAccount] = []
    @Published private(set) var unavailable = false
    @Published private(set) var refreshing = false
    private var generation = 0
    func clear() { generation += 1; scope = nil; accounts = []; unavailable = false; refreshing = false }
    func load(scope next: String, fetch: () async throws -> ManagedCodexAccounts) async {
        generation += 1; let run = generation
        if scope != next { accounts = []; scope = next; unavailable = false }
        refreshing = true
        defer { if generation == run { refreshing = false } }
        do {
            let value = try await fetch()
            guard generation == run, !Task.isCancelled else { return }
            accounts = value.accounts.filter { $0.account.connected || $0.account.isUnavailable }; unavailable = false
        } catch is CancellationError {
        } catch {
            guard generation == run, !Task.isCancelled else { return }
            accounts = []; unavailable = true
        }
    }
}
