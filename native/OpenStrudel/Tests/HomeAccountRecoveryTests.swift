import Foundation
import Testing

@Suite(.serialized)
@MainActor struct HomeAccountRecoveryTests {
    @Test func signOutSurvivesRelaunchAndPreservesUnsentMessages() async throws {
        let suite = "OpenStrudel.signout-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        let directory = FileManager.default.temporaryDirectory.appending(path: suite)
        defer { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        let home = "http://127.0.0.1:57575"
        defaults.set(home, forKey: "openstrudel.homeURL")
        let pending = PendingHomeMessage(text: "Сохранить до возвращения", profileID: nil)
        try PendingMessagesFile.save([pending], directory: directory, home: home)
        let client = HomeClient(defaults: defaults, pendingDirectory: directory)
        #expect(client.pendingMessages.count == 1)
        await client.signOutOnThisDevice()
        #expect(client.isSignedOut)
        #expect(!client.shouldRestoreConnection)
        #expect(client.pendingMessages.isEmpty)
        #expect(client.devices.isEmpty)
        #expect(client.profiles.isEmpty)
        #expect(try PendingMessagesFile.read(directory: directory, home: home) == [pending])
        let relaunched = HomeClient(defaults: defaults, pendingDirectory: directory)
        #expect(relaunched.isSignedOut)
        #expect(relaunched.normalizedBaseURL.isEmpty)
        #expect(!relaunched.hasToken)
        #expect(!relaunched.shouldRestoreConnection)
        await relaunched.sendMessage("Не отправлять после выхода")
        #expect(relaunched.pendingMessages.isEmpty)
    }

    @Test func initialConnectionWaitsForTheServerWithoutShowingAnOutage() async throws {
        let state = AccountFixtureState(); state.delay = .milliseconds(150)
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        #expect(client.isConnecting)
        #expect(!client.homeUnreachable)
        let load = Task { await client.load(quiet: true) }
        await Task.yield()
        #expect(client.isConnecting)
        #expect(client.health == nil)
        await load.value
        #expect(client.health?.ok == true)
        #expect(!client.isConnecting)
        #expect(client.connectionState == .connected)
        #expect(client.errorMessage == nil)
    }

    @Test func realFailureEndsLoadingAndQuietRetriesDoNotFlashTheLoadingScreen() async throws {
        let state = AccountFixtureState(); state.healthStatus = 503
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load(quiet: true)
        #expect(!client.isConnecting)
        #expect(client.connectionState == .unavailable)
        #expect(client.homeUnreachable)
        #expect(client.errorMessage == nil)
        state.delay = .milliseconds(100)
        let retry = Task { await client.load(quiet: true) }
        await Task.yield()
        #expect(!client.isConnecting)
        await retry.value
        state.healthStatus = 200
        let explicitRetry = Task { await client.load() }
        while !client.isLoading { await Task.yield() }
        #expect(client.isConnecting)
        await explicitRetry.value
        #expect(client.health?.ok == true)
        #expect(!client.homeUnreachable)
    }

    @Test func canceledInitialRequestAndConnectionChangeCannotProduceAFalseOutageOrRestoreOldData() async throws {
        let state = AccountFixtureState(); state.delay = .milliseconds(100)
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        let loading = Task { await client.load(quiet: true) }
        while !client.isLoading { await Task.yield() }
        loading.cancel()
        await loading.value
        #expect(!client.homeUnreachable)
        #expect(!client.isLoading)
        #expect(client.errorMessage == nil)
        let second = Task { await client.load(quiet: true) }
        while !client.isLoading { await Task.yield() }
        client.disconnectFromMac()
        await second.value
        #expect(client.health == nil)
        #expect(client.connectionState == .idle)
        #expect(client.messages.isEmpty)
        #expect(!client.homeUnreachable)
    }

    @Test func draftsStayWithTheirHomeAcrossUpgradeAndAccountRecovery() throws {
        let suite = "OpenStrudel.drafts-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(["main:personal": "Не отправлять на другой сервер"], forKey: "openstrudel.drafts")
        HomeDrafts.migrate(defaults, currentHome: "https://home-a.example:7790/")
        let key = HomeDrafts.key(home: "https://home-a.example:7790", profile: nil, chat: nil)
        #expect((defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String])?[key] == "Не отправлять на другой сервер")
        HomeDrafts.migrate(defaults, currentHome: "https://home-b.example:7790")
        let drafts = try #require(defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String])
        #expect(drafts[HomeDrafts.key(home: "https://home-b.example:7790", profile: nil, chat: nil)] == nil)
        #expect(drafts[key] == "Не отправлять на другой сервер")
        #expect(drafts.count == 1)
    }

    @Test func rejectedOpenAIAuthorizationDoesNotDiscardTheHealthyHomeOrHistory() async throws {
        let state = AccountFixtureState()
        state.accountStatus = 400
        state.accountBody = #"{"error":"workspace routing discovery unauthorized (401)"}"#
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load()
        #expect(client.health?.ok == true)
        #expect(!client.homeUnreachable)
        #expect(!client.connectionNeedsPairing)
        #expect(client.errorMessage == nil)
        #expect(client.openAIAccount?.needsSignInAgain == true)
        #expect(client.messages.first?.text == "Сохранённая история")
        #expect(client.hasOpenedConversation)
        #expect(client.canManageOpenAI)
    }

    @Test func secondaryDeviceUsesSharedAccountAndCannotStartItsOwnLogin() async throws {
        let state = AccountFixtureState()
        state.accountBody = #"{"account":{"connected":true,"email":"owner@example.invalid","planType":"plus","managed":true},"canManage":false,"loginPending":false}"#
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load()
        #expect(client.openAIAccount?.connected == true)
        #expect(!client.canManageOpenAI)
        await client.beginOpenAILogin()
        #expect(state.loginStarts == 0)

        state.accountBody = #"{"account":{"connected":false,"email":null,"planType":null,"managed":true,"issue":"sign_in_required"},"canManage":false,"loginPending":true}"#
        await client.refreshOpenAIAccount(force: true)
        #expect(client.openAILoginPending)
        #expect(client.openAIRecoveryMessage.contains("другом устройстве"))
        #expect(client.messages.first?.text == "Сохранённая история")

        state.accountBody = #"{"account":{"connected":true,"email":"owner@example.invalid","planType":"plus","managed":true},"canManage":false,"loginPending":false}"#
        await client.refreshOpenAIAccount()
        #expect(client.openAIAccount?.connected == true)
        #expect(!client.openAILoginPending)
        #expect(state.loginStarts == 0)
    }

    @Test func temporaryOpenAIFailureIsRetryableAndDoesNotClearHistory() async throws {
        let state = AccountFixtureState()
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load()
        state.accountStatus = 503
        state.accountBody = #"{"error":"upstream temporarily unavailable"}"#
        await client.refreshOpenAIAccount(force: true)
        #expect(client.openAIAccount?.isUnavailable == true)
        #expect(client.openAIAccount?.needsSignInAgain == false)
        #expect(client.health?.ok == true)
        #expect(client.messages.count == 1)
        #expect(client.errorMessage == nil)
    }

    @Test func outageCannotStartAnUnnecessaryLogin() async throws {
        let state = AccountFixtureState()
        state.accountBody = #"{"account":{"connected":false,"managed":true,"issue":"unavailable"},"canManage":true}"#
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load()
        await client.beginOpenAILogin()
        #expect(state.loginStarts == 0)
        #expect(client.openAILogin == nil)
        state.accountBody = #"{"account":{"connected":false,"managed":true,"issue":"sign_in_required"},"canManage":true}"#
        await client.refreshOpenAIAccount(force: true)
        await client.beginOpenAILogin()
        #expect(state.loginStarts == 1)
    }

    @Test func revokedHomePairingStillRequiresReconnection() async throws {
        let state = AccountFixtureState()
        state.accountStatus = 401
        state.accountBody = #"{"error":"unauthorized"}"#
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load(quiet: true)
        #expect(client.connectionNeedsPairing)
        #expect(client.health == nil)
    }

    @Test func canceledLoginAfterServerRestartStopsPollingAndCanBeStartedAgain() async throws {
        let state = AccountFixtureState()
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load()
        await client.beginOpenAILogin()
        #expect(client.openAILogin != nil)
        state.loginStatus = "canceled"
        await client.pollOpenAILogin()
        #expect(client.openAILogin == nil)
        #expect(client.openAIErrorMessage?.contains("истёк") == true)
        #expect(client.errorMessage == nil)
        await client.beginOpenAILogin()
        #expect(state.loginStarts == 2)
        #expect(client.openAIErrorMessage == nil)
    }

    private func makeClient(_ state: AccountFixtureState) -> (HomeClient, URLSession) {
        let defaults = UserDefaults(suiteName: "OpenStrudel.account-test." + UUID().uuidString)!
        defaults.set("http://127.0.0.1:57575", forKey: "openstrudel.homeURL")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountTestURLProtocol.self]
        AccountTestURLProtocol.setHandler { request in
            let delay = await MainActor.run { state.delay }
            if let delay { try? await Task.sleep(for: delay) }
            return await MainActor.run { state.respond(request) }
        }
        let session = URLSession(configuration: configuration)
        return (HomeClient(defaults: defaults, session: session), session)
    }
}

@MainActor private final class AccountFixtureState {
    var delay: Duration?
    var healthStatus = 200
    var accountStatus = 200
    var accountBody = #"{"account":{"connected":true,"email":"owner@example.invalid","planType":"plus","managed":true},"canManage":true,"loginPending":false}"#
    var loginStatus = "pending"
    var loginStarts = 0
    func respond(_ request: URLRequest) -> (Int, Data) {
        let status: Int
        let body: String
        switch request.url?.path {
        case "/health": status = healthStatus; body = healthStatus == 200 ? #"{"ok":true,"service":"openstrudel","agentArchiveVersion":1}"# : #"{"error":"unavailable"}"#
        case "/v1/profiles": status = 200; body = #"{"profiles":[]}"#
        case "/v1/integrations": status = 200; body = #"{"telegram":{"configured":false,"running":false,"linkedChats":[]}}"#
        case "/v1/account": status = accountStatus; body = accountBody
        case "/v1/mobile": status = 200; body = #"{"connections":0}"#
        case "/v1/account/login":
            loginStarts += 1; status = 201
            body = #"{"type":"browser","loginId":"test-login","authUrl":"https://auth.openai.com/test"}"#
        case "/v1/account/login/test-login": status = 200; body = "{\"loginId\":\"test-login\",\"status\":\"\(loginStatus)\"}"
        case "/v1/conversation":
            status = 200
            body = #"{"conversation":{"id":"chat","channel":"api","createdAt":"2026-10-04T12:00:00.000Z","updatedAt":"2026-10-04T12:00:00.000Z"},"messages":[{"id":"message","conversationId":"chat","channel":"api","direction":"inbound","text":"Сохранённая история","createdAt":"2026-10-04T12:00:00.000Z"}],"interactions":[]}"#
        default: status = 404; body = "{}"
        }
        return (status, Data(body.utf8))
    }
}

private final class AccountTestURLProtocol: URLProtocol, @unchecked Sendable {
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
