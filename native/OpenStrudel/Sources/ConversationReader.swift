import Foundation

/// Reads one conversation through its Home: a page of its feed and earlier pages on request. It never touches the
/// connection's selection, pending sends or drafts: the composer belongs to the main chat.
@MainActor
final class ConversationReader: ObservableObject {
    let client: HomeClient
    let route: ReaderRoute
    @Published private(set) var messages: [HomeMessage] = []
    @Published private(set) var conversationID: String?
    @Published private(set) var hasEarlierMessages = false
    @Published private(set) var isLoadingEarlier = false
    @Published private(set) var loaded = false
    @Published private(set) var error: String?
    /// An employee's schedules with their recent runs: the rhythm its page shows, and since when a run has not worked.
    @Published private(set) var schedules: [ChatSchedule] = []
    @Published private(set) var runs: [ScheduleRun] = []
    private var olderCursor: String?
    private var newerCursor: String?
    private var generation = 0

    init(client: HomeClient, route: ReaderRoute) {
        self.client = client
        self.route = route
    }

    /// Keeps the page current while the reader is on screen.
    func follow() async {
        while !Task.isCancelled {
            await refresh()
            do { try await Task.sleep(for: .seconds(client.homeUnreachable ? 10 : 3)) } catch { break }
        }
    }

    func refresh() async {
        let run = generation
        var query = "?page=true&limit=50" + (route.usesTimeline ? "&timeline=true" : "")
        if let newerCursor { query += "&after=" + newerCursor }
        let pending = messages.filter { $0.status == "queued" || $0.status == "running" || $0.delivery?.state == "pending" }.map(\.id)
        if !pending.isEmpty { query += "&watch=" + pending.prefix(200).joined(separator: ",") }
        do {
            let envelope: ConversationEnvelope = try await client.read(route.path + query)
            guard run == generation else { return }
            conversationID = envelope.conversation.id
            if let page = envelope.pagination {
                if newerCursor == nil { olderCursor = page.olderCursor; hasEarlierMessages = olderCursor != nil }
                let updated = MessagePages.merge(existing: messages, page: envelope.messages, updates: envelope.updates ?? [], removedIDs: envelope.removedIds ?? [])
                if messages != updated { messages = updated }
                newerCursor = page.newerCursor
            } else if messages != envelope.messages { messages = envelope.messages }
            loaded = true
            if error != nil { error = nil }
        } catch is CancellationError {
        } catch {
            guard run == generation else { return }
            // What is on screen stays; the line below the title says the rest is out of reach.
            self.error = L("Нет связи. Сообщения появятся после подключения.")
            loaded = true
        }
    }

    /// Reads the schedules of the employee's own chat and of its Telegram chats, as its details do. A Home that
    /// refuses them leaves the page without a rhythm line.
    func loadRhythm() async {
        guard case .employee(let profile) = route.kind, let conversationID else { return }
        let chats = (client.telegram?.chats ?? []).filter { $0.profileId == profile }.compactMap(\.conversationId)
        var found: [ChatSchedule] = [], recent: [ScheduleRun] = [], scopes = Set<String>()
        for scope in [conversationID] + chats where scopes.insert(scope).inserted {
            guard let result: SchedulesEnvelope = try? await client.read("/v1/conversations/" + scope + "/schedules") else { return }
            found += result.schedules; recent += result.runs
        }
        schedules = found; runs = recent
    }

    func loadEarlier() async {
        guard hasEarlierMessages, !isLoadingEarlier, let olderCursor else { return }
        let run = generation
        isLoadingEarlier = true
        defer { if run == generation { isLoadingEarlier = false } }
        do {
            let envelope: ConversationEnvelope = try await client.read(route.path + "?page=true&limit=50&before=" + olderCursor + (route.usesTimeline ? "&timeline=true" : ""))
            guard run == generation else { return }
            messages = MessagePages.merge(existing: messages, page: envelope.messages, prepend: true)
            self.olderCursor = envelope.pagination?.olderCursor
            hasEarlierMessages = self.olderCursor != nil
        } catch {
            guard run == generation else { return }
            self.error = L("Не удалось загрузить ранние сообщения. Попробуйте ещё раз.")
        }
    }

    /// The name a quote carries: the employee or chat the reader shows.
    var title: String { route.title }
}

extension HomeClient {
    /// Where a quote of a reader on this Home comes from: nil for a record the chat's own node holds; otherwise this Home's
    /// identity, with the node when an employee of the chat's Home lives on another of its devices. Without a verified Home
    /// id there is no truthful origin, so nothing can be quoted from an unreachable Home.
    func quoteHome(for route: ReaderRoute, primary: HomeClient) -> ChatContext.Home?? {
        let homeId = health?.homeId
        if let id = route.profileID, let homeId, let own = health?.nodeId,
           let device = profiles.first(where: { $0.id == id })?.deviceId, device != own {
            return .some(ChatContext.Home(id: self.id, homeId: homeId, nodeId: device, name: devices.first { $0.id == device }?.name ?? displayName))
        }
        if self === primary { return .some(nil) }
        guard let homeId else { return nil }
        return .some(ChatContext.Home(id: self.id, homeId: homeId, name: displayName))
    }
}
