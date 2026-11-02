import Foundation

/// Reads one conversation through its Home: a page of its feed, earlier pages on request, and its News stories when it
/// has any. It never touches the connection's selection, pending sends or drafts: the composer belongs to the main chat.
@MainActor
final class ConversationReader: ObservableObject {
    let client: HomeClient
    let route: ReaderRoute
    @Published private(set) var messages: [HomeMessage] = []
    /// Nil until the Home answers; empty when the chat has no stories.
    @Published private(set) var news: [HomeMessage]? = nil
    @Published private(set) var conversationID: String?
    @Published private(set) var hasEarlierMessages = false
    @Published private(set) var isLoadingEarlier = false
    @Published private(set) var loaded = false
    @Published private(set) var error: String?
    private var olderCursor: String?
    private var newerCursor: String?
    private var newsStamp: String?
    private var generation = 0

    init(client: HomeClient, route: ReaderRoute) {
        self.client = client
        self.route = route
    }

    /// The feed has stories and the reader may open on them.
    var hasNews: Bool { !(news ?? []).isEmpty }

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
            if envelope.conversation.news != newsStamp || news == nil {
                if let stamp = envelope.conversation.news {
                    let feed: NewsFeedEnvelope = try await client.read("/v1/conversations/" + envelope.conversation.id + "/stories")
                    guard run == generation else { return }
                    if news != feed.messages { news = feed.messages }
                    newsStamp = stamp
                } else { news = []; newsStamp = nil }
            }
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

    /// Where a quote of this reader comes from: nil for a record the chat's own node holds; otherwise that Home's identity,
    /// with the node when an employee of the chat's Home lives on another of its devices. Without a verified Home id there
    /// is no truthful origin, so nothing can be quoted from an unreachable Home.
    func quoteHome(primary: HomeClient) -> ChatContext.Home?? {
        let homeId = client.health?.homeId
        if case .employee(let id) = route.kind, let homeId, let own = client.health?.nodeId,
           let device = client.profiles.first(where: { $0.id == id })?.deviceId, device != own {
            return .some(ChatContext.Home(id: client.id, homeId: homeId, nodeId: device, name: client.devices.first { $0.id == device }?.name ?? client.displayName))
        }
        if client === primary { return .some(nil) }
        guard let homeId else { return nil }
        return .some(ChatContext.Home(id: client.id, homeId: homeId, name: client.displayName))
    }

    /// The name a quote carries: the employee or chat the reader shows.
    var title: String { route.title }
}
