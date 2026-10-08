import Combine
import CryptoKit
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
final class HomeClient: ObservableObject, Identifiable {
    private static var eraseGeneration = 0
    private let createdBeforeErase: Int
    private var acceptsOperations: Bool { !suspendedForErase && createdBeforeErase == Self.eraseGeneration }
    static func invalidateForLocalErase() { eraseGeneration += 1 }
    let id: String
    private var credentialPrefix: String { id == "current" ? "" : id + "." }
    private func readCredential(account: String = "home-api-token") -> String? { KeychainStore.read(account: credentialPrefix + account) }
    private func saveCredential(_ value: String, account: String = "home-api-token") throws {
        guard acceptsOperations else { throw CancellationError() }
        try KeychainStore.save(value, account: credentialPrefix + account)
    }
    private func removeCredential(account: String = "home-api-token") { KeychainStore.remove(account: credentialPrefix + account) }
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
    @Published private(set) var importedConversations: [ImportedConversation] = []
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
    @Published private(set) var connectionState: HomeConnectionState = .idle
    @Published private(set) var isStartingLocalHome = false
    @Published private(set) var homeUnreachable = false
    @Published private(set) var interactions: [ChatInteraction] = []
    @Published private(set) var connections: [ServiceConnection] = []
    @Published private(set) var connectionNotice: String?
    @Published private(set) var schedules: [ChatSchedule] = []
    @Published private(set) var scheduleRuns: [ScheduleRun] = []
    @Published private(set) var selectedChatID: String?
    @Published private(set) var historyLimit = 100
    @Published private(set) var hasEarlierMessages = false
    @Published private(set) var isLoadingEarlier = false
    private var olderCursor: String?
    private var newerCursor: String?
    private var pagedHistory = false
    private var refreshingConversation: Int?
    private var catalogueGeneration = 0
    @Published var syncError: String?
    @Published private(set) var isCreating = false
    @Published var draftEmployeeDomain = "personal"
    @Published var draftDeviceID = "" {
        didSet { defaults.set(draftDeviceID, forKey: "openstrudel.draftDeviceID") }
    }
    @Published var draftAppearance = AgentAppearance.seeded(UUID().uuidString)
    @Published private(set) var isSignedOut = false
    @Published private(set) var isSigningOut = false
    @Published private(set) var devices: [HomeDevice] = []
    private var refreshGeneration = 0
    var visiblePendingMessages: [PendingHomeMessage] {
        pendingMessages.filter { pending in pending.profileID == selectedProfileID && pending.conversationID == selectedChatID && !messages.contains(where: { $0.externalId == pending.id.uuidString }) }
    }
    var isSending: Bool {
        messages.contains { $0.status == "queued" || $0.status == "running" } || visiblePendingMessages.contains { $0.error == nil && $0.deliveryState == nil }
    }
    @Published private(set) var pendingMessages: [PendingHomeMessage] = []
    @Published var errorMessage: String?
    @Published private(set) var conversationID: String?
    @Published private(set) var selectedProfileID: String?

    private let defaults: UserDefaults
    private let pendingDirectory: URL
    private var token: String?
    private var session: URLSession = .shared
    private var relocation: Task<Void, Error>?
    private let decoder = JSONDecoder()
    private var isDrainingSendQueue = false
    private var suspendedForErase = false

    init(defaults: UserDefaults = .standard, session transport: URLSession = .shared, pendingDirectory: URL? = nil, connectionID: String = "current") {
        self.id = connectionID
        self.createdBeforeErase = Self.eraseGeneration
        self.defaults = defaults
        self.pendingDirectory = pendingDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appending(path: (Bundle.main.bundleIdentifier ?? "OpenStrudel") + "/Pending")
        self.session = transport
        self.isSignedOut = defaults.bool(forKey: "openstrudel.signedOut")
        self.connectionName = defaults.string(forKey: "openstrudel.connectionName") ?? "OpenStrudel"
        #if os(macOS)
        self.baseURLString = defaults.string(forKey: "openstrudel.homeURL") ?? (connectionID == "current" ? "http://127.0.0.1:7788" : "")
        #else
        self.baseURLString = defaults.string(forKey: "openstrudel.homeURL") ?? ""
        #endif
        self.token = readCredential()
        if let saved = readCredential(account: "home-connection"),
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
        if let selectedProfileID, selectedProfileID.hasPrefix("draft:") {
            draftAppearance = .seeded(selectedProfileID)
            draftDeviceID = defaults.string(forKey: "openstrudel.draftDeviceID") ?? ""
        }
        if let url = URL(string: baseURLString), url.scheme == "https", session === URLSession.shared {
            if let host = url.host, let pin = readCredential(account: "home-certificate-pin"), token != nil {
                session = PinnedHomeSession(host: host, port: url.port ?? 443, pin: pin).session()
                connectionName = defaults.string(forKey: "openstrudel.connectionName") ?? "ваш Mac или сервер"
            } else {
                // A URL alone is not a connection. Re-pair if its Keychain
                // credentials are unavailable instead of using unpinned HTTPS.
                baseURLString = ""
                connectionNeedsPairing = true
                homeUnreachable = true
            }
        }
        if isSignedOut {
            baseURLString = ""; token = nil; connectionName = "OpenStrudel"; session = transport
        } else if let cached = defaults.data(forKey: "openstrudel.employeeCatalog"),
                  let employees = try? decoder.decode([EmployeeProfile].self, from: cached) {
            profiles = employees
        }
        HomeDrafts.migrate(defaults, currentHome: baseURLString)
        do {
            self.pendingMessages = try PendingMessagesFile.read(directory: self.pendingDirectory, home: baseURLString).map { value in
                var pending = value
                if pending.deliveryState == nil { pending.error = "Сообщение сохранено на этом устройстве. Проверьте доставку и отправьте ещё раз." }
                return pending
            }
        } catch { self.errorMessage = "Не удалось прочитать неотправленные сообщения. Сохранённый файл остался на устройстве." }
        if shouldRestoreConnection { connectionState = .connecting }
    }

    var shouldRestoreConnection: Bool {
        acceptsOperations && !isSignedOut && isConfigured && (hasToken || defaults.string(forKey: "openstrudel.homeURL") != nil)
    }

    var isConnecting: Bool { health == nil && (connectionState == .connecting || isStartingLocalHome) }

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
            return "Войдите в OpenAI на устройстве этого сотрудника. Здесь подключение восстановится автоматически; отдельный вход не нужен."
        }
        return "Войдите в OpenAI один раз для устройства этого сотрудника. Подключённые устройства продолжат работу автоматически. Чаты и черновики сохранены."
    }

    var isLocalConnection: Bool {
        guard let url = URL(string: normalizedBaseURL), url.scheme == "http", let host = url.host else { return false }
        return ["localhost", "127.0.0.1", "::1"].contains(host)
    }

    #if os(macOS)
    func startLocalHome() async {
        guard !isStartingLocalHome, acceptsOperations else { return }
        let generation = connectionGeneration
        isStartingLocalHome = true
        connectionState = .connecting
        defer { isStartingLocalHome = false }
        do {
            let connection = try await LocalHome.start()
            guard generation == connectionGeneration, acceptsOperations else { return }
            if normalizedBaseURL != connection["url"] {
                removeCredential(account: "home-connection")
                resetConnectionState()
            }
            isSignedOut = false
            defaults.set(false, forKey: "openstrudel.signedOut")
            token = connection["token"]
            baseURLString = connection["url"]!
            defaults.set(baseURLString, forKey: "openstrudel.homeURL")
            await load()
        } catch { if generation == connectionGeneration { connectionState = .unavailable; errorMessage = error.localizedDescription } }
    }
    #endif

    var displayName: String {
        if isLocalConnection { return "Этот Mac" }
        if connectionName != "OpenStrudel", connectionName != "ваш Mac или сервер" { return connectionName }
        return devices.first(where: { $0.id == health?.nodeId })?.name ?? connectionName
    }

    var executionDeviceName: String {
        let id = isEmployeeDraft ? draftDeviceID : activeProfile?.deviceId ?? health?.nodeId
        if id == health?.nodeId { return displayName }
        return devices.first(where: { $0.id == id })?.name ?? displayName
    }

    var normalizedBaseURL: String {
        let value = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.hasSuffix("/") ? String(value.dropLast()) : value
    }

    var savedBaseURL: String { defaults.string(forKey: "openstrudel.homeURL") ?? normalizedBaseURL }

    var activeProfile: EmployeeProfile? {
        guard let selectedProfileID else { return nil }
        return profiles.first { $0.id == selectedProfileID }
    }

    var activeAppearance: AgentAppearance? { isEmployeeDraft ? draftAppearance : activeProfile?.resolvedAppearance }

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
        guard !isPairing, acceptsOperations else { return false }
        isPairing = true
        pairingError = nil
        defer { isPairing = false }
        let pairedSession = PinnedHomeSession(host: pairing.host, port: pairing.port, pin: pairing.pin).session()
        do {
            // Persist the attempt before redeeming the one-use invitation.
            let attemptKey = "pair-attempt-" + SHA256.hash(data: Data(pairing.key.utf8)).map { String(format: "%02x", $0) }.joined()
            let attempt = readCredential(account: attemptKey) ?? UUID().uuidString
            try saveCredential(attempt, account: attemptKey)
            var request = URLRequest(url: URL(string: pairing.baseURL + "/pair")!)
            request.httpMethod = "POST"
            request.setValue("Bearer " + pairing.key, forHTTPHeaderField: "Authorization")
            request.setValue(attempt, forHTTPHeaderField: "X-OpenStrudel-Pair-Id")
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
            removeCredential(account: attemptKey)
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
        guard !isPairing, acceptsOperations,
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
        try saveCredential(saved, account: "home-connection")
        resetConnectionState()
        isSignedOut = false
        defaults.set(false, forKey: "openstrudel.signedOut")
        token = connection.token
        baseURLString = connection.url
        pendingMessages = (try? PendingMessagesFile.read(directory: pendingDirectory, home: connection.url)) ?? []
        connectionName = connection.name
        defaults.set(baseURLString, forKey: "openstrudel.homeURL")
        defaults.set(connectionName, forKey: "openstrudel.connectionName")
        session = newSession
    }

    func disconnectFromMac() {
        defaults.set(true, forKey: "openstrudel.signedOut")
        isSignedOut = true
        resetConnectionState()
        removeCredential(account: "home-connection")
        removeCredential()
        removeCredential(account: "home-certificate-pin")
    }

    /// Stops this client without sending deletion or logout to any remote host.
    func suspendForLocalErase() {
        suspendedForErase = true
        isSignedOut = true
        resetConnectionState()
    }

    func signOutOnThisDevice() async {
        guard !isSigningOut else { return }
        isSigningOut = true
        let generation = connectionGeneration
        // Paired clients revoke only their own credential. The local Home's
        // runtime token and OpenAI sessions belong to the running Home.
        if !isLocalConnection, health?.deviceLogoutVersion == 1,
           let url = URL(string: normalizedBaseURL + "/auth/device/logout") {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"; request.timeoutInterval = 5
            if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
            _ = try? await session.data(for: request)
        }
        if generation == connectionGeneration { disconnectFromMac() }
        isSigningOut = false
    }

    private func resetConnectionState() {
        relocation?.cancel(); relocation = nil
        pendingPairing = nil; pairingError = nil; telegramLink = nil
        devices = []; connectionNotice = nil
        draftDeviceID = ""; draftEmployeeDomain = "personal"
        connectionState = .idle
        importedConversations = []
        connectionGeneration += 1
        resetHistory()
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
        do { mobileInvitation = try await request("/v1/mobile/pairing", method: "POST", body: try JSONSerialization.data(withJSONObject: ["owner": true])) }
        catch { errorMessage = error.localizedDescription }
    }

    func refreshMobileStatus() async {
        struct Status: Decodable { let connections: Int }
        if let status: Status = try? await request("/v1/mobile") {
            mobileConnections = status.connections
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
        guard !isLoading, acceptsOperations else { return }
        let generation = connectionGeneration
        let catalogue = catalogueGeneration
        guard isConfigured else {
            if !quiet { errorMessage = "Подключитесь к своему Mac или серверу через приглашение." }
            return
        }
        isLoading = true
        if health == nil && (!quiet || connectionState != .unavailable) { connectionState = .connecting }
        defer { if generation == connectionGeneration { isLoading = false } }
        if !quiet { errorMessage = nil }
        do {
            async let healthRequest: HomeHealth = request("/health")
            async let profilesRequest: ProfilesEnvelope = request("/v1/profiles")
            let (loadedHealth, loadedProfiles) = try await (healthRequest, profilesRequest)
            guard generation == connectionGeneration else { return }
            health = loadedHealth
            if loadedHealth.homeProtocol == 1 {
                if let result: HomeDevices = try? await request("/v1/devices"), generation == connectionGeneration { devices = result.devices }
            }
            guard generation == connectionGeneration else { return }
            connectionState = .connected
            if catalogue == catalogueGeneration {
                if profiles != loadedProfiles.profiles {
                    profiles = loadedProfiles.profiles
                    defaults.set(try? JSONEncoder().encode(profiles), forKey: "openstrudel.employeeCatalog")
                }
                importedConversations = loadedProfiles.importedConversations ?? []
            }
            // Publish employees before waiting for provider state.
            async let integrations: TelegramEnvelope? = try? request("/v1/integrations")
            async let account = loadOpenAIAccount()
            if let selectedProfileID, !isEmployeeDraft, !profiles.contains(where: { $0.id == selectedProfileID }) {
                self.selectedProfileID = nil
                resetHistory(); messages = []; selectedChatID = nil; conversationID = nil
                defaults.removeObject(forKey: "openstrudel.profileID")
            }
            homeUnreachable = false
            connectionNeedsPairing = false

            await refreshConversation()
            let (value, loadedAccount) = try await (integrations, account)
            guard generation == connectionGeneration else { return }
            if let value { telegram = value.telegram }
            applyOpenAIAccount(loadedAccount)
        } catch {
            guard generation == connectionGeneration else { return }
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            connectionState = .unavailable
            homeUnreachable = true
            if case HomeClientError.authenticationExpired = error { connectionNeedsPairing = true; health = nil }
            if !quiet { errorMessage = error.localizedDescription }
        }
    }

    private func loadOpenAIAccount(force: Bool = false) async throws -> OpenAIAccountEnvelope {
        do {
            var query = force ? "?refresh=true" : "?refresh=false"
            if health?.homeProtocol == 1 { query += "&agentId=" + (isEmployeeDraft ? "main" : selectedProfileID ?? "main") }
            let envelope: OpenAIAccountEnvelope = try await request("/v1/account" + query)
            return envelope
        } catch HomeClientError.authenticationExpired {
            // The Home's own credential was revoked; this still needs pairing.
            throw HomeClientError.authenticationExpired
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // Older Homes return a raw Codex error. Keep their healthy local
            // connection usable and offer account recovery instead of setup.
            // Recovery uses the original server error, never translated UI copy.
            let originalMessage: String
            if case HomeClientError.server(let serverMessage) = error { originalMessage = serverMessage }
            else { originalMessage = error.localizedDescription }
            let message = originalMessage.lowercased()
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
        guard !isSignedOut, !isSigningOut, !value.isEmpty || !files.isEmpty else { return }
        pendingMessages.append(PendingHomeMessage(text: value, profileID: selectedProfileID, conversationID: selectedChatID, files: files, draftDomain: draftEmployeeDomain, deviceID: draftDeviceID.isEmpty ? nil : draftDeviceID, appearance: isEmployeeDraft ? draftAppearance : nil))
        do { try savePending() } catch { errorMessage = error.localizedDescription; pendingMessages[pendingMessages.count - 1].error = "Не удалось сохранить отправку на устройстве. Освободите место и повторите."; return }
        guard !isDrainingSendQueue else { return }
        isDrainingSendQueue = true
        await drainSendQueue()
    }

    private func drainSendQueue() async {
        defer { isDrainingSendQueue = false }
        while let pending = pendingMessages.first(where: { $0.error == nil && $0.deliveryState == nil }) {
            do {
                var profileID = pending.profileID
                if let draftID = profileID, draftID.hasPrefix("draft:") {
                    isCreating = true
                    defer { isCreating = false }
                    var creation: [String: Any] = ["creationId": String(draftID.dropFirst(6)), "domain": pending.draftDomain]
                    if let appearance = pending.appearance { creation["appearance"] = appearance.payload }
                    if let device = pending.deviceID { creation["deviceId"] = device }
                    let body = try JSONSerialization.data(withJSONObject: creation)
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
                if let operation = result.operationId, let index = pendingMessages.firstIndex(where: { $0.id == pending.id }) {
                    pendingMessages[index].operationID = operation
                    pendingMessages[index].deliveryState = result.deliveryState ?? "queued"
                } else { pendingMessages.removeAll { $0.id == pending.id } }
                try savePending()
            } catch {
                if let i = pendingMessages.firstIndex(where: { $0.id == pending.id }) {
                    pendingMessages[i].error = "Не удалось подтвердить доставку. Повтор проверит это же сообщение."
                    try? savePending()
                }
            }
        }
    }

    private func savePending() throws { try PendingMessagesFile.save(pendingMessages, directory: pendingDirectory, home: baseURLString) }

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
        if pending.deliveryState != nil { await checkPendingRequests(); return }
        pendingMessages[i].error = nil
        guard !isDrainingSendQueue else { return }
        isDrainingSendQueue = true
        await drainSendQueue()
    }

    func refreshConversation() async {
        guard !isEmployeeDraft else { return }
        let profileID = selectedProfileID
        let generation = refreshGeneration
        guard refreshingConversation != generation else { return }
        refreshingConversation = generation
        defer { if refreshingConversation == generation { refreshingConversation = nil } }
        await checkPendingRequests()
        guard generation == refreshGeneration else { return }
        do {
            let path = selectedChatID.map { "/v1/conversations/" + $0 } ?? profileID.map { "/v1/agents/" + $0 + "/conversation" } ?? "/v1/conversation"
            let limit = pagedHistory || messages.isEmpty ? 50 : historyLimit
            var query = "?page=true&limit=" + String(limit)
            if pagedHistory, let newerCursor { query += "&after=" + newerCursor }
            let pending = messages.filter { $0.status == "queued" || $0.status == "running" }.map(\.id)
            if !pending.isEmpty { query += "&watch=" + pending.prefix(200).joined(separator: ",") }
            let envelope: ConversationEnvelope = try await request(path + query)
            guard generation == refreshGeneration, profileID == selectedProfileID else { return }
            if conversationID != envelope.conversation.id { conversationID = envelope.conversation.id }
            if let page = envelope.pagination {
                if !pagedHistory { olderCursor = page.olderCursor; hasEarlierMessages = olderCursor != nil }
                let updated = MessagePages.merge(existing: pagedHistory ? messages : [], page: envelope.messages, updates: envelope.updates ?? [])
                if messages != updated { messages = updated }
                newerCursor = page.newerCursor
                pagedHistory = true
            } else {
                if messages != envelope.messages { messages = envelope.messages }
                hasEarlierMessages = messages.count >= limit
            }
            let delivered = Set(envelope.messages.compactMap(\.externalId))
            let remaining = pendingMessages.filter { !delivered.contains($0.id.uuidString) }
            if remaining.count != pendingMessages.count { pendingMessages = remaining; try savePending() }
            if !hasOpenedConversation && (!messages.isEmpty || !profiles.isEmpty) { hasOpenedConversation = true }
            if interactions != envelope.interactions ?? [] { interactions = envelope.interactions ?? [] }
            if syncError != nil { syncError = nil }
        } catch {
            guard generation == refreshGeneration, profileID == selectedProfileID else { return }
            if case HomeClientError.authenticationExpired = error { connectionNeedsPairing = true; health = nil }
            syncError = "Нет связи. Сообщения появятся после подключения."
        }
    }

    private func checkPendingRequests() async {
        let generation = connectionGeneration
        var changed = false
        for pending in pendingMessages where pending.operationID != nil && pending.error == nil {
            do {
                let status: HomeRequestStatus = try await request("/v1/home/requests/" + pending.operationID!)
                guard generation == connectionGeneration, let index = pendingMessages.firstIndex(where: { $0.id == pending.id }) else { return }
                if status.status == "canceled" {
                    pendingMessages[index].error = "Отменено до отправки устройству. Текст сохранён здесь."
                    changed = true
                } else if let response = status.response, response.status >= 400, response.status != 410 {
                    let data = Data(base64Encoded: response.body) ?? Data()
                    let failure = try? decoder.decode(HomeFailure.self, from: data)
                    pendingMessages[index].error = (failure?.error ?? "Устройство не подтвердило выполнение.") + " Проверьте чат перед новой отправкой."
                    changed = true
                }
            } catch { /* Keep the durable receipt while Home is unavailable. */ }
        }
        if changed { try? savePending() }
    }

    func cancelPending(_ pending: PendingHomeMessage) async {
        guard let operation = pending.operationID else { return }
        do {
            let _: [String: Bool] = try await request("/v1/home/requests/" + operation, method: "DELETE")
            await checkPendingRequests()
        } catch { errorMessage = error.localizedDescription }
    }

    func loadConnections(refresh: Bool = false) async throws {
        let generation = connectionGeneration
        let chat = conversationID
        let query = "?refresh=" + String(refresh) + (conversationID.map { "&conversationId=" + $0 } ?? "")
        let result: ConnectionsEnvelope = try await request("/v1/connections" + query)
        guard generation == connectionGeneration, chat == conversationID else { throw CancellationError() }
        connections = result.connections
        connectionNotice = result.notice
    }

    func loadChatSettings() async {
        do {
            let value: TelegramEnvelope = try await request("/v1/integrations" + employeeDeviceQuery)
            telegram = value.telegram
            if let conversationID {
                let result: SchedulesEnvelope = try await request("/v1/conversations/" + conversationID + "/schedules")
                schedules = result.schedules; scheduleRuns = result.runs
            }
        } catch { syncError = error.localizedDescription }
    }

    func selectChat(_ id: String?) async {
        selectedChatID = id
        resetHistory()
        messages = []
        await refreshConversation()
    }
    func loadEarlierMessages() async {
        guard hasEarlierMessages, !isLoadingEarlier else { return }
        let generation = refreshGeneration
        isLoadingEarlier = true
        defer { if generation == refreshGeneration { isLoadingEarlier = false } }
        if !pagedHistory {
            historyLimit += 100
            await refreshConversation()
            return
        }
        guard let olderCursor, let conversationID else { return }
        do {
            let envelope: ConversationEnvelope = try await request("/v1/conversations/" + conversationID + "?page=true&limit=50&before=" + olderCursor)
            guard generation == refreshGeneration else { return }
            messages = MessagePages.merge(existing: messages, page: envelope.messages, prepend: true)
            self.olderCursor = envelope.pagination?.olderCursor
            hasEarlierMessages = self.olderCursor != nil
            syncError = nil
        } catch {
            guard generation == refreshGeneration else { return }
            syncError = "Не удалось загрузить ранние сообщения. Попробуйте ещё раз."
        }
    }

    private func resetHistory() {
        refreshGeneration += 1
        historyLimit = 100; olderCursor = nil; newerCursor = nil; pagedHistory = false
        hasEarlierMessages = false; isLoadingEarlier = false
    }

    func bindTelegram(chatID: String, profileID: String?) async {
        do {
            let body = try JSONSerialization.data(withJSONObject: ["profileId": profileID as Any? ?? NSNull()])
            let response: TelegramEnvelope = try await request("/v1/integrations/telegram/chats/" + chatID + employeeDeviceQuery, method: "PATCH", body: body)
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
        conversationID = nil; connections = []; connectionNotice = nil; schedules = []; telegramLink = nil
        resetHistory()
        messages = []
        interactions = []
        selectedProfileID = profileID
        if let profileID {
            defaults.set(profileID, forKey: "openstrudel.profileID")
        } else {
            defaults.removeObject(forKey: "openstrudel.profileID")
        }
        await refreshConversation()
        await refreshOpenAIAccount()
    }

    func deleteProfile(_ profileID: String) async throws {
        let _: HomeActionResult = try await management("/v1/profiles/" + profileID, method: "DELETE")
        catalogueGeneration += 1
        profiles.removeAll { $0.id == profileID }
        importedConversations.removeAll { $0.profileId == profileID }
        defaults.set(try? JSONEncoder().encode(profiles), forKey: "openstrudel.employeeCatalog")
        if selectedProfileID == profileID { await selectProfile(nil) }
    }

    func beginEmployee() {
        resetHistory()
        selectedProfileID = "draft:" + UUID().uuidString
        selectedChatID = nil; conversationID = nil
        messages = []; interactions = []; schedules = []
        draftEmployeeDomain = "personal"
        draftAppearance = .seeded(selectedProfileID!)
        draftDeviceID = health?.nodeId ?? devices.first?.id ?? ""
        defaults.set(selectedProfileID, forKey: "openstrudel.profileID")
        defaults.set(draftDeviceID, forKey: "openstrudel.draftDeviceID")
    }

    func releaseEmployeeDraft() {
        guard isEmployeeDraft else { return }
        selectedProfileID = nil
        defaults.removeObject(forKey: "openstrudel.profileID")
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
    func updateProfile(id: String, name: String, instructions: String, purpose: String? = nil, appearance: AgentAppearance? = nil) async -> Bool {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { return false }
        do {
            var payload: [String: Any] = [
                "name": cleanName,
                "instructions": cleanInstructions
            ]
            if let purpose { payload["purpose"] = purpose }
            if let appearance { payload["appearance"] = appearance.payload }
            let body = try JSONSerialization.data(withJSONObject: payload)
            let response: ProfileResponse = try await request("/v1/profiles/" + id, method: "PATCH", body: body)
            if let appearance, response.profile.appearance != appearance {
                throw HomeClientError.server("Обновите OpenStrudel на устройстве этого сотрудника, чтобы сохранить образ.")
            }
            if let index = profiles.firstIndex(where: { $0.id == id }) {
                profiles[index] = response.profile
            }
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    private var employeeDeviceQuery: String { activeProfile?.deviceId.map { "?deviceId=" + $0 } ?? "" }

    func configureTelegram(token: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["token": token.trimmingCharacters(in: .whitespacesAndNewlines)])
        let value: TelegramEnvelope = try await request("/v1/integrations/telegram" + employeeDeviceQuery, method: "POST", body: body)
        telegram = value.telegram
    }

    func checkTelegramConnection() async throws {
        let value: TelegramEnvelope = try await request("/v1/integrations/telegram/check" + employeeDeviceQuery, method: "POST")
        telegram = value.telegram
    }

    func disconnectTelegram() async {
        do {
            let response: TelegramEnvelope = try await request("/v1/integrations/telegram" + employeeDeviceQuery, method: "DELETE")
            telegram = response.telegram
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createTelegramLink() async {
        do {
            telegramLink = nil
            telegramLink = try await request("/v1/integrations/telegram/link" + employeeDeviceQuery, method: "POST", body: Data("{}".utf8))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createTelegramGroupLink(profileID: String) async throws -> TelegramLinkResponse {
        let link: TelegramLinkResponse = try await request("/v1/integrations/telegram/link" + employeeDeviceQuery, method: "POST", body: JSONSerialization.data(withJSONObject: ["kind": "group", "profileId": profileID]))
        // Older devices ignore `kind` and return a personal pairing link.
        guard let url = link.url, url.scheme == "https", url.host == "t.me",
              URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains(where: { $0.name == "startgroup" && $0.value == link.code }) == true else {
            throw HomeClientError.server("Обновите OpenStrudel на устройстве этого сотрудника, чтобы подключить группу.")
        }
        return link
    }

    func telegramLinkState(code: String) async throws -> TelegramLinkState {
        try await request("/v1/integrations/telegram/link/status" + employeeDeviceQuery, method: "POST", body: JSONSerialization.data(withJSONObject: ["code": code]))
    }

    func beginOpenAILogin() async {
        guard canManageOpenAI, openAIAccount?.isUnavailable != true,
              !openAILoginPending, !isStartingOpenAILogin, openAILogin == nil else { return }
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
            let login: OpenAILogin = try await request("/v1/account/login", method: "POST", body: body)
            guard generation == connectionGeneration, !Task.isCancelled else { return }
            openAILogin = login
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
                    ? "Вход отменён или истёк. Откройте вход в OpenAI ещё раз."
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
        let generation = connectionGeneration
        openAILogin = nil
        openAILoginStatus = nil
        openAIErrorMessage = nil
        do {
            let _: OpenAILoginStatus = try await request("/v1/account/login/" + login.loginId + "/cancel", method: "POST")
        } catch {
            guard generation == connectionGeneration, !(error is CancellationError) else { return }
            openAIErrorMessage = "Не удалось подтвердить отмену. Незавершённый вход истечёт автоматически."
        }
    }

    func logoutOpenAI() async {
        let generation = connectionGeneration
        do {
            let envelope: OpenAIAccountEnvelope = try await request("/v1/account/logout", method: "POST")
            guard generation == connectionGeneration, !Task.isCancelled else { return }
            openAIAccount = envelope.account
        } catch {
            guard generation == connectionGeneration, !(error is CancellationError) else { return }
            errorMessage = error.localizedDescription
        }
    }

    var canTransferAgents: Bool { canManageOpenAI && health?.agentArchiveVersion == 1 }

    func exportAgents(deviceID: String? = nil, password: String? = nil, progress: (@MainActor @Sendable (Int64, Int64?) -> Void)? = nil) async throws -> Data {
        guard canTransferAgents else { throw HomeClientError.server("Обновите OpenStrudel на устройстве с сотрудниками, чтобы сохранить копию.") }
        let body = try password.map { try JSONSerialization.data(withJSONObject: ["password": $0]) }
        return try await requestData("/v1/agents/archive" + (deviceID.map { "?deviceId=" + $0 } ?? ""), method: password == nil ? "GET" : "POST", body: body, progress: progress)
    }

    func previewAgentImport(_ data: Data, deviceID: String? = nil) async throws -> PendingAgentImport {
        guard canTransferAgents else { throw HomeClientError.server("Импорт доступен владельцу команды после обновления Home.") }
        guard data.count <= AgentTransferFile.byteLimit else { throw AgentTransferFile.Failure.tooLarge }
        let generation = connectionGeneration
        let preview: AgentImportPreview = try await request("/v1/agents/archive/preview" + (deviceID.map { "?deviceId=" + $0 } ?? ""), method: "POST", body: data)
        return PendingAgentImport(data: data, preview: preview, connectionGeneration: generation, deviceID: deviceID)
    }

    func importAgents(_ pending: PendingAgentImport) async throws -> AgentImportResult {
        guard canTransferAgents, pending.connectionGeneration == connectionGeneration else {
            throw HomeClientError.server("Подключение изменилось. Выберите файл заново в нужной команде.")
        }
        let result: AgentImportResult = try await request("/v1/agents/archive/import?plan=" + pending.preview.planToken + (pending.deviceID.map { "&deviceId=" + $0 } ?? ""), method: "POST", body: pending.data)
        // A lost response is safe to retry: the Home remembers this archive.
        await load(quiet: true)
        return result
    }

    func management<T: Decodable>(_ path: String, method: String = "GET", payload: [String: Any]? = nil) async throws -> T {
        try await request(path, method: method, body: payload.map { try JSONSerialization.data(withJSONObject: $0) })
    }

    func managementFile(_ path: String, method: String = "GET", payload: [String: Any]? = nil) async throws -> Data {
        try await requestData(path, method: method, body: payload.map { try JSONSerialization.data(withJSONObject: $0) })
    }

    private var actionStorageKey: String { "openstrudel.controlActions." + (health?.homeId ?? normalizedBaseURL) }
    var savedActionIDs: [String] { defaults.stringArray(forKey: actionStorageKey) ?? [] }
    private func rememberAction(_ id: String, pending: Bool) {
        var values = savedActionIDs.filter { $0 != id }
        if pending { values.append(id) }
        defaults.set(values, forKey: actionStorageKey)
    }
    func checkSavedActions() async throws -> String {
        var completed = 0, waiting = 0
        for id in savedActionIDs {
            let value: HomeRequestStatus = try await management("/v1/home/requests/" + id)
            if value.status == "canceled" { rememberAction(id, pending: false); continue }
            if let reply = value.response {
                rememberAction(id, pending: false)
                if reply.status >= 400 {
                    let failure = Data(base64Encoded: reply.body).flatMap { try? decoder.decode(HomeFailure.self, from: $0) }
                    throw HomeClientError.server(failure?.error ?? "Действие не завершено. Проверьте его результат перед повтором.")
                }
                completed += 1
            } else { waiting += 1 }
        }
        return "Завершено: \(completed). Ожидают устройства: \(waiting)."
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        let data = try await requestData(path, method: method, body: body)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw HomeClientError.server("Не удалось прочитать ответ OpenStrudel. Проверьте, что приложение обновлено на всех ваших устройствах, и попробуйте ещё раз.")
        }
    }

    private func requestData(_ path: String, method: String = "GET", body: Data? = nil, mayRelocate: Bool = true, progress: (@MainActor @Sendable (Int64, Int64?) -> Void)? = nil) async throws -> Data {
        guard acceptsOperations else { throw CancellationError() }
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
        request.timeoutInterval = path == "/health" ? 10 : path.hasPrefix("/v1/agents/archive") ? 300 : 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if method != "GET" { request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key") }
        if let token, !token.isEmpty {
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        if let progress {
            (data, response) = try await Self.receiveArchive(request, session: session, progress: progress)
        } else { (data, response) = try await session.data(for: request) }
        guard generation == connectionGeneration, acceptsOperations else { throw CancellationError() }
        guard let http = response as? HTTPURLResponse else { throw HomeClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw HomeClientError.authenticationExpired }
            if let envelope = try? decoder.decode(HomeFailure.self, from: data) {
                if http.statusCode == 409, let moved = envelope.moved, mayRelocate {
                    if relocation == nil {
                        relocation = Task { try await self.adoptPrimary(moved) }
                    }
                    let pending = relocation!
                    defer { relocation = nil }
                    try await pending.value
                    if method == "GET" { return try await requestData(path, mayRelocate: false) }
                    throw HomeClientError.server("Адрес устройства изменился. Действие не отправлено: повторите его на новом подключении.")
                }
                if let message = envelope.error { throw HomeClientError.server(message) }
            }
            throw HomeClientError.server("OpenStrudel не смог выполнить действие (код \(http.statusCode)). Попробуйте ещё раз. Если ошибка повторится, обратитесь в поддержку.")
        }
        if http.statusCode == 202, method != "GET", !path.hasPrefix("/v1/messages"),
           let queued = try? decoder.decode(HomeActionResult.self, from: data), let id = queued.operationId {
            rememberAction(id, pending: true)
            for _ in 0..<30 {
                try await Task.sleep(for: .seconds(1))
                guard generation == connectionGeneration else { throw CancellationError() }
                let value: HomeRequestStatus = try await management("/v1/home/requests/" + id)
                if value.status == "canceled" { rememberAction(id, pending: false); throw HomeClientError.server("Действие отменено до передачи устройству.") }
                if let reply = value.response, let bytes = Data(base64Encoded: reply.body) {
                    rememberAction(id, pending: false)
                    if reply.status >= 400 {
                        let failure = try? decoder.decode(HomeFailure.self, from: bytes)
                        throw HomeClientError.server(failure?.error ?? "Действие не завершено. Проверьте результат перед повтором.")
                    }
                    return bytes
                }
            }
            throw HomeClientError.server("Действие принято, но устройство ещё не подтвердило результат. Откройте «Устройства» → «Проверить сохранённые действия». Повторять действие не нужно.")
        }
        return data
    }

    // Reading millions of individual bytes on MainActor makes a local backup
    // feel stalled. Only bounded progress updates return to the interface.
    nonisolated private static func receiveArchive(_ request: URLRequest, session: URLSession,
        progress: @escaping @MainActor @Sendable (Int64, Int64?) -> Void) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        let expected = response.expectedContentLength > 0 ? response.expectedContentLength : nil
        if let expected, expected > Int64(AgentTransferFile.byteLimit) { throw AgentTransferFile.Failure.tooLarge }
        var buffer = Data()
        if let expected { buffer.reserveCapacity(Int(expected)) }
        for try await byte in bytes {
            buffer.append(byte)
            if buffer.count % 65_536 == 0 {
                try Task.checkCancellation()
                guard buffer.count <= AgentTransferFile.byteLimit else { throw AgentTransferFile.Failure.tooLarge }
                await progress(Int64(buffer.count), expected)
            }
        }
        try Task.checkCancellation()
        guard buffer.count <= AgentTransferFile.byteLimit else { throw AgentTransferFile.Failure.tooLarge }
        await progress(Int64(buffer.count), expected)
        return (buffer, response)
    }

    private func adoptPrimary(_ moved: HomeMoved) async throws {
        let generation = connectionGeneration
        guard let url = URL(string: moved.url), url.scheme == "https", let host = url.host,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              let pin = moved.pin, pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let credential = token, !credential.isEmpty,
              health?.homeId == nil || health?.homeId == moved.homeId else { throw HomeClientError.invalidURL }
        let transport = PinnedHomeSession(host: host, port: url.port ?? 443, pin: "spki:" + pin).session()
        var committed = false
        defer { if !committed { transport.invalidateAndCancel() } }
        let (identityData, identityResponse) = try await transport.data(from: url.appending(path: "v1/home/identity"))
        guard (identityResponse as? HTTPURLResponse)?.statusCode == 200,
              let identity = try? decoder.decode(HomePeerIdentity.self, from: identityData),
              identity.nodeId == moved.primaryId, identity.homeId == moved.homeId,
              identity.protocolVersion == 1, identity.role == "primary", identity.epoch == moved.epoch
        else { throw HomeClientError.server("Устройство ещё запускается. Подключимся, когда передача завершится.") }
        guard generation == connectionGeneration, !Task.isCancelled else { throw CancellationError() }
        // Identity and TLS are verified before the credential is sent.
        var check = URLRequest(url: url.appending(path: "health"))
        check.setValue("Bearer " + credential, forHTTPHeaderField: "Authorization")
        let (healthData, response) = try await transport.data(for: check)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let verified = try? decoder.decode(HomeHealth.self, from: healthData), verified.ok,
              verified.homeId == moved.homeId, verified.primaryId == moved.primaryId else { throw HomeClientError.invalidResponse }
        guard generation == connectionGeneration, !Task.isCancelled else { throw CancellationError() }
        let connection = HomeConnection(url: moved.url, token: credential, pin: "spki:" + pin, name: connectionName)
        try PendingMessagesFile.save(pendingMessages, directory: pendingDirectory, home: moved.url)
        HomeDrafts.relocate(defaults, from: baseURLString, to: moved.url)
        try saveCredential(String(decoding: JSONEncoder().encode(connection), as: UTF8.self), account: "home-connection")
        baseURLString = moved.url; defaults.set(moved.url, forKey: "openstrudel.homeURL")
        session = transport; committed = true
        connectionGeneration += 1; isLoading = false; checkingOpenAIAccount = false
        health = verified; connectionState = .connected; homeUnreachable = false
        Task { await self.load(quiet: true) }
    }
}
