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
    var fileDrafts: [String: [PickedFile]] = [:]
    private let defaults: UserDefaults
    private var observations: [AnyCancellable] = []

    var active: HomeClient { clients.first { $0.id == selectedID } ?? clients[0] }
    var visibleClients: [HomeClient] { clients.filter { !$0.isSignedOut && ($0.isConfigured || $0.connectionNeedsPairing || $0 === active) } }
    var hasOtherDevices: Bool { visibleClients.count > 1 }

    init(defaults: UserDefaults = .standard, clients supplied: [HomeClient]? = nil) {
        self.defaults = defaults
        if let supplied, !supplied.isEmpty {
            clients = supplied
        } else {
            let ids = defaults.stringArray(forKey: "openstrudel.deviceConnections") ?? ["current"]
            clients = (ids.isEmpty ? ["current"] : ids).map { $0 == "current" ? HomeClient(defaults: defaults) : Self.makeClient(id: $0) }
        }
        selectedID = defaults.string(forKey: "openstrudel.selectedDevice") ?? clients[0].id
        observeClients()
        #if os(macOS)
        if LocalDataReset.current.pending { isErasing = true }
        #endif
    }

    private static func makeClient(id: String) -> HomeClient {
        let name = (Bundle.main.bundleIdentifier ?? "is.openstrudel.mac") + ".device." + id
        return HomeClient(defaults: UserDefaults(suiteName: name)!, connectionID: id)
    }

    private func observeClients() {
        observations = clients.map { client in
            client.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        }
    }

    func select(_ client: HomeClient) {
        guard !isErasing, clients.contains(where: { $0 === client }) else { return }
        selectedID = client.id
        defaults.set(selectedID, forKey: "openstrudel.selectedDevice")
    }

    func select(_ client: HomeClient, profile: String?) async {
        select(client)
        await client.selectProfile(profile)
    }

    func select(_ client: HomeClient, group: TelegramChat) async {
        select(client)
        await client.selectChat(group.conversationId)
        await client.refreshOpenAIAccount()
    }

    func beginEmployee(on client: HomeClient? = nil, deviceID: String? = nil) {
        guard !isErasing else { return }
        let target = client ?? visibleClients.first(where: \.isLocalConnection) ?? active
        select(target)
        target.beginEmployee()
        if let deviceID { target.draftDeviceID = deviceID }
    }

    func preparePairing(_ url: URL) {
        guard !isErasing else { return }
        do { invitation = try MacPairing(url: url) }
        catch { active.errorMessage = error.localizedDescription }
    }

    func newConnection() -> HomeClient { Self.makeClient(id: UUID().uuidString.lowercased()) }

    func connection(for pairing: MacPairing) -> HomeClient {
        clients.first { $0.savedBaseURL == pairing.baseURL } ?? newConnection()
    }

    func chooseEmployeeDevice(_ target: HomeClient, deviceID: String? = nil) {
        let old = active
        guard old.isEmployeeDraft else { beginEmployee(on: target, deviceID: deviceID); return }
        if old === target { if let deviceID { target.draftDeviceID = deviceID }; return }
        let oldKey = HomeDrafts.key(home: old.baseURLString, profile: old.selectedProfileID, chat: nil)
        beginEmployee(on: target, deviceID: deviceID)
        let newKey = HomeDrafts.key(home: target.baseURLString, profile: target.selectedProfileID, chat: nil)
        var drafts = defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String] ?? [:]
        drafts[newKey] = drafts[oldKey]
        drafts.removeValue(forKey: oldKey)
        defaults.set(drafts, forKey: "openstrudel.drafts")
        fileDrafts[newKey] = fileDrafts[oldKey]
        fileDrafts.removeValue(forKey: oldKey)
        old.releaseEmployeeDraft()
    }

    func add(_ client: HomeClient, select shouldSelect: Bool = true) {
        guard !isErasing, client.isConfigured, !client.isSignedOut else { return }
        // A refreshed invitation replaces only that device's connection.
        // Existing local/remote devices and their drafts remain untouched.
        if let index = clients.firstIndex(where: { $0.normalizedBaseURL == client.normalizedBaseURL && $0.id != client.id }) {
            clients[index] = client
        } else if !clients.contains(where: { $0 === client }) { clients.append(client) }
        defaults.set(clients.map(\.id), forKey: "openstrudel.deviceConnections")
        observeClients()
        if shouldSelect { select(client) }
    }

    #if os(macOS)
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
        let reset = LocalDataReset.current
        eraseError = nil
        do { try reset.begin() }
        catch { eraseError = error.localizedDescription; return }
        isErasing = true
        HomeClient.invalidateForLocalErase()
        invitation = nil; fileDrafts = [:]
        for client in clients { client.suspendForLocalErase() }
        erasePhase = "Останавливаем сотрудников этого Mac…"
        await LocalHome.prepareForErase()
        await DigitalOceanCloud.shared.prepareForLocalErase()
        do {
            try await Task.detached { try reset.stopManagedService() }.value
            erasePhase = "Удаляем сотрудников, чаты и файлы…"
            try await Task.detached { try reset.eraseFiles(stop: { try reset.stopManagedService() }) }.value
            erasePhase = "Удаляем сохранённые входы и настройки…"
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
