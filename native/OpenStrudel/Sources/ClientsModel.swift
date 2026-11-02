import Foundation

/// The owner's business clients, read through the main chat's Home. One state at a time: the list, nothing yet,
/// or one of the Home's refusals, each shown as its own screen so reconnecting, a denial, an outage, a missing
/// source and an ambiguous one are never mistaken for one another or for an empty list.
@MainActor
final class ClientsModel: ObservableObject {
    enum State: Equatable {
        case loading
        case ready(source: ClientSource, clients: [BusinessClient])
        case empty(source: ClientSource)
        case refused(Refusal)
        case offline
    }
    /// What the Home said and which state it is; the detail is the service's short text or the connector names.
    struct Refusal: Equatable {
        let code: String
        let message: String
        let detail: String?
    }
    @Published private(set) var state: State = .loading
    @Published private(set) var refreshing = false
    private var generation = 0

    static func state(for error: Error) -> State {
        if case HomeClientError.refused(let code, let message, let detail) = error { return .refused(Refusal(code: code, message: message, detail: detail)) }
        if error is URLError { return .offline }
        if case HomeClientError.authenticationExpired = error { return .offline }
        return .refused(Refusal(code: "service_unavailable", message: error.localizedDescription, detail: nil))
    }

    func load(from client: HomeClient, refresh: Bool = false) async {
        generation += 1
        let run = generation
        if case .ready = state { refreshing = true } else { state = .loading }
        defer { if run == generation { refreshing = false } }
        guard client.health != nil, !client.homeUnreachable else { if run == generation { state = .offline }; return }
        do {
            let envelope = try await client.fetchClients(refresh: refresh)
            guard run == generation else { return }
            state = envelope.clients.isEmpty ? .empty(source: envelope.source) : .ready(source: envelope.source, clients: envelope.clients)
        } catch is CancellationError {
        } catch {
            guard run == generation else { return }
            state = Self.state(for: error)
        }
    }
}

/// The files of one client, paged as the service pages them, read under the source the client was listed from.
@MainActor
final class ClientFilesModel: ObservableObject {
    enum State: Equatable { case loading, ready, refused(ClientsModel.Refusal), offline }
    @Published private(set) var files: [ClientFile] = []
    @Published private(set) var total = 0
    @Published private(set) var nextOffset: Int?
    @Published private(set) var state: State = .loading
    @Published private(set) var loadingMore = false
    let client: BusinessClient
    let source: ClientSource
    private var generation = 0

    init(client: BusinessClient, source: ClientSource) {
        self.client = client
        self.source = source
    }

    func load(from home: HomeClient) async {
        generation += 1
        let run = generation
        state = .loading
        do {
            let page = try await home.fetchClientFiles(client, source: source)
            guard run == generation else { return }
            files = page.files; total = page.total; nextOffset = page.nextOffset
            state = .ready
        } catch is CancellationError {
        } catch {
            guard run == generation else { return }
            state = ClientsModel.state(for: error) == .offline ? .offline : .refused(Self.refusal(error))
        }
    }

    func loadMore(from home: HomeClient) async {
        guard let offset = nextOffset, !loadingMore else { return }
        let run = generation
        loadingMore = true
        defer { if run == generation { loadingMore = false } }
        do {
            let page = try await home.fetchClientFiles(client, source: source, offset: offset)
            guard run == generation else { return }
            let known = Set(files.map(\.id))
            files += page.files.filter { !known.contains($0.id) }
            total = page.total; nextOffset = page.nextOffset
        } catch is CancellationError {
        } catch {
            guard run == generation else { return }
            state = ClientsModel.state(for: error) == .offline ? .offline : .refused(Self.refusal(error))
        }
    }

    private static func refusal(_ error: Error) -> ClientsModel.Refusal {
        if case .refused(let refusal) = ClientsModel.state(for: error) { return refusal }
        return ClientsModel.Refusal(code: "service_unavailable", message: error.localizedDescription, detail: nil)
    }
}
