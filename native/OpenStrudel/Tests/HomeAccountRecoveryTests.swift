import Foundation
import Combine
import Testing

@Suite(.serialized)
@MainActor struct HomeAccountRecoveryTests {
    @Test func historyBrowserSelectsTheEmployeeForPrivateChatsAndImportedArchives() async throws {
        let state = AccountFixtureState()
        state.customResponse = { request in
            if request.url?.path == "/v1/profiles" {
                return (200, Data(#"{"profiles":[],"importedConversations":[{"id":"archive","title":"Прежний разговор","profileId":"archived-employee"},{"id":"root-archive","title":"Архив помощника","profileId":null}]}"#.utf8))
            }
            if request.url?.path == "/v1/integrations" {
                return (200, Data(#"{"telegram":{"configured":true,"running":true,"linkedChats":["7"],"chats":[{"chatId":"7","title":"Мой Telegram","conversationId":"private-chat","profileId":"personal-employee","allowedSenders":[]},{"chatId":"8","title":"Без истории","allowedSenders":[]}]}}"#.utf8))
            }
            return nil
        }
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load()
        #expect(!client.homeUnreachable)
        #expect(client.importedConversations.count == 2)
        await client.selectProfile("previous-employee")
        await client.selectChat("private-chat")
        #expect(client.selectedProfileID == "personal-employee")
        #expect(client.selectedChatID == "private-chat")
        await client.selectChat(nil)
        #expect(client.selectedProfileID == "personal-employee")
        #expect(client.selectedChatID == nil)
        await client.selectChat("archive")
        #expect(client.selectedProfileID == "archived-employee")
        #expect(client.selectedChatID == "archive")
        await client.selectChat("root-archive")
        #expect(client.selectedProfileID == nil)
        #expect(client.selectedChatID == "root-archive")
    }

    @Test func groupSelectionSurvivesRelaunchAndClearsWhenOpeningAnEmployee() async throws {
        let suite = "OpenStrudel.chat-selection-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let state = AccountFixtureState()
        let telegram = TelegramStatus(configured: true, running: true, botUsername: "test_bot", botName: nil, linkedChats: ["-100"], lastError: nil,
            chats: [TelegramChat(chatId: "-100", title: "Рабочая группа", conversationId: "chat", profileId: nil, allowedSenders: [])])
        let integration = try JSONSerialization.data(withJSONObject: ["telegram": JSONSerialization.jsonObject(with: JSONEncoder().encode(telegram))])
        state.customResponse = { request in
            if request.url!.path == "/v1/integrations" { return (200, integration) }
            guard request.url!.path.contains("conversation") else { return nil }
            return (200, historyPage([42], older: nil, newer: "m42"))
        }
        let (client, session) = makeClient(state, defaults: defaults)
        defer { session.invalidateAndCancel() }
        await client.selectProfile("old-employee")
        await client.loadChatSettings()
        await client.selectChat("chat")
        let reopened = HomeClient(defaults: defaults, session: session)
        #expect(reopened.selectedChatID == "chat")
        #expect(reopened.selectedProfileID == nil)
        await reopened.refreshConversation()
        #expect(reopened.messages.map(\.id) == ["m42"])
        await reopened.selectProfile("another-employee")
        let employee = HomeClient(defaults: defaults, session: session)
        #expect(employee.selectedChatID == nil)
        #expect(employee.selectedProfileID == "another-employee")
        await employee.selectChat("chat")
        employee.beginEmployee()
        #expect(HomeClient(defaults: defaults, session: session).selectedChatID == nil)
    }

    @Test func chatPagesOnlyFetchOlderMessagesOnDemandAndKeepPendingStatusCurrent() async throws {
        let state = AccountFixtureState()
        var queries: [URLComponents] = []
        state.customResponse = { request in
            guard request.url!.path.hasSuffix("/conversation") || request.url!.path == "/v1/conversations/chat" else { return nil }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            queries.append(query)
            if query.queryItems?.contains(where: { $0.name == "before" }) == true {
                return (200, historyPage(Array(0..<50), older: nil, newer: "m49"))
            }
            if query.queryItems?.contains(where: { $0.name == "after" }) == true {
                return (200, historyPage([100], older: nil, newer: "m100", updates: [historyMessage(99)]))
            }
            return (200, historyPage(Array(50..<100), older: "m50", newer: "m99", running: 99))
        }
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.refreshConversation()
        #expect(client.messages.count == 50)
        #expect(client.hasEarlierMessages)
        await client.loadEarlierMessages()
        #expect(client.messages.map(\.id) == (0..<100).map { "m\($0)" })
        #expect(!client.hasEarlierMessages)
        await client.refreshConversation()
        #expect(client.messages.count == 101)
        #expect(client.messages.first?.id == "m0")
        #expect(client.messages.first(where: { $0.id == "m99" })?.status == "completed")
        #expect(queries.last?.queryItems?.contains(URLQueryItem(name: "after", value: "m99")) == true)
        #expect(queries.last?.queryItems?.contains(URLQueryItem(name: "watch", value: "m99")) == true)
        #expect(queries.allSatisfy { $0.queryItems?.contains(URLQueryItem(name: "limit", value: "50")) == true })
    }

    @Test func unchangedHistoryPollingDoesNotInvalidateTheWholeInterface() async throws {
        let state = AccountFixtureState()
        state.customResponse = { request in
            guard request.url!.path.contains("conversation") else { return nil }
            let after = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems?.contains(where: { $0.name == "after" }) == true
            return (200, historyPage(after ? [] : Array(0..<50), older: nil, newer: "m49"))
        }
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.refreshConversation()
        var notifications = 0
        let observation = client.objectWillChange.sink { notifications += 1 }
        await client.refreshConversation()
        await client.refreshConversation()
        #expect(client.messages.count == 50)
        #expect(notifications == 0)
        withExtendedLifetime(observation) {}
    }

    @Test func changingEmployeeDiscardsAnOlderPageThatArrivesLate() async throws {
        let state = AccountFixtureState()
        state.customResponse = { request in
            if request.url!.path == "/v1/agents/new/conversation" { return (200, historyPage([500], older: nil, newer: "m500")) }
            if request.url!.path.contains("conversation") { return (200, historyPage([1], older: "m1", newer: "m1")) }
            return nil
        }
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.refreshConversation()
        state.delay = .milliseconds(100)
        let earlier = Task { await client.loadEarlierMessages() }
        while !client.isLoadingEarlier { await Task.yield() }
        await client.selectProfile("new")
        await earlier.value
        #expect(client.selectedProfileID == "new")
        #expect(client.messages.map(\.id) == ["m500"])
        #expect(!client.isLoadingEarlier)
        #expect(!client.hasEarlierMessages)
    }
    @Test func deviceStatusAcceptsTheClientListAndInvitesTheOwnersOtherDevice() async throws {
        let state = AccountFixtureState()
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.refreshMobileStatus()
        #expect(client.canManageConnections)
        await client.inviteMobile()
        #expect(state.invitedOwner)
    }
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

    @Test func telegramPairingIsIndependentOfTheOpenEmployee() async throws {
        let state = AccountFixtureState()
        var bodies: [[String: String]] = []
        state.customResponse = { request in
            guard request.url?.path == "/v1/integrations/telegram/link" else { return nil }
            var data = request.httpBody ?? Data()
            if data.isEmpty, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    guard count > 0 else { break }
                    data.append(contentsOf: buffer.prefix(count))
                }
            }
            bodies.append((try? JSONSerialization.jsonObject(with: data) as? [String: String]) ?? [:])
            let query = bodies.last?["kind"] == "group" ? "startgroup" : "start"
            return (201, Data("{\"code\":\"fixture\",\"expiresAt\":\"2026-10-08T12:00:00.123Z\",\"url\":\"https://t.me/test_bot?\(query)=fixture\"}".utf8))
        }
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.selectProfile("open-employee")
        await client.createTelegramLink()
        #expect(bodies.last == [:])
        let group = try await client.createTelegramGroupLink(profileID: "chosen-employee")
        #expect(bodies.last == ["kind": "group", "profileId": "chosen-employee"])
        #expect(group.expiryDate != nil)
        #expect(client.telegramLink?.code == "fixture")
    }

    @Test func oldDeviceCannotTurnGroupSetupIntoPersonalPairing() async throws {
        let state = AccountFixtureState()
        state.customResponse = { request in
            guard request.url?.path == "/v1/integrations/telegram/link" else { return nil }
            return (201, Data(#"{"code":"fixture","expiresAt":"2026-10-08T12:00:00Z","url":"https://t.me/test_bot?start=fixture"}"#.utf8))
        }
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        do {
            _ = try await client.createTelegramGroupLink(profileID: "chosen-employee")
            Issue.record("A personal pairing link must not open during group setup")
        } catch { #expect(error.localizedDescription.contains("Обновите OpenStrudel")) }
    }

    @Test func queueUsesServerOrderAndConflictLeavesTheExistingMessageIntact() async throws {
        let state = AccountFixtureState()
        var queued: [[String: Any]] = [1, 2].map { index in
            var message = historyMessage(index); message["status"] = "queued"; return message
        }
        var writes = 0
        var reject = false
        state.customResponse = { request in
            let path = request.url!.path
            if path == "/health" { return (200, Data(#"{"ok":true,"turnControlVersion":1,"queueControlVersion":1}"#.utf8)) }
            if request.httpMethod == "POST" {
                writes += 1
                if reject { return (409, Data(#"{"error":"Сообщение изменено на другом устройстве."}"#.utf8)) }
                var data = request.httpBody ?? Data()
                if data.isEmpty, let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var buffer = [UInt8](repeating: 0, count: 1024)
                    while stream.hasBytesAvailable {
                        let count = stream.read(&buffer, maxLength: buffer.count)
                        guard count > 0 else { break }; data.append(contentsOf: buffer.prefix(count))
                    }
                }
                let body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                if path.hasSuffix("/queue") {
                    #expect(body["expectedMessageIds"] as? [String] == ["m1", "m2"])
                    #expect(body["messageIds"] as? [String] == ["m2", "m1"])
                    queued.reverse()
                } else {
                    #expect(body["expectedText"] as? String == "Message 2")
                    #expect(body["text"] as? String == "Revised")
                    queued[0]["text"] = "Revised"
                }
                return (200, try! JSONSerialization.data(withJSONObject: ["queuedMessages": queued]))
            }
            if path == "/v1/conversation" {
                var page = try! JSONSerialization.jsonObject(with: historyPage([], older: nil, newer: "m2")) as! [String: Any]
                page["queuedMessages"] = queued
                return (200, try! JSONSerialization.data(withJSONObject: page))
            }
            return nil
        }
        let (client, session) = makeClient(state)
        defer { session.invalidateAndCancel() }
        await client.load(); await client.refreshConversation()
        #expect(client.messages.isEmpty) // Queue is independent of the loaded history page.
        #expect(client.visibleQueuedMessages.map(\.id) == ["m1", "m2"])
        let second = try #require(client.visibleQueuedMessages.last)
        await client.moveQueuedMessageFirst(second)
        #expect(client.visibleQueuedMessages.map(\.id) == ["m2", "m1"])
        try await client.editQueuedMessage(second, text: "Revised")
        #expect(client.visibleQueuedMessages.first?.text == "Revised")
        reject = true
        do { try await client.editQueuedMessage(second, text: "Stale"); Issue.record("Stale edit must fail") }
        catch { #expect(error.localizedDescription.contains("другом устройстве")) }
        #expect(client.visibleQueuedMessages.first?.text == "Revised")
        #expect(writes == 3)
        await client.selectProfile("another-employee")
        #expect(client.visibleQueuedMessages.isEmpty)
        do { try await client.editQueuedMessage(second, text: "Wrong chat"); Issue.record("Wrong chat must fail") }
        catch { #expect(error is CancellationError) }
        #expect(writes == 3)
    }

    private func makeClient(_ state: AccountFixtureState, defaults supplied: UserDefaults? = nil) -> (HomeClient, URLSession) {
        let defaults = supplied ?? UserDefaults(suiteName: "OpenStrudel.account-test." + UUID().uuidString)!
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
    var customResponse: ((URLRequest) -> (Int, Data)?)?
    var delay: Duration?
    var healthStatus = 200
    var accountStatus = 200
    var accountBody = #"{"account":{"connected":true,"email":"owner@example.invalid","planType":"plus","managed":true},"canManage":true,"loginPending":false}"#
    var loginStatus = "pending"
    var loginStarts = 0
    var invitedOwner = false
    func respond(_ request: URLRequest) -> (Int, Data) {
        if let response = customResponse?(request) { return response }
        let status: Int
        let body: String
        switch request.url?.path {
        case "/health": status = healthStatus; body = healthStatus == 200 ? #"{"ok":true,"service":"openstrudel","agentArchiveVersion":1}"# : #"{"error":"unavailable"}"#
        case "/v1/profiles": status = 200; body = #"{"profiles":[]}"#
        case "/v1/integrations": status = 200; body = #"{"telegram":{"configured":false,"running":false,"linkedChats":[]}}"#
        case "/v1/account": status = accountStatus; body = accountBody
        case "/v1/mobile": status = 200; body = #"{"connections":0,"clients":[]}"#
        case "/v1/mobile/pairing":
            var data = request.httpBody ?? Data()
            if data.isEmpty, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    guard count > 0 else { break }
                    data.append(contentsOf: buffer.prefix(count))
                }
            }
            if let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Bool] { invitedOwner = payload["owner"] == true }
            status = 503; body = #"{"error":"Test invitation: no network access"}"#
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

private func historyMessage(_ index: Int, running: Bool = false) -> [String: Any] {
    ["id": "m\(index)", "conversationId": "chat", "channel": "api", "direction": "inbound", "text": "Message \(index)", "createdAt": "2026-10-07T12:00:00.000Z", "status": running ? "running" : "completed"]
}
private func historyPage(_ indices: [Int], older: String?, newer: String, running: Int? = nil, updates: [[String: Any]] = []) -> Data {
    try! JSONSerialization.data(withJSONObject: [
        "conversation": ["id": "chat", "channel": "api", "createdAt": "2026-10-07T12:00:00.000Z", "updatedAt": "2026-10-07T12:00:00.000Z"],
        "messages": indices.map { historyMessage($0, running: $0 == running) }, "updates": updates, "interactions": [],
        "pagination": ["olderCursor": older as Any? ?? NSNull(), "newerCursor": newer, "hasMore": false]
    ])
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
