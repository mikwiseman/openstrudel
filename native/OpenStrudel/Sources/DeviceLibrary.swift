import Combine
import Foundation
#if os(macOS)
import WebKit
#endif

/// The app is a client of independent runtimes. Selecting a device never moves
/// its employees, copies credentials to another runtime, or changes ownership.
@MainActor
final class DeviceLibrary: ObservableObject {
    @Published private(set) var clients: [HomeClient]
    @Published private(set) var selectedID: String = "current"
    @Published var invitation: MacPairing?
    @Published private(set) var isErasing = false
    @Published private(set) var erasePhase: String?
    @Published private(set) var eraseError: String?
    @Published private(set) var erased = false
    @Published private(set) var viewGeneration = 0
    @Published private(set) var hiddenEmployees: [String: [String]]
    @Published private(set) var collapsedDeviceIDs: Set<String>
    var fileDrafts: [String: [PickedFile]] = [:]
    private let defaults: UserDefaults
    private let clientFactory: (String) -> HomeClient
    let employeeMoves: EmployeeMoves
    private var observations: [AnyCancellable] = []

    var active: HomeClient { clients.first { $0.id == selectedID } ?? clients[0] }
    var visibleClients: [HomeClient] { clients.filter { !$0.isSignedOut && ($0.isConfigured || $0.connectionNeedsPairing || $0 === active) } }
    var hasOtherDevices: Bool { visibleClients.count > 1 }
    var connectionListKey: String { visibleClients.map { $0.id + ":" + $0.normalizedBaseURL + ":" + String($0.shouldRestoreConnection && !$0.isPairing) }.joined(separator: "|") }

    var localClientToRestore: HomeClient? {
        guard !isErasing else { return nil }
        // A remote employee may be selected when Sparkle relaunches the app.
        // The saved local Home still needs its bundled runtime reconciled.
        return clients.first {
            $0.normalizedBaseURL == "http://127.0.0.1:7788" &&
                $0.hasToken && !$0.isPairing && !$0.isSignedOut
        }
    }

    init(defaults: UserDefaults = .standard, clients supplied: [HomeClient]? = nil, clientFactory: ((String) -> HomeClient)? = nil) {
        self.defaults = defaults
        let factory = clientFactory ?? { $0 == "current" ? HomeClient(defaults: defaults) : Self.makeClient(id: $0) }
        self.clientFactory = factory
        collapsedDeviceIDs = Set(defaults.stringArray(forKey: "openstrudel.collapsedDevices") ?? [])
        employeeMoves = EmployeeMoves(defaults: defaults)
        hiddenEmployees = defaults.dictionary(forKey: "openstrudel.hiddenEmployees") as? [String: [String]] ?? [:]
        if let supplied, !supplied.isEmpty {
            clients = supplied
        } else {
            let ids = defaults.stringArray(forKey: "openstrudel.deviceConnections") ?? ["current"]
            clients = (ids.isEmpty ? ["current"] : ids).map(factory)
        }
        selectedID = defaults.string(forKey: "openstrudel.selectedDevice") ?? clients[0].id
        draftContexts = Self.readDraftContexts(defaults)
        observeClients()
        // The one chat is the chosen Home's main assistant. An employee or chat selected in an earlier version opens as a
        // reader now; the draft it was writing stays under its own key and is offered back in the chat.
        active.pinToMain()
        #if os(macOS)
        if LocalDataReset.current.pending { isErasing = true }
        #endif
    }

    // MARK: The one chat

    /// The Home whose main assistant is the chat. Everything else is read, never written to, from here.
    var primary: HomeClient { active }

    /// Why the chat cannot move to another Home right now, or nil. Unsent words, files or an attached context, an answer
    /// in flight, a question waiting for the owner, and sends the Home has not confirmed all keep the chat where it is.
    var primaryChangeBlocker: String? {
        let chat = active
        let key = HomeDrafts.key(home: chat.baseURLString, profile: nil, chat: nil)
        if !draft(for: key).isEmpty || !(fileDrafts[key] ?? []).isEmpty || draftContexts[key] != nil { return L("Сначала отправьте или уберите черновик.") }
        if !chat.interactions.isEmpty { return L("Сначала ответьте на вопрос в чате.") }
        if chat.isWorking { return L("Дождитесь ответа в чате.") }
        // Every send the Home has not confirmed, including one restored after a relaunch with its "check delivery" note.
        if !chat.pendingMessages.isEmpty { return L("Дождитесь доставки отправленных сообщений или уберите неотправленные.") }
        return nil
    }

    /// Moves the chat to another paired Home when nothing is in flight; the previous Home's chat stays readable.
    @discardableResult func changePrimary(to client: HomeClient) -> Bool { select(client) }

    /// The client, message or story attached to a draft, kept with the draft text so it survives navigation and relaunch.
    @Published private(set) var draftContexts: [String: ChatContext] = [:]
    func draftContext(for key: String) -> ChatContext? { draftContexts[key] }
    func saveDraftContext(_ context: ChatContext?, for key: String) {
        guard draftContexts[key] != context else { return }
        draftContexts[key] = context
        defaults.set(try? JSONEncoder().encode(draftContexts), forKey: "openstrudel.draftContexts")
    }
    private static func readDraftContexts(_ defaults: UserDefaults) -> [String: ChatContext] {
        guard let data = defaults.data(forKey: "openstrudel.draftContexts") else { return [:] }
        return (try? JSONDecoder().decode([String: ChatContext].self, from: data)) ?? [:]
    }
    /// What "Обсудить" attaches: the main chat's next message carries it.
    func attach(_ context: ChatContext) {
        saveDraftContext(context, for: HomeDrafts.key(home: active.baseURLString, profile: nil, chat: nil))
    }

    /// Drafts saved on this Home for conversations other than the main chat: an employee's chat, a Telegram chat, an
    /// archive, or a new employee that was being described. Each keeps its key until its text is used or cleared.
    func savedDrafts(on client: HomeClient) -> [(key: String, profile: String?, chat: String?)] {
        let prefix = client.baseURLString.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "\n"
        let main = HomeDrafts.key(home: client.baseURLString, profile: nil, chat: nil)
        let saved = (defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String] ?? [:]).filter { !$0.value.isEmpty }
        let keys = Set(saved.keys).union(fileDrafts.filter { !$0.value.isEmpty }.keys).union(draftContexts.keys)
        return keys.filter { $0.hasPrefix(prefix) && $0 != main }.sorted().map { key in
            let parts = key.dropFirst(prefix.count).split(separator: ":", maxSplits: 1).map(String.init)
            let profile = parts.first.flatMap { $0 == "main" ? nil : $0 }
            let chat = parts.count > 1 && parts[1] != "personal" ? parts[1] : nil
            return (key, profile, chat)
        }
    }

    private static func makeClient(id: String) -> HomeClient {
        let name = (Bundle.main.bundleIdentifier ?? "is.openstrudel.mac") + ".device." + id
        return HomeClient(defaults: UserDefaults(suiteName: name)!, connectionID: id)
    }

    private func observeClients() {
        observations = clients.map { client in
            client.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        }
        observations.append(employeeMoves.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() })
        // A quote from another Home is sent only while that connection still answers as the same Home.
        for client in clients {
            client.sourceReachable = { [weak self] home in
                guard let source = self?.clients.first(where: { $0.id == home.id }), !source.isSignedOut else { return false }
                return source.health?.homeId == home.homeId && !source.homeUnreachable && !source.connectionNeedsPairing
            }
        }
    }

    func moveTransport(clientID: String, action: String, body: Data) async throws -> Data {
        guard !isErasing, let client = clients.first(where: { $0.id == clientID && !$0.isSignedOut }) else {
            throw HomeClientError.server(L("Подключите оба устройства, чтобы завершить перенос."))
        }
        return try await client.employeeTransfer(action, body: body)
    }

    func refreshMovedEmployee(open: Bool = true) async {
        guard let move = employeeMoves.operation, move.phase.finished else { return }
        // The moved employee is read where it landed; the chat stays where it is.
        await refresh()
    }

    func employeeMoveDestinations(from source: HomeClient) -> [HomeClient] {
        visibleClients.filter { $0 !== source && $0.health?.homeId != source.health?.homeId }
    }

    /// Makes this Home the chat's, from any entry point: pairing, the menu bar, Settings. One guard for all of them: the
    /// chat stays where its draft, answer, question or unconfirmed sends are. Whatever the Home had selected before opens
    /// as a reader; its composer is the main assistant's.
    @discardableResult func select(_ client: HomeClient) -> Bool {
        guard !isErasing, clients.contains(where: { $0 === client }), !client.isSignedOut else { return false }
        if client === active { client.pinToMain(); return true }
        guard primaryChangeBlocker == nil else { return false }
        selectedID = client.id
        defaults.set(selectedID, forKey: "openstrudel.selectedDevice")
        client.pinToMain()
        return true
    }


    func setCollapsed(_ collapsed: Bool, client: HomeClient) {
        if collapsed { collapsedDeviceIDs.insert(client.id) }
        else { collapsedDeviceIDs.remove(client.id) }
        defaults.set(collapsedDeviceIDs.sorted(), forKey: "openstrudel.collapsedDevices")
    }

    func preparePairing(_ url: URL) {
        guard !isErasing else { return }
        do { invitation = try MacPairing(url: url) }
        catch { active.errorMessage = error.localizedDescription }
    }

    func newConnection() -> HomeClient { clientFactory(UUID().uuidString.lowercased()) }

    func connection(for pairing: MacPairing) -> HomeClient {
        clients.first { $0.savedBaseURL == pairing.baseURL } ?? newConnection()
    }

    func draft(for key: String) -> String {
        (defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String])?[key] ?? ""
    }

    func saveDraft(_ text: String, for key: String) {
        // Merge into the current store: another window or a destination change
        // may have moved a draft since this conversation was displayed.
        var drafts = defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String] ?? [:]
        drafts[key] = text.isEmpty ? nil : text
        defaults.set(drafts, forKey: "openstrudel.drafts")
    }

    func add(_ client: HomeClient, select shouldSelect: Bool = true) {
        guard !isErasing, client.isConfigured, !client.isSignedOut else { return }
        // A refreshed invitation replaces only that device's connection.
        // Existing local/remote devices and their drafts remain untouched.
        if let index = clients.firstIndex(where: { $0.normalizedBaseURL == client.normalizedBaseURL && $0.id != client.id }) {
            let replaced = clients[index]
            clients[index] = client
            // The chat's own connection renewed: the chat stays on it, pinned, instead of falling to another Home.
            if replaced.id == selectedID { selectedID = client.id; defaults.set(selectedID, forKey: "openstrudel.selectedDevice"); client.pinToMain() }
        } else if !clients.contains(where: { $0 === client }) { clients.append(client) }
        defaults.set(clients.map(\.id), forKey: "openstrudel.deviceConnections")
        observeClients()
        if shouldSelect { select(client) }
    }

    /// Remove only this client's saved connection. No employee deletion or
    /// remote logout is required, so an offline device can always be removed.
    func removeConnection(_ client: HomeClient) async {
        guard !isErasing, clients.contains(where: { $0 === client }) else { return }
        if let move = employeeMoves.operation, !move.phase.finished, [move.sourceID, move.targetID].contains(client.id) {
            client.errorMessage = L("Завершите или отмените перенос сотрудника перед отключением устройства."); return
        }
        // Removing the chat's own Home moves the chat: the same guard as any other move, so nothing in flight is lost.
        if client === active, let blocked = primaryChangeBlocker { client.errorMessage = blocked; return }
        // Persist the user's choice before waiting for a remote logout. iOS
        // can suspend us during that request, and a fresh invitation must not
        // reuse the client whose old credential is being revoked.
        clients.removeAll { $0 === client }
        if clients.isEmpty {
            let empty = newConnection()
            empty.disconnectFromMac()
            clients = [empty]
        }
        if selectedID == client.id || !clients.contains(where: { $0.id == selectedID }) {
            // The chat's Home is gone with its connection; the next one is the chat now, pinned to its assistant.
            selectedID = clients[0].id
            clients[0].pinToMain()
        }
        defaults.set(clients.map(\.id), forKey: "openstrudel.deviceConnections")
        defaults.set(selectedID, forKey: "openstrudel.selectedDevice")
        observeClients()
        await client.signOutOnThisDevice()
    }

    private func visibilityKey(_ client: HomeClient) -> String {
        // Home identity survives address changes and renewed invitations. The
        // cached identity also lets an offline client keep the same preference.
        client.catalogueIdentity
    }

    func isHidden(_ profile: EmployeeProfile, on client: HomeClient) -> Bool {
        hiddenEmployees[visibilityKey(client)]?.contains(profile.id) == true
    }
    func visibleProfiles(on client: HomeClient) -> [EmployeeProfile] { client.profiles.filter { !isHidden($0, on: client) } }
    /// Employees with News stories, on every device: the sidebar's feeds on the Mac, the first rows of Insights on the iPhone.
    var newsFeeds: [(source: HomeClient, route: ReaderRoute)] {
        visibleClients.flatMap { source in
            visibleProfiles(on: source).filter { $0.news == true }.map { (source, ReaderRoute(connectionID: source.id, kind: .news($0.id), title: $0.name)) }
        }
    }
    func hiddenProfiles(on client: HomeClient) -> [EmployeeProfile] { client.profiles.filter { isHidden($0, on: client) } }

    func setHidden(_ hidden: Bool, profile: EmployeeProfile, on client: HomeClient) async {
        let key = visibilityKey(client)
        var ids = Set(hiddenEmployees[key] ?? [])
        if hidden { ids.insert(profile.id) } else { ids.remove(profile.id) }
        hiddenEmployees[key] = ids.sorted()
        defaults.set(hiddenEmployees, forKey: "openstrudel.hiddenEmployees")
        if hidden, client.selectedProfileID == profile.id { await client.selectProfile(nil) }
    }

    /// Each host has its own conditional refresh loop. A slow or unreachable
    /// host cannot delay changes from another one. Background iOS suspends the
    /// task; the first foreground request catches up without a socket service.
    func watchCatalogues() async {
        employeeMoves.resume(using: moveTransport)
        await withTaskGroup(of: Void.self) { group in
            for client in visibleClients where client.shouldRestoreConnection && !client.isPairing {
                group.addTask {
                    while !Task.isCancelled {
                        await client.refreshCatalogue()
                        do { try await Task.sleep(for: .seconds(await client.homeUnreachable ? 15 : 5)) } catch { break }
                    }
                }
                group.addTask {
                    while !Task.isCancelled {
                        await client.load(quiet: true)
                        do { try await Task.sleep(for: .seconds(60)) } catch { break }
                    }
                }
            }
        }
    }

    /// Devices with the same name are told apart by their address, never by a renamed copy.
    func addressDetail(for client: HomeClient) -> String? {
        guard visibleClients.contains(where: { $0 !== client && $0.displayName == client.displayName }) else { return nil }
        return URL(string: client.savedBaseURL)?.host
    }

    #if os(macOS)
    /// Adds a server whose installation answered over its pinned HTTPS and forgets the saved setup.
    /// The watcher and an open setup page can finish the same server together: both get one client.
    func adoptServer(_ connection: HomeConnection, from flow: ServerSetupFlow) async throws -> HomeClient {
        if let adoption = adoptions[connection.url] { return try await adoption.value }
        let adoption = Task { @MainActor in
            let client = clients.first { $0.savedBaseURL == connection.url } ?? newConnection()
            guard await client.connectToCloud(connection) else { throw HomeClientError.server(client.pairingError ?? L("Не удалось получить ответ. Попробуйте ещё раз.")) }
            // Not selected: an open setup sheet stays on its account step.
            add(client, select: false)
            try flow.finish()
            return client
        }
        adoptions[connection.url] = adoption
        defer { adoptions[connection.url] = nil }
        return try await adoption.value
    }
    private var adoptions: [String: Task<HomeClient, Error>] = [:]

    /// A server that finishes after its setup window closed joins the list by itself.
    func watchPendingServer(_ flow: ServerSetupFlow = .shared) async {
        while !Task.isCancelled {
            if !isErasing, let connection = await flow.finishedConnection() { _ = try? await adoptServer(connection, from: flow) }
            do { try await Task.sleep(for: .seconds(30)) } catch { break }
        }
    }

    func openLocal() async {
        guard !isErasing else { return }
        if let local = clients.first(where: { $0.isLocalConnection && !$0.isSignedOut }) {
            select(local)
            await local.startLocalHome()
        } else {
            let local = newConnection()
            await local.startLocalHome()
            if local.health != nil { add(local) }
            else { active.errorMessage = local.errorMessage }
        }
    }

    func eraseThisMac() async {
        guard erasePhase == nil, !erased else { return }
        guard employeeMoves.operation?.phase.finished != false else {
            eraseError = L("Завершите или отмените перенос сотрудника перед удалением данных."); return
        }
        let reset = LocalDataReset.current
        eraseError = nil
        do { try reset.begin() }
        catch { eraseError = error.localizedDescription; return }
        isErasing = true
        HomeClient.invalidateForLocalErase()
        invitation = nil; fileDrafts = [:]
        for client in clients { client.suspendForLocalErase() }
        erasePhase = L("Останавливаем сотрудников этого Mac…")
        await LocalHome.prepareForErase()
        await DigitalOceanCloud.shared.prepareForLocalErase()
        ServerSetupFlow.shared.prepareForLocalErase()
        AgentMetalSetupFlow.shared.prepareForLocalErase()
        do {
            try await Task.detached { try reset.stopManagedService() }.value
            erasePhase = L("Удаляем сотрудников, чаты и файлы…")
            try await Task.detached { try reset.eraseFiles(stop: { try reset.stopManagedService() }) }.value
            erasePhase = L("Удаляем сохранённые входы и настройки…")
            try reset.eraseCredentials()
            await WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            URLCache.shared.removeAllCachedResponses()
            try reset.erasePreferences(connectionIDs: clients.map(\.id))
            try reset.finish()
            erased = true
        } catch { eraseError = error.localizedDescription }
        erasePhase = nil
    }

    func startAfterErase() {
        guard erased else { return }
        clients = [HomeClient(defaults: defaults)]
        selectedID = clients[0].id
        observeClients()
        LocalHome.finishErase()
        DigitalOceanCloud.shared.finishLocalErase()
        ServerSetupFlow.shared.finishLocalErase()
        AgentMetalSetupFlow.shared.finishLocalErase()
        viewGeneration += 1
        erased = false; isErasing = false
    }
    #endif

    func refresh() async {
        guard !isErasing else { return }
        // An offline device cannot hold up another device's catalog.
        await withTaskGroup(of: Void.self) { group in
            for client in visibleClients where client.shouldRestoreConnection && !client.isPairing {
                group.addTask { await client.load(quiet: true) }
            }
        }
    }
}
