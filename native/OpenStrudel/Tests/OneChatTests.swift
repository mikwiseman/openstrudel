import Foundation
import Testing

/// The one chat: its composer belongs to the chosen Home's main assistant, every send of a Home keeps one owner and one
/// durable queue, the chat moves only when nothing is in flight, and a quote from another Home goes only while that
/// Home still answers as itself.
@Suite(.serialized)
@MainActor struct OneChatTests {
    @Test func theChatOpensOnTheMainAssistantAndKeepsAnEmployeesOldDraft() throws {
        let fixture = OneChatFixture(), harness = try Harness(fixture)
        defer { harness.close() }
        // An earlier version left an employee selected, with words typed for it.
        harness.defaults.set("emp-1", forKey: "openstrudel.profileID")
        let employeeKey = HomeDrafts.key(home: harness.home, profile: "emp-1", chat: nil)
        harness.defaults.set([employeeKey: "Черновик для редактора"], forKey: "openstrudel.drafts")
        let library = harness.library()
        #expect(library.active.selectedProfileID == nil)
        #expect(library.active.selectedChatID == nil)
        #expect(harness.defaults.string(forKey: "openstrudel.profileID") == nil)
        #expect(library.draft(for: employeeKey) == "Черновик для редактора")
        #expect(library.savedDrafts(on: library.active).map(\.profile) == ["emp-1"])
        // What "Обсудить" attaches stays with the main draft, across a relaunch.
        let mainKey = HomeDrafts.key(home: harness.home, profile: nil, chat: nil)
        let context = ChatContext.message(HomeMessage.sample(id: "m0", text: "Акт подписан"), title: "Редактор", home: nil)
        library.attach(context)
        #expect(library.draftContext(for: mainKey) == context)
        #expect(harness.library().draftContext(for: mainKey) == context)
        #expect(context.label == L("Из переписки") + " · Редактор")
        // A message sent before Clients left the app keeps its client context and its line.
        let older = try JSONDecoder().decode(ChatContext.self, from: Data(#"{"type":"client","clientId":"c-acme","slug":"acme","name":"Acme","source":{"connector":"company","endpoint":"https://x/mcp","fingerprint":"0123456789abcdef"}}"#.utf8))
        #expect(older.label == L("Клиент") + " · Acme" && older.source?.connector == "company")
        let quote = ChatContext.message(HomeMessage.sample(id: "m1", text: "Привет"), title: "Редактор", home: ChatContext.Home(id: "conn-wolf", homeId: "home-wolf", nodeId: "node-w", name: "Wolf"))
        let decoded = try JSONDecoder().decode(ChatContext.self, from: JSONEncoder().encode(quote))
        #expect(decoded == quote)
        #expect(decoded.home?.nodeId == "node-w")
        #expect(quote.label == L("Из переписки") + " · Редактор · Wolf")
    }

    @Test func theChatMovesToAnotherHomeOnlyWhenNothingIsInFlight() async throws {
        let fixture = OneChatFixture(), harness = try Harness(fixture)
        defer { harness.close() }
        // A send restored from an earlier run that the Home never confirmed.
        try PendingMessagesFile.save([PendingHomeMessage(text: "Не подтверждено", profileID: "emp-1")], directory: harness.pendingDirectory, home: harness.home)
        let library = harness.library(otherHomes: 1)
        let chat = library.active, other = library.clients[1]
        #expect(chat.pendingMessages.count == 1)
        #expect(chat.pendingMessages[0].error != nil)
        #expect(library.primaryChangeBlocker != nil)
        #expect(library.select(other) == false)
        #expect(library.active === chat)
        // Removing the chat's own Home is the same move, refused the same way; nothing is signed out.
        await library.removeConnection(chat)
        #expect(library.clients.count == 2)
        #expect(chat.errorMessage == library.primaryChangeBlocker)
        #expect(fixture.requests.filter { $0.method != "GET" }.isEmpty)
        // Letting the unconfirmed send go frees the chat; the file follows.
        chat.discardPending(chat.pendingMessages[0])
        #expect(try PendingMessagesFile.read(directory: harness.pendingDirectory, home: harness.home).isEmpty)
        #expect(library.primaryChangeBlocker == nil)
        let mainKey = HomeDrafts.key(home: harness.home, profile: nil, chat: nil)
        library.saveDraft("слова", for: mainKey)
        #expect(library.primaryChangeBlocker == L("Сначала отправьте или уберите черновик."))
        #expect(library.select(other) == false)
        library.saveDraft("", for: mainKey)
        library.attach(ChatContext.message(HomeMessage.sample(id: "m-c", text: "Контекст"), title: "C", home: nil))
        #expect(library.primaryChangeBlocker != nil)
        library.saveDraftContext(nil, for: mainKey)
        #expect(library.primaryChangeBlocker == nil)
        #expect(library.select(other) == true)
        #expect(library.active === other)
        #expect(other.selectedProfileID == nil)
    }

    @Test func aRenewedConnectionOfTheChatsHomeKeepsTheChatAndItsQueue() throws {
        let fixture = OneChatFixture(), harness = try Harness(fixture)
        defer { harness.close() }
        let queued = PendingHomeMessage(text: "В очереди", profileID: "emp-1", deliveryState: "queued", operationID: "op-keep")
        try PendingMessagesFile.save([queued], directory: harness.pendingDirectory, home: harness.home)
        let library = harness.library(otherHomes: 1)
        let old = library.active
        // A fresh invitation for the same Home replaces the connection object, with or without selecting it.
        let renewed = harness.client(id: "renewed")
        library.add(renewed, select: false)
        #expect(library.active === renewed)
        #expect(library.clients.count == 2)
        #expect(renewed.selectedProfileID == nil)
        #expect(renewed.pendingMessages.map(\.id) == [queued.id])
        #expect(renewed.pendingMessages[0].profileID == "emp-1")
        #expect(renewed.pendingMessages[0].operationID == "op-keep")
        #expect(old !== renewed)
        let again = harness.client(id: "renewed-again")
        library.add(again, select: true)
        #expect(library.active === again)
        #expect(again.pendingMessages.map(\.id) == [queued.id])
    }

    @Test func aLegacyEmployeeSendIsDeliveredOnceAndClearedByItsOwnReceipt() async throws {
        let fixture = OneChatFixture(), harness = try Harness(fixture)
        defer { harness.close() }
        let unsent = PendingHomeMessage(text: "Старая просьба редактору", profileID: "emp-1")
        let accepted = PendingHomeMessage(text: "Принято устройством", profileID: "emp-1", deliveryState: "queued", operationID: "op-done")
        let cancelled = PendingHomeMessage(text: "Отменено устройством", profileID: "emp-1", deliveryState: "queued", operationID: "op-cancel")
        try PendingMessagesFile.save([unsent, accepted, cancelled], directory: harness.pendingDirectory, home: harness.home)
        fixture.receipts["op-done"] = #"{"id":"op-done","status":"delivered","response":{"status":200,"body":""}}"#
        fixture.receipts["op-cancel"] = #"{"id":"op-cancel","status":"canceled","response":null}"#
        let client = harness.client(id: "current")
        client.pinToMain()
        await client.load()
        #expect(client.selectedProfileID == nil)
        // Every unresolved send of this Home is in the main chat's sight, with its destination.
        let visible = client.visiblePendingMessages
        #expect(visible.map(\.profileID) == ["emp-1", "emp-1"])
        #expect(visible.map(\.id).contains(unsent.id))
        #expect(visible.map(\.id).contains(cancelled.id))
        // The accepted one cleared on its receipt, without a send and without a feed showing it.
        #expect(!client.pendingMessages.contains { $0.id == accepted.id })
        #expect(client.pendingMessages.first { $0.id == cancelled.id }?.error != nil)
        #expect(fixture.requests.filter { $0.path.hasPrefix("/v1/messages") }.isEmpty)
        // Retry delivers the unsent one exactly once, to its own destination, under its own id.
        await client.retry(client.pendingMessages.first { $0.id == unsent.id }!)
        let sends = fixture.requests.filter { $0.path.hasPrefix("/v1/messages") }
        #expect(sends.count == 1)
        #expect(sends[0].body?["profile"] as? String == "emp-1")
        #expect(sends[0].body?["externalId"] as? String == unsent.id.uuidString)
        #expect(!client.pendingMessages.contains { $0.id == unsent.id })
        #expect(client.selectedProfileID == nil)
        await client.retry(unsent)
        #expect(fixture.requests.filter { $0.path.hasPrefix("/v1/messages") }.count == 1)
        // A confirmed cancellation is let go explicitly; nothing is resent.
        client.discardPending(client.pendingMessages.first { $0.id == cancelled.id }!)
        #expect(client.pendingMessages.isEmpty)
        #expect(try PendingMessagesFile.read(directory: harness.pendingDirectory, home: harness.home).isEmpty)
        #expect(fixture.requests.filter { $0.path.hasPrefix("/v1/messages") }.count == 1)
    }

    @Test func aMainChatSendNamesItsConversationAndNeverFollowsARoutedEmployee() async throws {
        let fixture = OneChatFixture(), harness = try Harness(fixture)
        defer { harness.close() }
        let client = harness.client(id: "current")
        await client.load()
        #expect(client.conversationID == "chat")
        await client.sendMessage("Привет")
        let send = fixture.requests.first { $0.path.hasPrefix("/v1/messages") }
        #expect(send?.body?["conversationId"] as? String == "chat")
        #expect(send?.body?["profile"] == nil)
        // The Home answered with an employee's id; the chat stays the chat.
        #expect(client.selectedProfileID == nil)
        #expect(client.pendingMessages.isEmpty)
    }

    @Test func unresolvedSendsStayVisibleOnAHomeWithoutTheEmployeeFeed() async throws {
        let fixture = OneChatFixture(), harness = try Harness(fixture)
        fixture.timeline = false
        defer { harness.close() }
        let telegram = PendingHomeMessage(text: "В группу", profileID: nil, conversationID: "tg-1", deliveryState: "queued", operationID: "op-tg")
        fixture.receipts["op-tg"] = #"{"id":"op-tg","status":"sent","response":null}"#
        try PendingMessagesFile.save([telegram], directory: harness.pendingDirectory, home: harness.home)
        let client = harness.client(id: "current")
        await client.load()
        #expect(client.usesEmployeeTimeline == false)
        #expect(client.visiblePendingMessages.map(\.id) == [telegram.id])
    }

    @Test func aQuoteFromAnUnreachableHomeIsHeldAndCanBeSentWithoutIt() async throws {
        let fixture = OneChatFixture(), harness = try Harness(fixture)
        defer { harness.close() }
        let client = harness.client(id: "current")
        await client.load()
        client.sourceReachable = { _ in false }
        let quote = ChatContext.message(HomeMessage.sample(id: "m1", text: "Цитата"), title: "Группа", home: ChatContext.Home(id: "conn-wolf", homeId: "home-wolf", name: "Wolf"))
        await client.sendMessage("Что это?", context: quote)
        #expect(fixture.requests.filter { $0.path.hasPrefix("/v1/messages") }.isEmpty)
        #expect(client.pendingMessages.count == 1)
        #expect(client.pendingMessages[0].error?.contains("Wolf") == true)
        #expect(client.pendingMessages[0].context == quote)
        // Reachable again: the retry carries the quote with its source.
        client.sourceReachable = { $0.homeId == "home-wolf" }
        await client.retry(client.pendingMessages[0])
        let sent = fixture.requests.filter { $0.path.hasPrefix("/v1/messages") }
        #expect(sent.count == 1)
        #expect((sent[0].body?["context"] as? [String: Any])?["quote"] as? String == "Цитата")
        #expect(((sent[0].body?["context"] as? [String: Any])?["home"] as? [String: Any])?["homeId"] as? String == "home-wolf")
        // Lost for good: the owner drops the quote and the words go alone.
        client.sourceReachable = { _ in false }
        await client.sendMessage("А это?", context: quote)
        #expect(client.pendingMessages.count == 1)
        await client.dropContext(client.pendingMessages[0])
        let plain = fixture.requests.filter { $0.path.hasPrefix("/v1/messages") }
        #expect(plain.count == 2)
        #expect(plain[1].body?["context"] == nil)
        #expect(client.pendingMessages.isEmpty)
    }
}

// MARK: - Fixture

/// A Home as the client sees it, answering from memory. Every request is recorded with its parsed body.
@MainActor private final class OneChatFixture {
    struct Request { let method: String; let path: String; let body: [String: Any]? }
    var requests: [Request] = []
    var timeline = true
    var receipts: [String: String] = [:]
    private var sent = 0

    func respond(_ request: URLRequest) -> (Int, Data) {
        let path = request.url?.path ?? "", method = request.httpMethod ?? "GET"
        let body = method == "GET" ? nil : try? JSONSerialization.jsonObject(with: requestBody(request)) as? [String: Any]
        requests.append(Request(method: method, path: path, body: body))
        switch path {
        case "/health":
            return (200, Data(("{\"ok\":true,\"service\":\"openstrudel\",\"homeId\":\"home-1\",\"nodeId\":\"node-a\"" + (timeline ? ",\"employeeTimelineVersion\":1" : "") + ",\"turnControlVersion\":1,\"queueControlVersion\":1}").utf8))
        case "/v1/profiles":
            return (200, Data(#"{"profiles":[{"id":"emp-1","name":"Редактор","instructions":"","capabilities":[],"model":null,"tokenLimit":null,"createdAt":"2026-01-01T00:00:00.000Z"}],"importedConversations":[]}"#.utf8))
        case "/v1/integrations":
            return (200, Data(#"{"telegram":{"configured":false,"running":false,"linkedChats":[]}}"#.utf8))
        case "/v1/account":
            return (200, Data(#"{"account":{"connected":true,"email":"owner@example.invalid","planType":"plus","managed":true},"canManage":true,"loginPending":false}"#.utf8))
        case "/v1/conversation":
            return (200, Data(#"{"conversation":{"id":"chat","channel":"api","createdAt":"2026-11-01T12:00:00.000Z","updatedAt":"2026-11-01T12:00:00.000Z"},"messages":[],"interactions":[],"timeline":true,"pagination":{"olderCursor":null,"newerCursor":null,"hasMore":false}}"#.utf8))
        case "/v1/messages":
            sent += 1
            return (202, Data("{\"conversationId\":\"c-emp\",\"messageId\":\"m-\(sent)\",\"text\":\"\",\"profileId\":\"emp-1\"}".utf8))
        default:
            if path.hasPrefix("/v1/home/requests/"), let receipt = receipts[String(path.dropFirst("/v1/home/requests/".count))] { return (200, Data(receipt.utf8)) }
            return (404, Data("{}".utf8))
        }
    }
}

@MainActor private struct Harness {
    let defaults: UserDefaults
    let suite: String
    let session: URLSession
    let pendingDirectory: URL
    let home = "http://127.0.0.1:57711"

    init(_ fixture: OneChatFixture) throws {
        suite = "OpenStrudel.one-chat." + UUID().uuidString
        defaults = try #require(UserDefaults(suiteName: suite))
        defaults.set(home, forKey: "openstrudel.homeURL")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OneChatProtocol.self]
        OneChatProtocol.setHandler { request in await MainActor.run { fixture.respond(request) } }
        session = URLSession(configuration: configuration)
        pendingDirectory = FileManager.default.temporaryDirectory.appending(path: suite)
    }

    /// A client of the fixture Home under this suite's preferences and pending file.
    func client(id: String) -> HomeClient {
        HomeClient(defaults: defaults, session: session, pendingDirectory: pendingDirectory, connectionID: id, credentialReader: { _, _ in nil }, credentialWriter: { _, _ in })
    }

    /// A library whose first Home is the fixture; other Homes are unreachable paired connections.
    func library(otherHomes: Int = 0) -> DeviceLibrary {
        var clients = [client(id: "current")]
        for index in 0..<otherHomes {
            let other = UserDefaults(suiteName: suite + ".other\(index)")!
            other.set("https://other\(index).example:7789", forKey: "openstrudel.homeURL")
            clients.append(HomeClient(defaults: other, session: session, pendingDirectory: pendingDirectory.appending(path: "other\(index)"), connectionID: "other\(index)",
                                      credentialReader: { account, _ in account.hasSuffix("home-api-token") ? "fixture" : nil }, credentialWriter: { _, _ in }))
        }
        return DeviceLibrary(defaults: defaults, clients: clients, clientFactory: { _ in self.client(id: "factory") })
    }

    func close() {
        session.invalidateAndCancel()
        for domain in [suite, suite + ".other0", suite + ".other1"] { UserDefaults.standard.removePersistentDomain(forName: domain) }
        try? FileManager.default.removeItem(at: pendingDirectory)
    }
}

private extension HomeMessage {
    static func sample(id: String, text: String) -> HomeMessage {
        HomeMessage(id: id, conversationId: "c-1", channel: "api", direction: "outbound", replyToId: nil, text: text, externalId: nil, createdAt: "2026-11-01T12:00:00.000Z", status: "completed", error: nil, kind: "text")
    }
}

private func requestBody(_ request: URLRequest) -> Data {
    var data = request.httpBody ?? Data()
    if data.isEmpty, let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(contentsOf: buffer.prefix(count))
        }
    }
    return data
}

private final class OneChatProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (URLRequest) async -> (Int, Data))?
    private var operation: Task<Void, Never>?
    static func setHandler(_ handler: @escaping @Sendable (URLRequest) async -> (Int, Data)) {
        lock.lock(); defer { lock.unlock() }; self.handler = handler
    }
    private static func currentHandler() -> (@Sendable (URLRequest) async -> (Int, Data))? {
        lock.lock(); defer { lock.unlock() }; return handler
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        operation = Task { @Sendable [self] in
            guard let handler = Self.currentHandler(), let url = request.url else { return }
            let (status, data) = await handler(request)
            guard !Task.isCancelled else { return }
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { operation?.cancel() }
}
