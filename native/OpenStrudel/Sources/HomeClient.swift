import Combine
import Foundation
import Security

private enum KeychainStore {
    private static let service: String = {
        let bundle = Bundle.main.bundleIdentifier ?? "is.openstrudel.mac"
        return ["is.openstrudel.mac", "is.openstrudel.ios"].contains(bundle) ? "is.openstrudel.native" : bundle + ".credentials"
    }()

    static func read(account: String = "home-api-token") -> String? {
        #if os(macOS)
        // Legacy macOS keychains can ignore kSecUseAuthenticationUIFail.
        // Read silently at launch; an explicit pairing can unlock/save later.
        SecKeychainSetUserInteractionAllowed(false)
        defer { SecKeychainSetUserInteractionAllowed(true) }
        #endif
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        #if os(iOS)
        query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
        #endif
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        #if DEBUG
        if status != errSecSuccess { NSLog("OpenStrudel credential lookup: %d", status) }
        #endif
        guard status == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ value: String, account: String = "home-api-token") throws {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let values: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item.merge(values) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw HomeClientError.server("Не удалось сохранить подключение в Связке ключей. Разблокируйте устройство и повторите подключение.")
        }
    }

    static func remove(account: String = "home-api-token") {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

@MainActor
final class HomeClient: ObservableObject {
    @Published var pendingPairing: MacPairing?
    @Published var pairingError: String?
    @Published private(set) var isPairing = false
    @Published private(set) var connectionName = "OpenStrudel"
    @Published private(set) var connectionNeedsPairing = false
    private var connectionGeneration = 0
    @Published private(set) var mobileInvitation: MobileInvitation?
    @Published private(set) var mobileConnections = 0
    @Published private(set) var canManageConnections = false
    @Published var baseURLString: String
    @Published private(set) var health: HomeHealth?
    @Published private(set) var messages: [HomeMessage] = []
    @Published private(set) var profiles: [EmployeeProfile] = []
    @Published private(set) var telegram: TelegramStatus?
    @Published private(set) var telegramLink: TelegramLinkResponse?
    @Published private(set) var openAIAccount: OpenAIAccount?
    @Published private(set) var openAILogin: OpenAILogin?
    @Published private(set) var openAILoginStatus: OpenAILoginStatus?
    @Published private(set) var isStartingOpenAILogin = false
    @Published private(set) var canManageOpenAI = false
    @Published private(set) var openAILoginPending = false
    @Published private(set) var openAIErrorMessage: String?
    @Published private(set) var hasOpenedConversation = false
    private var checkingOpenAIAccount = false
    @Published private(set) var isLoading = false
    @Published private(set) var homeUnreachable = false
    @Published private(set) var interactions: [ChatInteraction] = []
    @Published private(set) var connections: [ServiceConnection] = []
    @Published private(set) var connectionNotice: String?
    @Published private(set) var schedules: [ChatSchedule] = []
    @Published private(set) var scheduleRuns: [ScheduleRun] = []
    @Published private(set) var selectedChatID: String?
    @Published private(set) var historyLimit = 100
    @Published var syncError: String?
    @Published private(set) var isCreating = false
    @Published var draftEmployeeDomain = "personal"
    private var refreshGeneration = 0
    var visiblePendingMessages: [PendingHomeMessage] {
        pendingMessages.filter { pending in pending.profileID == selectedProfileID && pending.conversationID == selectedChatID && !messages.contains(where: { $0.externalId == pending.id.uuidString }) }
    }
    var isSending: Bool {
        messages.contains { $0.status == "queued" || $0.status == "running" } || visiblePendingMessages.contains { $0.error == nil }
    }
    @Published private(set) var pendingMessages: [PendingHomeMessage] = []
    @Published var errorMessage: String?
    @Published private(set) var conversationID: String?
    @Published private(set) var selectedProfileID: String?

    private let defaults: UserDefaults
    private var token: String?
    private var session: URLSession = .shared
    private let decoder = JSONDecoder()
    private var isDrainingSendQueue = false

    init(defaults: UserDefaults = .standard, session transport: URLSession = .shared) {
        self.defaults = defaults
        self.session = transport
        #if os(macOS)
        self.baseURLString = defaults.string(forKey: "openstrudel.homeURL") ?? "http://127.0.0.1:7788"
        #else
        self.baseURLString = defaults.string(forKey: "openstrudel.homeURL") ?? ""
        #endif
        self.token = KeychainStore.read()
        if let saved = KeychainStore.read(account: "home-connection"),
           let connection = try? JSONDecoder().decode(HomeConnection.self, from: Data(saved.utf8)),
           let url = URL(string: connection.url), url.scheme == "https", let host = url.host {
            baseURLString = connection.url
            token = connection.token
            connectionName = connection.name
            session = PinnedHomeSession(host: host, port: url.port ?? 443, pin: connection.pin).session()
        }
        #if os(macOS)
        if let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
           let data = try? Data(contentsOf: directory.appending(path: "OpenStrudel/LocalConnection.json")),
           let local = try? JSONDecoder().decode([String: String].self, from: data),
           local["url"] == baseURLString {
            self.token = local["token"]
        }
        #endif
        self.conversationID = defaults.string(forKey: "openstrudel.conversationID")
        self.selectedProfileID = defaults.string(forKey: "openstrudel.profileID")
        if let url = URL(string: baseURLString), url.scheme == "https", session === URLSession.shared {
            if let host = url.host, let pin = KeychainStore.read(account: "home-certificate-pin"), token != nil {
                session = PinnedHomeSession(host: host, port: url.port ?? 443, pin: pin).session()
                connectionName = defaults.string(forKey: "openstrudel.connectionName") ?? "ваш Mac или сервер"
            } else {
                // A URL alone is not a connection. Re-pair if its Keychain
                // credentials are unavailable instead of using unpinned HTTPS.
                baseURLString = ""
            }
        }
    }

    var isConfigured: Bool {
        guard let url = URL(string: normalizedBaseURL) else { return false }
        return ["http", "https"].contains(url.scheme) && url.host != nil
    }

    var hasToken: Bool {
        !(token?.isEmpty ?? true)
    }

    var openAIRecoveryMessage: String {
        if openAIAccount?.isUnavailable == true {
            return "Связь с вашим Mac или сервером сохранена. Проверим OpenAI снова автоматически. Чаты и черновики остаются на месте."
        }
        if openAILoginPending && openAILogin == nil {
            return "Вход уже открыт на другом устройстве. Завершите его на странице OpenAI; подключение обновится здесь автоматически."
        }
        if !canManageOpenAI {
            return "Войдите в OpenAI на основном Mac или устройстве, с которого настроили сервер. Здесь подключение восстановится автоматически; отдельный вход не нужен."
        }
        return "Войдите в OpenAI один раз для основного Mac или сервера. Подключённые устройства продолжат работу автоматически. Чаты и черновики сохранены."
    }

    var isLocalConnection: Bool {
        guard let host = URL(string: normalizedBaseURL)?.host else { return false }
        return ["localhost", "127.0.0.1", "::1"].contains(host)
    }

    #if os(macOS)
    func startLocalHome() async {
        do {
            let connection = try await LocalHome.start()
            if normalizedBaseURL != connection["url"] {
                KeychainStore.remove(account: "home-connection")
                resetConnectionState()
            }
            token = connection["token"]
            baseURLString = connection["url"]!
            defaults.set(baseURLString, forKey: "openstrudel.homeURL")
            await load()
        } catch { errorMessage = error.localizedDescription }
    }
    #endif

    var normalizedBaseURL: String {
        let value = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.hasSuffix("/") ? String(value.dropLast()) : value
    }

    var activeProfile: EmployeeProfile? {
        guard let selectedProfileID else { return nil }
        return profiles.first { $0.id == selectedProfileID }
    }

    var activeAgentName: String {
        isEmployeeDraft ? "Новый сотрудник" : activeProfile?.name ?? "OpenStrudel"
    }

    var isEmployeeDraft: Bool { selectedProfileID?.hasPrefix("draft:") == true }

    var activeAgentSubtitle: String {
        activeProfile?.instructions ?? "Главный собеседник"
    }

    func preparePairing(_ url: URL) {
        do {
            let pairing = try MacPairing(url: url)
            errorMessage = nil
            pairingError = nil
            pendingPairing = pairing
        }
        catch { errorMessage = error.localizedDescription }
    }

    func connectToMac(_ pairing: MacPairing) async -> Bool {
        guard !isPairing else { return false }
        isPairing = true
        pairingError = nil
        defer { isPairing = false }
        let pairedSession = PinnedHomeSession(host: pairing.host, port: pairing.port, pin: pairing.pin).session()
        do {
            var request = URLRequest(url: URL(string: pairing.baseURL + "/pair")!)
            request.httpMethod = "POST"
            request.setValue("Bearer " + pairing.key, forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 20
            let (data, response) = try await pairedSession.data(for: request)
            guard let response = response as? HTTPURLResponse else { throw HomeClientError.invalidResponse }
            if response.statusCode == 401 {
                throw HomeClientError.server("Приглашение истекло или уже использовано. Создайте новое в настройках OpenStrudel на компьютере.")
            }
            guard response.statusCode == 200 else { throw HomeClientError.invalidResponse }
            let credential = try decoder.decode([String: String].self, from: data)
            guard let token = credential["token"], !token.isEmpty else { throw HomeClientError.invalidResponse }
            let connection = HomeConnection(url: pairing.baseURL, token: token, pin: pairing.pin, name: pairing.name)
            try installConnection(connection, using: pairedSession)
            pendingPairing = nil
            await load(quiet: true)
            // The invitation was consumed successfully. A temporary load failure
            // must retry with the saved credential, not redeem the invitation again.
            return true
        } catch {
            pairedSession.invalidateAndCancel()
            if let error = error as? HomeClientError { pairingError = error.localizedDescription }
            else { pairingError = "Не удалось связаться с этим Mac или сервером. Проверьте его подключение к интернету и попробуйте ещё раз." }
            return false
        }
    }

    /// Cloud setup has already authenticated this installation against its
    /// pre-generated key. Keep the same saved connection used by QR pairing.
    func connectToCloud(_ connection: HomeConnection) async -> Bool {
        guard !isPairing,
              let url = URL(string: connection.url), url.scheme == "https",
              let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              connection.pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              connection.token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return false }
        isPairing = true
        defer { isPairing = false }
        let cloudSession = PinnedHomeSession(host: host, port: url.port ?? 443, pin: connection.pin).session()
        do {
            try installConnection(connection, using: cloudSession)
            await load(quiet: true)
            return true
        } catch {
            cloudSession.invalidateAndCancel()
            pairingError = error.localizedDescription
            return false
        }
    }

    private func installConnection(_ connection: HomeConnection, using newSession: URLSession) throws {
        let saved = String(decoding: try JSONEncoder().encode(connection), as: UTF8.self)
        // Preserve the previous connection until the replacement is safely saved.
        try KeychainStore.save(saved, account: "home-connection")
        resetConnectionState()
        token = connection.token
        baseURLString = connection.url
        connectionName = connection.name
        defaults.set(baseURLString, forKey: "openstrudel.homeURL")
        defaults.set(connectionName, forKey: "openstrudel.connectionName")
        session = newSession
    }

    func disconnectFromMac() {
        resetConnectionState()
        KeychainStore.remove(account: "home-connection")
        KeychainStore.remove()
        KeychainStore.remove(account: "home-certificate-pin")
    }

    private func resetConnectionState() {
        connectionGeneration += 1
        refreshGeneration += 1
        if session !== URLSession.shared { session.invalidateAndCancel() }
        session = .shared
        token = nil
        baseURLString = ""
        connectionName = "OpenStrudel"
        ["openstrudel.homeURL", "openstrudel.connectionName", "openstrudel.conversationID", "openstrudel.profileID"].forEach { defaults.removeObject(forKey: $0) }
        health = nil; messages = []; profiles = []; interactions = []; pendingMessages = []
        conversationID = nil; selectedProfileID = nil; selectedChatID = nil
        telegram = nil; openAIAccount = nil; connections = []; schedules = []; scheduleRuns = []
        openAILogin = nil; openAILoginStatus = nil; isStartingOpenAILogin = false
        canManageOpenAI = false; openAILoginPending = false; openAIErrorMessage = nil
        hasOpenedConversation = false; checkingOpenAIAccount = false
        errorMessage = nil; syncError = nil; homeUnreachable = false
        connectionNeedsPairing = false; isLoading = false
        canManageConnections = false; mobileConnections = 0; mobileInvitation = nil
    }

    func inviteMobile() async {
        mobileInvitation = nil
        await refreshMobileStatus()
        do { mobileInvitation = try await request("/v1/mobile/pairing", method: "POST") }
        catch { errorMessage = error.localizedDescription }
    }

    func refreshMobileStatus() async {
        if let status: [String: Int] = try? await request("/v1/mobile") {
            mobileConnections = status["connections"] ?? 0
            canManageConnections = true
            if openAIAccount != nil { canManageOpenAI = true }
        } else { canManageConnections = false }
    }

    func cancelMobileInvitation() async {
        mobileInvitation = nil
        let _: [String: Bool]? = try? await request("/v1/mobile/pairing", method: "DELETE")
    }

    func revokeMobile() async {
        do {
            let _: [String: Bool] = try await request("/v1/mobile", method: "DELETE")
            mobileInvitation = nil; mobileConnections = 0
        } catch { errorMessage = error.localizedDescription }
    }

    /// A quiet load retries in the background without raising an alert.
    func load(quiet: Bool = false) async {
        guard !isLoading else { return }
        let generation = connectionGeneration
        guard isConfigured else {
            if !quiet { errorMessage = "Подключитесь к своему Mac или серверу через приглашение." }
            return
        }
        isLoading = true
        if !quiet { errorMessage = nil }
        do {
            async let healthRequest: HomeHealth = request("/health")
            async let profilesRequest: ProfilesEnvelope = request("/v1/profiles")
            async let integrationsRequest: TelegramEnvelope = request("/v1/integrations")
            async let accountRequest = loadOpenAIAccount()
            let (loadedHealth, loadedProfiles, loadedIntegrations, loadedAccount) = try await (
                healthRequest,
                profilesRequest,
                integrationsRequest,
                accountRequest
            )
            guard generation == connectionGeneration else { return }
            health = loadedHealth
            if profiles != loadedProfiles.profiles { profiles = loadedProfiles.profiles }
            telegram = loadedIntegrations.telegram
            applyOpenAIAccount(loadedAccount)
            if let selectedProfileID, !isEmployeeDraft, !profiles.contains(where: { $0.id == selectedProfileID }) {
                self.selectedProfileID = nil
                defaults.removeObject(forKey: "openstrudel.profileID")
            }
            homeUnreachable = false
            connectionNeedsPairing = false
            if loadedAccount.canManage == nil { await refreshMobileStatus() }
            await refreshConversation()
        } catch {
            guard generation == connectionGeneration else { return }
            homeUnreachable = true
            if case HomeClientError.authenticationExpired = error { connectionNeedsPairing = true }
            if !quiet { errorMessage = error.localizedDescription }
        }
        if generation == connectionGeneration { isLoading = false }
    }

    private func loadOpenAIAccount(force: Bool = false) async throws -> OpenAIAccountEnvelope {
        do {
            let envelope: OpenAIAccountEnvelope = try await request("/v1/account" + (force ? "?refresh=true" : ""))
            return envelope
        } catch HomeClientError.authenticationExpired {
            // The Home's own credential was revoked; this still needs pairing.
            throw HomeClientError.authenticationExpired
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // Older Homes return a raw Codex error. Keep their healthy local
            // connection usable and offer account recovery instead of setup.
            let message = error.localizedDescription.lowercased()
            let signInRequired = message.contains("unauthorized") || message.contains("invalid_grant")
                || message.contains("refresh_token_expired") || message.contains("refresh_token_reused")
                || message.contains("refresh_token_invalidated")
            return OpenAIAccountEnvelope(account: OpenAIAccount(connected: false, email: nil, planType: nil, managed: true,
                                 issue: signInRequired ? "sign_in_required" : "unavailable"))
        }
    }

    private func applyOpenAIAccount(_ envelope: OpenAIAccountEnvelope) {
        openAIAccount = envelope.account
        canManageOpenAI = envelope.canManage ?? (isLocalConnection || canManageConnections)
        openAILoginPending = envelope.loginPending ?? false
        if envelope.account.connected { hasOpenedConversation = true }
    }

    func refreshOpenAIAccount(force: Bool = false) async {
        guard health != nil, !checkingOpenAIAccount else { return }
        let generation = connectionGeneration
        checkingOpenAIAccount = true
        defer { if generation == connectionGeneration { checkingOpenAIAccount = false } }
        do {
            let account = try await loadOpenAIAccount(force: force)
            guard generation == connectionGeneration else { return }
            applyOpenAIAccount(account)
        } catch {
            guard generation == connectionGeneration else { return }
            if case HomeClientError.authenticationExpired = error { connectionNeedsPairing = true; health = nil }
        }
    }

    func sendMessage(_ text: String, files: [PickedFile] = []) async {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty || !files.isEmpty else { return }
        pendingMessages.append(PendingHomeMessage(text: value, profileID: selectedProfileID, conversationID: selectedChatID, files: files, draftDomain: draftEmployeeDomain))
        guard !isDrainingSendQueue else { return }
        isDrainingSendQueue = true
        await drainSendQueue()
    }

    private func drainSendQueue() async {
        defer { isDrainingSendQueue = false }
        while let pending = pendingMessages.first(where: { $0.error == nil }) {
            do {
                var profileID = pending.profileID
                if let draftID = profileID, draftID.hasPrefix("draft:") {
                    isCreating = true
                    defer { isCreating = false }
                    let body = try JSONSerialization.data(withJSONObject: ["creationId": String(draftID.dropFirst(6)), "domain": pending.draftDomain])
                    let created: ProfileResponse = try await request("/v1/profiles", method: "POST", body: body)
                    profiles.append(created.profile)
                    for i in pendingMessages.indices where pendingMessages[i].profileID == draftID { pendingMessages[i].profileID = created.profile.id }
                    profileID = created.profile.id
                    if selectedProfileID == draftID { selectedProfileID = created.profile.id; defaults.set(created.profile.id, forKey: "openstrudel.profileID") }
                }
                var payload: [String: Any] = ["channel": "api", "text": pending.text, "externalChatId": "home", "externalId": pending.id.uuidString]
                if let profileID { payload["profile"] = profileID }
                if let conversationID = pending.conversationID { payload["conversationId"] = conversationID }
                if !pending.files.isEmpty {
                    let path = pending.conversationID.map { "/v1/conversations/" + $0 } ?? profileID.map { "/v1/agents/" + $0 + "/conversation" } ?? "/v1/conversation"
                    let chat: ConversationEnvelope = try await request(path)
                    var attachments: [String] = []
                    for file in pending.files {
                        let upload = try JSONSerialization.data(withJSONObject: ["id": file.id.uuidString, "name": file.name, "mimeType": file.mimeType, "contentBase64": file.data.base64EncodedString()])
                        let saved: AttachmentEnvelope = try await request("/v1/conversations/" + chat.conversation.id + "/files", method: "POST", body: upload)
                        attachments.append(saved.attachment.id)
                    }
                    payload["conversationId"] = chat.conversation.id
                    payload["attachments"] = attachments
                }
                let body = try JSONSerialization.data(withJSONObject: payload)
                let result: HomeMessageResponse = try await request("/v1/messages?async=true", method: "POST", body: body)
                if let routed = result.profileId, pending.profileID == nil, selectedProfileID == nil {
                    await selectProfile(routed)
                } else { await refreshConversation() }
                pendingMessages.removeAll { $0.id == pending.id }
            } catch {
                if let i = pendingMessages.firstIndex(where: { $0.id == pending.id }) {
                    pendingMessages[i].error = "Не удалось подтвердить доставку. Повтор проверит это же сообщение."
                }
            }
        }
    }

    func previewFile(_ file: ChatAttachment) async -> URL? {
        do {
            return try await downloadFile(file)
        } catch { errorMessage = "Не удалось открыть файл. Проверьте соединение и повторите."; return nil }
    }

    func downloadFile(_ file: ChatAttachment) async throws -> URL {
        let bytes = try await requestData("/v1/files/" + file.id)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("OpenStrudelFiles").appendingPathComponent(file.id)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safeName = URL(fileURLWithPath: file.name).lastPathComponent
        let url = folder.appendingPathComponent(safeName.isEmpty || safeName == "." || safeName == ".." ? "file" : safeName)
        try bytes.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        return url
    }

    func retry(_ pending: PendingHomeMessage) async {
        guard let i = pendingMessages.firstIndex(where: { $0.id == pending.id }) else { return }
        pendingMessages[i].error = nil
        guard !isDrainingSendQueue else { return }
        isDrainingSendQueue = true
        await drainSendQueue()
    }

    func refreshConversation() async {
        guard !isEmployeeDraft else { return }
        let profileID = selectedProfileID
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let path = selectedChatID.map { "/v1/conversations/" + $0 } ?? profileID.map { "/v1/agents/" + $0 + "/conversation" } ?? "/v1/conversation"
            async let chat: ConversationEnvelope = request(path + "?limit=" + String(historyLimit))
            async let people: ProfilesEnvelope = request("/v1/profiles")
            let (envelope, loadedProfiles) = try await (chat, people)
            guard generation == refreshGeneration, profileID == selectedProfileID else { return }
            profiles = loadedProfiles.profiles
            conversationID = envelope.conversation.id
            if messages != envelope.messages { messages = envelope.messages }
            if !messages.isEmpty || !profiles.isEmpty { hasOpenedConversation = true }
            if interactions != envelope.interactions ?? [] { interactions = envelope.interactions ?? [] }
            syncError = nil
        } catch {
            guard generation == refreshGeneration, profileID == selectedProfileID else { return }
            if case HomeClientError.authenticationExpired = error { connectionNeedsPairing = true; health = nil }
            syncError = "Нет связи. Сообщения появятся после подключения."
        }
    }

    func loadConnections(refresh: Bool = false) async throws {
        let query = "?refresh=" + String(refresh) + (conversationID.map { "&conversationId=" + $0 } ?? "")
        let result: ConnectionsEnvelope = try await request("/v1/connections" + query)
        connections = result.connections
        connectionNotice = result.notice
    }

    func loadChatSettings() async {
        do {
            let value: TelegramEnvelope = try await request("/v1/integrations")
            telegram = value.telegram
            if let conversationID {
                let result: SchedulesEnvelope = try await request("/v1/conversations/" + conversationID + "/schedules")
                schedules = result.schedules; scheduleRuns = result.runs
            }
        } catch { syncError = error.localizedDescription }
    }

    func selectChat(_ id: String?) async {
        selectedChatID = id
        historyLimit = 100
        messages = []
        await refreshConversation()
    }
    func loadEarlierMessages() async {
        historyLimit += 100
        await refreshConversation()
    }

    func bindTelegram(chatID: String, profileID: String?) async {
        do {
            let body = try JSONSerialization.data(withJSONObject: ["profileId": profileID as Any? ?? NSNull()])
            let response: TelegramEnvelope = try await request("/v1/integrations/telegram/chats/" + chatID, method: "PATCH", body: body)
            telegram = response.telegram
            await refreshConversation()
        } catch { errorMessage = error.localizedDescription }
    }

    func setSchedule(_ schedule: ChatSchedule, enabled: Bool) async {
        do {
            var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(schedule)) as! [String: Any]
            object["enabled"] = enabled
            let body = try JSONSerialization.data(withJSONObject: object)
            let _: ScheduleResponse = try await request("/v1/conversations/" + schedule.conversationId + "/schedules", method: "POST", body: body)
            await loadChatSettings()
        } catch { errorMessage = error.localizedDescription }
    }

    func connectService(_ id: String) async throws -> URL? {
        var value = ["id": id]
        if let conversationID { value["conversationId"] = conversationID }
        let body = try JSONSerialization.data(withJSONObject: value)
        let result: ConnectionLink = try await request("/v1/connections/connect", method: "POST", body: body)
        return result.url.flatMap { URL(string: $0) }
    }

    func answer(_ interaction: ChatInteraction, answers: [String: String]) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["conversationId": interaction.conversationId, "answers": answers])
        let _: [String: Bool] = try await request("/v1/interactions/" + interaction.id, method: "POST", body: body)
        await refreshConversation()
    }

    func selectProfile(_ profileID: String?) async {
        selectedChatID = nil
        historyLimit = 100
        refreshGeneration += 1
        messages = []
        interactions = []
        selectedProfileID = profileID
        if let profileID {
            defaults.set(profileID, forKey: "openstrudel.profileID")
        } else {
            defaults.removeObject(forKey: "openstrudel.profileID")
        }
        await refreshConversation()
    }

    func beginEmployee() {
        refreshGeneration += 1
        selectedProfileID = "draft:" + UUID().uuidString
        selectedChatID = nil; conversationID = nil
        messages = []; interactions = []; schedules = []
        draftEmployeeDomain = "personal"
    }

    @discardableResult
    func createProfile(name: String = "", instructions: String = "") async -> Bool {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isCreating else { return false }
        isCreating = true
        defer { isCreating = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: [
                "name": cleanName,
                "instructions": cleanInstructions
            ])
            let response: ProfileResponse = try await request("/v1/profiles", method: "POST", body: body)
            profiles.append(response.profile)
            await selectProfile(response.profile.id)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func updateProfile(id: String, name: String, instructions: String, purpose: String? = nil) async -> Bool {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { return false }
        do {
            var payload: [String: Any] = [
                "name": cleanName,
                "instructions": cleanInstructions
            ]
            if let purpose { payload["purpose"] = purpose }
            let body = try JSONSerialization.data(withJSONObject: payload)
            let response: ProfileResponse = try await request("/v1/profiles/" + id, method: "PATCH", body: body)
            if let index = profiles.firstIndex(where: { $0.id == id }) {
                profiles[index] = response.profile
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func disconnectTelegram() async {
        do {
            let response: TelegramEnvelope = try await request("/v1/integrations/telegram", method: "DELETE")
            telegram = response.telegram
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createTelegramLink() async {
        do {
            telegramLink = try await request("/v1/integrations/telegram/link", method: "POST")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func beginOpenAILogin() async {
        guard canManageOpenAI, !openAILoginPending, !isStartingOpenAILogin, openAILogin == nil else { return }
        let generation = connectionGeneration
        isStartingOpenAILogin = true
        openAIErrorMessage = nil
        defer { if generation == connectionGeneration { isStartingOpenAILogin = false } }
        do {
            #if os(iOS)
            let method = "device"
            #else
            let host = URL(string: normalizedBaseURL)?.host?.lowercased()
            let method = ["localhost", "127.0.0.1", "::1"].contains(host ?? "") ? "browser" : "device"
            #endif
            let body = try JSONSerialization.data(withJSONObject: ["method": method])
            openAILogin = try await request("/v1/account/login", method: "POST", body: body)
            openAILoginStatus = nil
        } catch {
            guard generation == connectionGeneration, !(error is CancellationError) else { return }
            openAIErrorMessage = "Не удалось открыть вход в OpenAI. Проверьте соединение и попробуйте ещё раз."
        }
    }

    func pollOpenAILogin() async {
        guard let login = openAILogin else { return }
        do {
            let status: OpenAILoginStatus = try await request("/v1/account/login/" + login.loginId)
            guard openAILogin?.loginId == login.loginId, !Task.isCancelled else { return }
            openAILoginStatus = status
            if status.status == "completed" {
                openAILogin = nil
                openAIAccount = status.account
                await load()
            } else if status.status == "failed" || status.status == "canceled" {
                openAIErrorMessage = status.status == "canceled"
                    ? "Вход отменён или истёк. Нажмите «Войти с OpenAI», чтобы попробовать снова."
                    : "Вход в OpenAI не завершён. Попробуйте ещё раз."
                openAILogin = nil
            }
        } catch {
            guard openAILogin?.loginId == login.loginId, !Task.isCancelled else { return }
            openAIErrorMessage = "Не удалось проверить завершение входа. Проверим снова, когда восстановится связь."
        }
    }

    func cancelOpenAILogin() async {
        guard let login = openAILogin else { return }
        openAILogin = nil
        openAILoginStatus = nil
        openAIErrorMessage = nil
        do {
            let _: OpenAILoginStatus = try await request("/v1/account/login/" + login.loginId + "/cancel", method: "POST")
        } catch {
            openAIErrorMessage = "Не удалось подтвердить отмену. Незавершённый вход истечёт автоматически."
        }
    }

    func logoutOpenAI() async {
        do {
            let envelope: OpenAIAccountEnvelope = try await request("/v1/account/logout", method: "POST")
            openAIAccount = envelope.account
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        let data = try await requestData(path, method: method, body: body)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw HomeClientError.server("Не удалось прочитать ответ Home: " + error.localizedDescription)
        }
    }

    private func requestData(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        let generation = connectionGeneration
        guard let url = URL(string: normalizedBaseURL + path) else { throw HomeClientError.invalidURL }
        guard (url.scheme == "http" && isLocalConnection)
                || (url.scheme == "https" && session !== URLSession.shared && hasToken) else {
            throw HomeClientError.server("Подключите OpenStrudel через приглашение с вашего Mac.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        // Codex can search, edit files and work for several minutes. Keep one
        // simple request path and let the native client wait for that turn.
        request.timeoutInterval = path == "/health" ? 10 : 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty {
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard generation == connectionGeneration else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse else { throw HomeClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw HomeClientError.authenticationExpired }
            if let envelope = try? decoder.decode([String: String].self, from: data), let message = envelope["error"] {
                throw HomeClientError.server(message)
            }
            throw HomeClientError.server("Home вернул HTTP " + String(http.statusCode))
        }
        return data
    }
}
