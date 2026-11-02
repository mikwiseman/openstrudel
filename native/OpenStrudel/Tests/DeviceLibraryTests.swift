import Foundation
import Security
import Testing

@Suite(.serialized)
@MainActor struct DeviceLibraryTests {
    @Test func addingTwoAndRemovingTwoKeepsTheNewListAfterReopening() async throws {
        let suite = "OpenStrudel.device-persistence." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        let credentials = MemoryConnectionCredentials()
        var domains = [suite]
        defer { for domain in domains { UserDefaults.standard.removePersistentDomain(forName: domain) } }
        let factory: (String) -> HomeClient = { id in
            let domain = suite + "." + id
            if !domains.contains(domain) { domains.append(domain) }
            return HomeClient(defaults: UserDefaults(suiteName: domain)!, connectionID: id,
                credentialReader: { account, _ in credentials.read(account) },
                credentialWriter: { account, value in credentials.write(account, value) })
        }
        for id in ["old-a", "old-b", "new-a", "new-b"] {
            let saved = HomeConnection(url: "https://\(id).example:7789", token: "fixture-\(id)", pin: String(repeating: "b", count: 64), name: id)
            credentials.write(id + ".home-connection", String(decoding: try JSONEncoder().encode(saved), as: UTF8.self))
        }
        defaults.set(["old-a", "old-b"], forKey: "openstrudel.deviceConnections")
        let library = DeviceLibrary(defaults: defaults, clientFactory: factory)
        let old = library.clients
        library.add(factory("new-a")); library.add(factory("new-b"))
        await library.removeConnection(old[0]); await library.removeConnection(old[1])
        #expect(library.visibleClients.map(\.id) == ["new-a", "new-b"])
        let reopened = DeviceLibrary(defaults: defaults, clientFactory: factory)
        #expect(reopened.visibleClients.map(\.id) == ["new-a", "new-b"])
        #expect(reopened.active.id == "new-b")
        #expect(reopened.clients.allSatisfy { $0.hasToken && !$0.connectionNeedsPairing })
        #expect(credentials.read("old-a.home-connection") == nil)
        #expect(credentials.read("new-a.home-connection") != nil)
    }

    @Test func removalPersistsBeforeSlowLogoutAndCannotRemoveAReplacement() async throws {
        let suite = "OpenStrudel.pending-logout." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("http://127.0.0.1:57091", forKey: "openstrudel.homeURL")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DelayedLogoutProtocol.self]
        let transport = URLSession(configuration: config)
        defer { DelayedLogoutProtocol.release = true; transport.invalidateAndCancel() }
        DelayedLogoutProtocol.started = false; DelayedLogoutProtocol.release = false
        let first = HomeClient(defaults: defaults, session: transport, connectionID: suite + "-old",
            credentialReader: { account, _ in account.hasSuffix("home-api-token") ? "fixture" : nil }, credentialWriter: { _, _ in })
        // Keep the injected transport, but exercise a paired remote logout.
        first.baseURLString = "https://logout.example:7789"
        await first.load(quiet: true)
        #expect(first.health?.deviceLogoutVersion == 1)
        let replacement = HomeClient(defaults: defaults, connectionID: suite + "-new", credentialReader: { _, _ in nil }, credentialWriter: { _, _ in })
        let library = DeviceLibrary(defaults: defaults, clients: [first, replacement])
        defaults.set([first.id, replacement.id], forKey: "openstrudel.deviceConnections")
        let removal = Task { await library.removeConnection(first) }
        for _ in 0..<200 where !DelayedLogoutProtocol.started { try await Task.sleep(for: .milliseconds(5)) }
        #expect(DelayedLogoutProtocol.started)
        #expect(defaults.stringArray(forKey: "openstrudel.deviceConnections") == [replacement.id])
        #expect(library.clients.first === replacement)
        DelayedLogoutProtocol.release = true
        await removal.value
        #expect(library.clients.first === replacement && !replacement.isSignedOut)
        #expect(defaults.stringArray(forKey: "openstrudel.deviceConnections") == [replacement.id])
    }

    @Test func collapsedDevicesPersist() throws {
        let suite = "OpenStrudel.collapsed-devices." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("http://127.0.0.1:57107", forKey: "openstrudel.homeURL")
        let client = HomeClient(defaults: defaults, connectionID: suite, credentialReader: { _, _ in nil })
        let library = DeviceLibrary(defaults: defaults, clients: [client])
        library.setCollapsed(true, client: client)
        let reopened = DeviceLibrary(defaults: defaults, clients: [client])
        #expect(reopened.collapsedDeviceIDs == [client.id])
        reopened.setCollapsed(false, client: client)
        #expect(DeviceLibrary(defaults: defaults, clients: [client]).collapsedDeviceIDs.isEmpty)
    }

    @Test func restoringLocalRuntimeDoesNotDependOnTheSelectedRemoteEmployee() throws {
        let name = "OpenStrudel.local-runtime-restore." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        // Construct away from the real local endpoint so the fixture never
        // reads this Mac's LocalConnection.json or uses its credentials.
        defaults.set("http://127.0.0.1:57106", forKey: "openstrudel.homeURL")
        let local = HomeClient(defaults: defaults, connectionID: name + "-local", credentialReader: { account, _ in
            account.hasSuffix("home-api-token") ? "fixture" : nil
        })
        local.baseURLString = "http://127.0.0.1:7788"
        let remote = HomeClient(defaults: defaults, connectionID: name + "-remote", credentialReader: { _, _ in nil })
        remote.baseURLString = "https://remote.example"
        let library = DeviceLibrary(defaults: defaults, clients: [local, remote])
        library.select(remote)
        #expect(library.localClientToRestore === local)
        #expect(library.active === remote)
        local.baseURLString = "http://127.0.0.1:57106"
        #expect(library.localClientToRestore == nil, "An unrelated loopback service is not the managed Home")
    }

    @Test func restoringLocalRuntimeDoesNotReconnectASignedOutDevice() async throws {
        let name = "OpenStrudel.local-runtime-signed-out." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("http://127.0.0.1:57107", forKey: "openstrudel.homeURL")
        let local = HomeClient(defaults: defaults, connectionID: name, credentialReader: { account, _ in
            account.hasSuffix("home-api-token") ? "fixture" : nil
        })
        local.baseURLString = "http://127.0.0.1:7788"
        let library = DeviceLibrary(defaults: defaults, clients: [local])
        #expect(library.localClientToRestore === local)
        await local.signOutOnThisDevice()
        #expect(library.localClientToRestore == nil)
    }

    @Test func lockedCredentialsKeepTheDestinationAndRecoverWithoutPairingAgain() async throws {
        let name = "OpenStrudel.unlock-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let connection = HomeConnection(url: "https://server.example:7789", token: "fixture", pin: String(repeating: "b", count: 64), name: "My server")
        let saved = String(decoding: try JSONEncoder().encode(connection), as: UTF8.self)
        defaults.set(connection.url, forKey: "openstrudel.homeURL")
        let client = HomeClient(defaults: defaults, connectionID: name, credentialReader: { account, interactive in
            guard account.hasSuffix("home-connection") else { return nil }
            guard interactive else { throw URLError(.userAuthenticationRequired) }
            return saved
        })
        #expect(client.connectionNeedsUnlock)
        #expect(client.connectionNeedsPairing)
        #expect(!client.isConfigured)
        #expect(client.baseURLString == connection.url) // Same draft namespace while locked.
        await #expect(throws: HomeClientError.self) {
            let _: HomeHealth = try await client.management("/health")
        }
        #expect(await client.unlockSavedConnection())
        #expect(!client.connectionNeedsUnlock)
        #expect(!client.connectionNeedsPairing)
        #expect(client.isConfigured && client.hasToken)
        #expect(client.baseURLString == connection.url)
        #expect(client.connectionName == connection.name)
        #expect(!client.isUnlockingConnection)
    }

    @Test func aMissingCredentialStillNeedsANewConnectionLink() async throws {
        let name = "OpenStrudel.missing-credential-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("https://server.example:7789", forKey: "openstrudel.homeURL")
        let client = HomeClient(defaults: defaults, connectionID: name, credentialReader: { _, _ in nil })
        #expect(client.connectionNeedsPairing)
        #expect(!client.connectionNeedsUnlock)
        #expect(!client.isConfigured)
        #expect(await client.unlockSavedConnection() == false)
    }

    @Test func aLockedPairingAttemptDoesNotReplaceTheAttemptOrLockTheExistingConnection() async throws {
        let name = "OpenStrudel.pairing-credential-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let pin = String(repeating: "b", count: 64)
        let connection = HomeConnection(url: "https://server.example:7789", token: "fixture", pin: pin, name: "My server")
        let saved = String(decoding: try JSONEncoder().encode(connection), as: UTF8.self)
        let client = HomeClient(defaults: defaults, connectionID: name, credentialReader: { account, _ in
            if account.contains("pair-attempt-") { throw HomeClientError.server("Keychain is locked") }
            return account.hasSuffix("home-connection") ? saved : nil
        })
        let link = try #require(URL(string: "openstrudel://connect?host=other.example&port=7789&key=\(String(repeating: "a", count: 64))&pin=\(pin)"))
        #expect(await client.connectToMac(try MacPairing(url: link)) == false)
        #expect(client.pairingError != nil)
        #expect(!client.connectionNeedsUnlock && !client.connectionNeedsPairing)
        #expect(client.isConfigured && client.hasToken)
        #expect(client.baseURLString == connection.url)
    }

    @Test func decliningKeychainAccessKeepsTheSavedConnectionForRetry() async throws {
        let name = "OpenStrudel.declined-credential-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("https://server.example:7789", forKey: "openstrudel.homeURL")
        let client = HomeClient(defaults: defaults, connectionID: name, credentialReader: { _, _ in throw URLError(.userCancelledAuthentication) })
        #expect(await client.unlockSavedConnection() == false)
        #expect(client.connectionNeedsUnlock && client.connectionNeedsPairing)
        #expect(!client.hasToken && !client.isUnlockingConnection)
        #expect(client.errorMessage != nil)
        #expect(defaults.string(forKey: "openstrudel.homeURL") == "https://server.example:7789")
    }

    @Test func delayedKeychainAccessCannotReconnectAfterLocalErase() async throws {
        let name = "OpenStrudel.stale-credential-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("https://server.example:7789", forKey: "openstrudel.homeURL")
        let gate = CredentialReadGate()
        defer { gate.finish.signal() }
        let saved = String(decoding: try JSONEncoder().encode(HomeConnection(url: "https://server.example:7789", token: "fixture", pin: String(repeating: "b", count: 64), name: "Server")), as: UTF8.self)
        let client = HomeClient(defaults: defaults, connectionID: name, credentialReader: { account, interactive in
            guard account.hasSuffix("home-connection") else { return nil }
            guard interactive else { throw URLError(.userAuthenticationRequired) }
            gate.markStarted()
            guard gate.finish.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
            return saved
        })
        let operation = Task { await client.unlockSavedConnection() }
        var started = false
        for _ in 0..<200 {
            if gate.didStart { started = true; break }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(started)
        client.suspendForLocalErase()
        gate.finish.signal()
        #expect(await operation.value == false)
        #expect(client.isSignedOut && !client.hasToken && !client.isConfigured)
        #expect(client.baseURLString.isEmpty)
    }

    @Test func aPairedTLSConnectionIsNotTheLocalRuntime() throws {
        let name = "OpenStrudel.paired-device-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("https://127.0.0.1:57104", forKey: "openstrudel.homeURL")
        let client = HomeClient(defaults: defaults, connectionID: name)
        client.baseURLString = "https://127.0.0.1:57104"
        #expect(!client.isLocalConnection)
    }

    @Test func addingAnIndependentDeviceKeepsLocalEmployeesAndCredentialsSeparate() throws {
        let name = "OpenStrudel.devices-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("http://127.0.0.1:57101", forKey: "openstrudel.homeURL")
        let local = HomeClient(defaults: defaults, connectionID: name + "-local")
        let remote = HomeClient(defaults: defaults, connectionID: name + "-remote")
        remote.baseURLString = "https://remote.example"
        let library = DeviceLibrary(defaults: defaults, clients: [local])
        library.add(remote)
        #expect(library.clients.count == 2)
        #expect(library.active === remote)
        #expect(local.normalizedBaseURL == "http://127.0.0.1:57101")
        #expect(remote.normalizedBaseURL == "https://remote.example")
        #expect(local.id != remote.id)
        #expect(!remote.canManageOpenAI)
        #expect(library.select(local))
        #expect(library.active === local)
    }

    @Test func removingOneDeviceLeavesTheOtherDeviceUsable() async throws {
        let name = "OpenStrudel.remove-device-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("http://127.0.0.1:57103", forKey: "openstrudel.homeURL")
        let first = HomeClient(defaults: defaults, connectionID: name + "-one")
        let second = HomeClient(defaults: defaults, connectionID: name + "-two")
        let library = DeviceLibrary(defaults: defaults, clients: [first, second])
        await second.signOutOnThisDevice()
        #expect(first.isConfigured)
        #expect(!first.isSignedOut)
        #expect(library.visibleClients.count == 1)
        #expect(library.visibleClients.first === first)
    }
}

private final class MemoryConnectionCredentials: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func read(_ account: String) -> String? { lock.withLock { values[account] } }
    func write(_ account: String, _ value: String?) { lock.withLock { values[account] = value } }
}

private final class DelayedLogoutProtocol: URLProtocol, @unchecked Sendable {
    @MainActor static var started = false
    @MainActor static var release = false
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Task { @MainActor in
            if request.url?.path == "/auth/device/logout" {
                Self.started = true
                while !Self.release { try? await Task.sleep(for: .milliseconds(5)) }
            }
            guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else { return }
            let body: String
            switch url.path {
            case "/health": body = #"{"ok":true,"service":"openstrudel","deviceLogoutVersion":1}"#
            case "/v1/profiles": body = #"{"profiles":[]}"#
            case "/v1/account": body = #"{"account":{"connected":false}}"#
            case "/v1/integrations": body = #"{"telegram":{"configured":false,"running":false,"linkedChats":[]}}"#
            default: body = "{}"
            }
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

private final class CredentialReadGate: @unchecked Sendable {
    private let lock = NSLock()
    private var started = false
    var didStart: Bool { lock.withLock { started } }
    func markStarted() { lock.withLock { started = true } }
    let finish = DispatchSemaphore(value: 0)
}

@Suite(.serialized)
@MainActor struct DeviceManagementTests {
    @Test func renamingAnEmployeeOnAnOlderHomeKeepsItsInstructions() async throws {
        let fixture = DevicesFixture()
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        try await client.renameProfile(id: "employee", name: "Редактор")
        #expect(fixture.renames.last?["instructions"] as? String == "Пиши кратко")
        #expect(fixture.renames.last?["keepInstructions"] as? Bool == true, "A newer Home keeps its own copy over this cached one")
        #expect(client.profiles.first?.instructions == "Пиши кратко")

        fixture.flags["employeeRenameKeepsInstructions"] = 1
        await client.load()
        try await client.renameProfile(id: "employee", name: "Редактор 2")
        #expect(fixture.renames.last?["name"] as? String == "Редактор 2")
        #expect(fixture.renames.last?["instructions"] == nil)
        #expect(client.profiles.first?.instructions == "Пиши кратко")
    }

    @Test func aHomeThatCannotShareANewNameOffersNoRename() async throws {
        let fixture = DevicesFixture()
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        #expect(client.health?.homeProtocol == 1)
        #expect(!client.canRenameDevice, "An older Home keeps listing the old name, so a rename would silently revert")
        fixture.flags["deviceRenameVersion"] = 1
        await client.load()
        #expect(client.canRenameDevice)
    }

    @Test func aDeviceThatComesBackUpdatedOffersRenameWithoutWaitingForTheNextLoad() async throws {
        let fixture = DevicesFixture()
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        #expect(client.ownsDevice && !client.canRenameDevice)
        let checks = fixture.healthChecks
        await client.refreshCatalogue()
        #expect(fixture.healthChecks == checks, "A device that stays online is not asked for its health on every poll")
        let library = DeviceLibrary(clients: [client])
        fixture.offline = true
        await client.refreshCatalogue()
        #expect(client.homeUnreachable)
        #expect(library.visibleClients.contains { $0 === client }, "Loss of reachability must never remove a saved server")
        #expect(client.connectionJournal.events.contains { $0.kind == .unavailable })
        fixture.offline = false; fixture.flags["deviceRenameVersion"] = 1
        await client.refreshCatalogue()
        #expect(!client.homeUnreachable)
        #expect(client.connectionJournal.events.first?.kind == .connected)
        #expect(client.canRenameDevice, "The returning Home's abilities, not the ones from before its update")
    }

    @Test func aDeviceThatComesBackWithColleagueInvitesListsTheOwnersDevicesOnTheNextLoad() async throws {
        let fixture = DevicesFixture()
        let (client, cleanup) = makeClient(fixture, saved: ["openstrudel.homeURL": "https://server.test:7789"])
        defer { cleanup() }
        await client.load()
        #expect(client.canManageConnections && client.mobileClients.isEmpty)
        fixture.offline = true
        await client.refreshCatalogue()
        fixture.offline = false; fixture.flags["colleagueInvitesVersion"] = 1
        await client.refreshCatalogue()
        #expect(client.supportsColleagueInvites)
        await client.load()
        #expect(client.mobileClients.count == 2, "The owner's lists follow the returning Home's abilities")
    }

    @Test func anUpdateFoundByALoadListsTheOwnersDevicesInThatLoad() async throws {
        let fixture = DevicesFixture()
        let (client, cleanup) = makeClient(fixture, saved: ["openstrudel.homeURL": "https://server.test:7789"])
        defer { cleanup() }
        await client.load()
        #expect(client.canManageConnections && client.mobileClients.isEmpty)
        // The Home restarted between two polls, so only the next load sees what it supports now.
        fixture.flags["colleagueInvitesVersion"] = 1
        await client.load()
        #expect(client.mobileClients.count == 2, "The owner's lists follow the Home's abilities however they arrive")
        let asked = fixture.mobileChecks
        await client.load()
        #expect(fixture.mobileChecks == asked, "Unchanged abilities keep the check once per connection")
    }

    @Test func anOwnerCheckTheHomeNeverAnsweredIsAskedAgainOnTheNextLoad() async throws {
        let fixture = DevicesFixture()
        fixture.mobileTimesOut = true; fixture.flags["colleagueInvitesVersion"] = 1
        let (client, cleanup) = makeClient(fixture, saved: ["openstrudel.homeURL": "https://server.test:7789"])
        defer { cleanup() }
        await client.load()
        #expect(!client.canManageConnections)
        fixture.mobileTimesOut = false
        await client.load()
        #expect(client.canManageConnections, "A timeout is not a refusal, so the owner keeps the invite buttons")
        let asked = fixture.mobileChecks
        await client.load()
        #expect(fixture.mobileChecks == asked, "An answered check runs once per connection")
        fixture.mobileTimesOut = true
        await client.refreshMobileStatus()
        #expect(client.canManageConnections && client.mobileClients.count == 2, "Only the Home's refusal takes owner rights away")
    }

    @Test func theHomesRefusalOrARevokedCredentialTakesOwnerRightsAway() async throws {
        let fixture = DevicesFixture()
        fixture.flags["colleagueInvitesVersion"] = 1; fixture.invitations = [("link", false)]
        let server = ["openstrudel.homeURL": "https://server.test:7789"]
        let (client, cleanup) = makeClient(fixture, saved: server)
        defer { cleanup() }
        await client.load()
        #expect(client.canManageConnections && client.mobileClients.count == 2 && client.waitingInvitations.count == 1)
        fixture.colleague = true
        await client.refreshMobileStatus()
        #expect(!client.canManageConnections && client.mobileClients.isEmpty && client.waitingInvitations.isEmpty)
        fixture.colleague = false
        await client.refreshMobileStatus()
        #expect(client.canManageConnections)
        fixture.revoked = true
        await client.refreshMobileStatus()
        #expect(!client.canManageConnections, "A revoked credential answers as clearly as a refusal")

        let other = DevicesFixture()
        other.colleague = true
        let (colleague, cleanupColleague) = makeClient(other, saved: server)
        defer { cleanupColleague() }
        await colleague.load()
        await colleague.load()
        #expect(other.mobileChecks == 1, "A refusal is an answer, so this connection does not ask again")
    }

    @Test func theOwnerCanRenameAServerWhoseChatGPTAccountIsUnavailable() async throws {
        let fixture = DevicesFixture()
        fixture.flags["deviceRenameVersion"] = 1
        fixture.accountUnavailable = true
        let server = ["openstrudel.homeURL": "https://server.test:7789"]
        let (client, cleanup) = makeClient(fixture, saved: server)
        defer { cleanup() }
        await client.load()
        #expect(client.canRenameDevice, "Owning the device, not its ChatGPT account, decides who renames it")

        let other = DevicesFixture()
        other.flags["deviceRenameVersion"] = 1
        other.accountUnavailable = true
        other.colleague = true
        let (colleague, cleanupColleague) = makeClient(other, saved: server)
        defer { cleanupColleague() }
        await colleague.load()
        #expect(!colleague.canRenameDevice)
    }

    @Test func theOwnerCanMoveEmployeesWhileTheChatGPTAccountCannotAnswer() async throws {
        let fixture = DevicesFixture()
        fixture.flags["employeeTransferVersion"] = 1
        fixture.accountUnavailable = true; fixture.holdAccount = true
        let server = ["openstrudel.homeURL": "https://server.test:7789"]
        let (client, cleanup) = makeClient(fixture, saved: server)
        defer { cleanup() }
        #expect(client.employeeMoveBlocker == L("«\(client.displayName)» пока не на связи. Подключимся автоматически."))
        let loading = Task { await client.load() }
        for _ in 0..<500 where !client.canManageConnections { try await Task.sleep(for: .milliseconds(10)) }
        #expect(!client.canManageOpenAI, "The ChatGPT account has not answered")
        #expect(client.canMoveEmployees, "Owning the device, not its ChatGPT account, decides who moves its employees")
        fixture.holdAccount = false; await loading.value
        #expect(client.canMoveEmployees && client.employeeMoveBlocker == nil)

        let other = DevicesFixture()
        other.accountUnavailable = true; other.colleague = true
        let (colleague, cleanupColleague) = makeClient(other, saved: server)
        defer { cleanupColleague() }
        await colleague.load()
        #expect(colleague.employeeMoveBlocker == L("Подключение к «\(colleague.displayName)» без доступа владельца. Переносить сотрудников может только владелец."))
    }

    @Test func namesNeverShowAHostnameSuffixAndTheServerDefaultFollowsTheLanguage() async throws {
        #expect(deviceTitle("Server", language: .russian) == "Сервер")
        #expect(deviceTitle("Server", language: .french) == "Serveur")
        #expect(deviceTitle("waiMini.local") == "waiMini")
        #expect(deviceTitle(".local") == ".local")
        #expect(deviceTitle("Рабочий сервер") == "Рабочий сервер")
        let fixture = DevicesFixture()
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        #expect(client.displayName == L("Этот Mac"))
        fixture.flags["deviceRenameVersion"] = 1
        fixture.deviceName = "waiMini.local"
        await client.load()
        #expect(client.displayName == "waiMini")
        #expect(client.devices.first?.name == "waiMini")
    }

    @Test func devicesWithTheSameNameAreToldApartByTheirAddress() throws {
        var suites: [String] = []
        defer { suites.forEach { UserDefaults().removePersistentDomain(forName: $0) } }
        func server(_ url: String, _ name: String) throws -> HomeClient {
            let suite = "OpenStrudel.same-name." + UUID().uuidString
            suites.append(suite)
            let defaults = try #require(UserDefaults(suiteName: suite))
            defaults.set(url, forKey: "openstrudel.homeURL")
            defaults.set(name, forKey: "openstrudel.connectionName")
            return HomeClient(defaults: defaults, connectionID: suite, credentialReader: { account, _ in
                account.hasSuffix("home-certificate-pin") ? String(repeating: "b", count: 64) : account.hasSuffix("home-api-token") ? "fixture" : nil
            }, credentialWriter: { _, _ in })
        }
        let first = try server("https://2.29.5.55:7789", "Команда")
        let second = try server("https://62.238.6.198:7789", "Команда")
        let other = try server("https://203.0.113.10:7789", "Grant")
        let defaults = try #require(UserDefaults(suiteName: suites[0]))
        let library = DeviceLibrary(defaults: defaults, clients: [first, second, other])
        #expect(library.addressDetail(for: first) == "2.29.5.55")
        #expect(library.addressDetail(for: second) == "62.238.6.198")
        #expect(library.addressDetail(for: other) == nil)
    }

    @Test func colleagueInvitationsOutliveTheSheetAndOneColleagueCanBeDisconnected() async throws {
        let fixture = DevicesFixture()
        fixture.flags["colleagueInvitesVersion"] = 1
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        await client.refreshMobileStatus()
        #expect(client.supportsColleagueInvites)
        #expect(client.mobileClients.map(\.id) == ["owner-phone", "colleague"])
        #expect(client.mobileClients.first?.current == true)
        #expect(client.mobileClients.last?.isColleague == true)
        #expect(client.mobileClients.last?.pairedDate != nil)

        await client.inviteMobile(owner: false)
        await client.cancelMobileInvitation(colleague: true)
        #expect(fixture.cancelledInvitations == 0, "A colleague's link keeps working after the sheet closes")
        await client.inviteMobile()
        #expect(!client.keepsInvitation(owner: true), "This Home's own links last five minutes")
        await client.cancelMobileInvitation()
        #expect(fixture.cancelledInvitations == 1)

        try await client.revokeMobileClient("colleague")
        #expect(fixture.revokedClients == ["colleague"])
        #expect(client.mobileClients.map(\.id) == ["owner-phone"])
    }

    @Test func theOwnerCanDisconnectEveryOtherDeviceIncludingTheirOwnLostPhone() async throws {
        let fixture = DevicesFixture()
        fixture.flags["colleagueInvitesVersion"] = 1
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        await client.refreshMobileStatus()
        #expect(client.mobileClients.map(\.canDisconnect) == [false, true], "The device asking keeps its own access")
        let lost = try JSONDecoder().decode(MobileClient.self, from: Data(#"{"id":"lost-iphone","label":"iPhone","role":"owner","current":false}"#.utf8))
        #expect(lost.canDisconnect, "A lost owner phone can be cut off")
        try await client.revokeMobileClient(lost.id)
        #expect(fixture.revokedClients == ["lost-iphone"])
    }

    @Test func aNewColleagueLinkReplacesTheOneOnScreenAndAWaitingLinkCanBeCancelled() async throws {
        let fixture = DevicesFixture()
        fixture.flags["colleagueInvitesVersion"] = 1
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        await client.inviteMobile(owner: false)
        let first = try #require(client.mobileInvitation?.id)
        await client.inviteMobile(owner: false)
        #expect(fixture.cancelledInvitationIDs == [first], "«Новая ссылка» ends the link it replaces")
        let second = try #require(client.mobileInvitation?.id)
        await client.cancelMobileInvitation(colleague: true)
        await client.refreshMobileStatus()
        #expect(client.waitingInvitations.map(\.id) == [second], "Closing the sheet keeps the link, and Settings lists it")
        #expect(client.waitingInvitations.first?.expiryDate != nil)
        #expect(client.waitingInvitations.first?.isOwner == false, "A Home that sends no role lists only colleague links")
        try await client.cancelInvitation(second)
        #expect(fixture.cancelledInvitationIDs == [first, second])
        #expect(client.waitingInvitations.isEmpty)
    }

    @Test func theOwnersOwnLinkLastsADayOutlivesTheSheetAndCanBeCancelledInSettings() async throws {
        let fixture = DevicesFixture()
        fixture.flags["colleagueInvitesVersion"] = 1
        fixture.flags["ownerInvitesVersion"] = 1
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        #expect(client.keepsInvitation(owner: true) && client.keepsInvitation(owner: false))
        await client.inviteMobile(owner: false)
        let colleague = try #require(client.mobileInvitation?.id)
        await client.cancelMobileInvitation(colleague: true)
        await client.inviteMobile()
        let own = try #require(client.mobileInvitation?.id)
        await client.cancelMobileInvitation()
        #expect(fixture.cancelledInvitations == 0, "Closing the owner's sheet keeps the link")
        await client.refreshMobileStatus()
        #expect(client.waitingInvitations.map(\.id) == [colleague, own])
        #expect(client.waitingInvitations.map(\.isOwner) == [false, true])
        try await client.cancelInvitation(own)
        #expect(fixture.cancelledInvitationIDs == [own])
        #expect(client.waitingInvitations.map(\.id) == [colleague])
    }

    @Test func anOlderHomeKeepsItsSingleShortInvitation() async throws {
        let fixture = DevicesFixture()
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        await client.refreshMobileStatus()
        #expect(!client.supportsColleagueInvites)
        #expect(client.mobileClients.isEmpty)
        #expect(client.canManageConnections)
        await client.inviteMobile(owner: false)
        await client.cancelMobileInvitation(colleague: true)
        #expect(fixture.cancelledInvitations == 1)
    }

    @Test func anOlderHomeShowsTheSavedConnectionNameInsteadOfItsContainerID() async throws {
        let fixture = DevicesFixture()
        fixture.deviceName = "020bc40355c2"
        // A server set up from the app, and the container ID an earlier build adopted from its older Home.
        let (client, cleanup) = makeClient(fixture, saved: ["openstrudel.homeURL": "https://server.test:7789", "openstrudel.connectionName": "Моя команда", "openstrudel.deviceName": "020bc40355c2"])
        defer { cleanup() }
        await client.load()
        #expect(client.devices.count == 1)
        #expect(client.displayName == "Моя команда")
        #expect(client.devices.first?.name == deviceTitle("Server"), "A container ID is never shown")
        #expect(deviceTitle(String(repeating: "ab", count: 32), language: .russian) == "Сервер")
        fixture.flags["deviceRenameVersion"] = 1
        fixture.deviceName = "Server"
        await client.load()
        #expect(client.displayName == deviceTitle("Server"), "An updated Home's shared name wins")
    }

    @Test func savingTheRenameSheetUnchangedKeepsTheTranslatableDefault() async throws {
        let fixture = DevicesFixture()
        fixture.flags["deviceRenameVersion"] = 1
        fixture.deviceName = "Server"
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        try await client.renameDevice(client.displayName)
        #expect(fixture.homeRenames.isEmpty, "The localized default must not become a fixed name for every client")
        try await client.renameDevice("Рабочий сервер")
        #expect(fixture.homeRenames == ["Рабочий сервер"])
        #expect(client.displayName == "Рабочий сервер")
    }

    @Test func credentialsAreSavedAndRemovedWithoutAKeychainDialog() async throws {
        let suite = "OpenStrudel.silent-keychain." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let log = KeychainLog()
        let client = HomeClient(defaults: defaults, connectionID: suite, credentialReader: { account, _ in
            log.record(account); return nil
        }, credentialWriter: { account, _ in log.record(account) })
        let key = String(repeating: "c", count: 64)
        #expect(await client.connectToCloud(HomeConnection(url: "https://127.0.0.1:9", token: key, pin: key, name: "Server")))
        client.disconnectFromMac()
        #expect(log.entries.count >= 5)
        #expect(log.entries.allSatisfy { !$0.allowed }, "\(log.entries)")
    }

    @Test func onlyTheOwnerOfAHomeThatKeepsThePrivateChatAnsweringChoosesWhoAnswersIt() async throws {
        let fixture = DevicesFixture()
        fixture.bot = true
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        // The employees offered for the private chat; nil keeps the plain «В Telegram отвечает …» line.
        func responders(_ client: HomeClient) -> [String]? {
            guard let chat = client.telegram?.chats?.first else { return nil }
            return client.telegramResponders(for: chat)?.map(\.id)
        }
        await client.load()
        #expect(client.telegram?.chats?.first?.chatId == "42")
        #expect(client.ownsDevice)
        #expect(responders(client) == nil, "An older Home pauses the private chat when it returns to the main assistant")
        fixture.flags["telegramPrivateChoiceVersion"] = 1
        await client.load()
        #expect(responders(client) == ["employee"])
        fixture.telegramResponder = "employee"
        await client.load()
        #expect(responders(client) == ["employee"])
        // The chat still answers with an employee that has left this device; the plain line keeps its name.
        fixture.telegramResponder = "moved"
        await client.load()
        #expect(responders(client) == nil)
        fixture.telegramResponder = nil
        // The only employee lives on another device, so this device has no one to choose.
        fixture.profileDevice = "worker"
        await client.load()
        #expect(responders(client) == nil)
        // The employee's bot runs on another device, whose version this connection cannot see.
        await client.selectProfile("employee")
        #expect(client.activeProfile?.deviceId == "worker")
        #expect(responders(client) == nil)

        let other = DevicesFixture()
        other.bot = true; other.flags["telegramPrivateChoiceVersion"] = 1
        other.accountUnavailable = true; other.colleague = true
        let (colleague, cleanupColleague) = makeClient(other, saved: ["openstrudel.homeURL": "https://server.test:7789"])
        defer { cleanupColleague() }
        await colleague.load()
        #expect(colleague.health?.telegramPrivateChoiceVersion == 1)
        #expect(colleague.telegram?.chats?.first?.chatId == "42")
        #expect(responders(colleague) == nil, "Only the device's owner may change who answers")
    }

    @Test func aSlowTelegramReadDoesNotUndoTheChosenResponder() async throws {
        let fixture = DevicesFixture()
        fixture.bot = true
        let (client, cleanup) = makeClient(fixture)
        defer { cleanup() }
        await client.load()
        #expect(client.telegram?.chats?.first?.profileId == nil)
        // The poll, the catalogue and a full load began before the choice and answer later with what they saw then.
        fixture.holdTelegram = true
        let poll = Task { await client.loadChatSettings() }
        let catalogue = Task { await client.refreshCatalogue() }
        for _ in 0..<500 where fixture.heldTelegramReads < 2 { try await Task.sleep(for: .milliseconds(10)) }
        let load = Task { await client.load() }
        for _ in 0..<500 where fixture.heldTelegramReads < 3 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(fixture.heldTelegramReads == 3)
        await client.bindTelegram(chatID: "42", profileID: "employee")
        #expect(client.telegram?.chats?.first?.profileId == "employee")
        fixture.holdTelegram = false
        await poll.value; await catalogue.value; await load.value
        #expect(client.telegram?.chats?.first?.profileId == "employee")
    }

    private func makeClient(_ fixture: DevicesFixture, saved: [String: String] = [:]) -> (HomeClient, () -> Void) {
        let suite = "OpenStrudel.devices-test." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set("http://127.0.0.1:57581", forKey: "openstrudel.homeURL")
        saved.forEach { defaults.set($0.value, forKey: $0.key) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DevicesProtocol.self]
        DevicesProtocol.setHandler { request in await fixture.respond(request) }
        let session = URLSession(configuration: config)
        // A remote Home answers only a paired credential.
        let remote = saved["openstrudel.homeURL"]?.hasPrefix("https://") == true
        let client = HomeClient(defaults: defaults, session: session, pendingDirectory: FileManager.default.temporaryDirectory.appending(path: suite),
                                connectionID: suite, credentialReader: { account, _ in remote && account.hasSuffix("home-api-token") ? "fixture" : nil }, credentialWriter: { _, _ in })
        return (client, { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) })
    }
}

/// The interaction flag is process-wide, so Keychain calls take turns.
struct KeychainInteractionTests {
    @Test func anExplicitUnlockCannotLendItsPermissionToABackgroundCall() {
        let log = KeychainLog()
        let unlocking = DispatchSemaphore(value: 0), answered = DispatchSemaphore(value: 0), done = DispatchGroup()
        DispatchQueue.global().async(group: done) {
            _ = try? KeychainInteraction.run(allowing: true) {
                log.record("unlock"); unlocking.signal(); answered.wait(); log.record("unlock")
            }
        }
        unlocking.wait()
        DispatchQueue.global().async(group: done) { _ = try? KeychainInteraction.run { log.record("background") } }
        Thread.sleep(forTimeInterval: 0.2)
        answered.signal()
        done.wait()
        #expect(log.entries.map { $0.name } == ["unlock", "unlock"], "The background call is refused, never run inside the dialog's window")
        #expect(log.entries.map { $0.allowed } == [true, true])
    }

    @Test @MainActor func aSilentCallOnTheMainThreadDoesNotWaitForAnOpenUnlockDialog() throws {
        let log = KeychainLog()
        let open = DispatchSemaphore(value: 0), answered = DispatchSemaphore(value: 0), done = DispatchGroup()
        DispatchQueue.global().async(group: done) {
            _ = try? KeychainInteraction.run(allowing: true) { open.signal(); _ = answered.wait(timeout: .now() + 3); log.record("unlock") }
        }
        open.wait()
        let start = Date()
        #expect(throws: (any Error).self, "Until the dialog is answered the Keychain counts as locked") { try KeychainInteraction.run { log.record("main") } }
        #expect(Date().timeIntervalSince(start) < 1, "The app stays responsive while the dialog is open")
        answered.signal(); done.wait()
        try KeychainInteraction.run { log.record("after") }
        #expect(log.entries.map { $0.name } == ["unlock", "after"])
        #expect(log.entries.map { $0.allowed } == [true, false])
    }
}

/// Records whether macOS could show a Keychain dialog during each credential call.
private final class KeychainLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(name: String, allowed: Bool)] = []
    var entries: [(name: String, allowed: Bool)] { lock.lock(); defer { lock.unlock() }; return values }
    func record(_ name: String) {
        var allowed = DarwinBoolean(true)
        SecKeychainGetUserInteractionAllowed(&allowed)
        lock.lock(); values.append((name, allowed.boolValue)); lock.unlock()
    }
}

@MainActor private final class DevicesFixture {
    var flags: [String: Int] = [:]
    /// The device's ChatGPT account cannot answer, for example when its limit ran out.
    var accountUnavailable = false
    /// The account request waits, as it does while the device asks ChatGPT.
    var holdAccount = false
    /// This client was invited as a colleague, so device management answers 403.
    var colleague = false
    /// The device is down, for example while it updates.
    var offline = false
    /// The owner check never gets an answer.
    var mobileTimesOut = false
    /// This client's credential was revoked.
    var revoked = false
    var healthChecks = 0
    var mobileChecks = 0
    var deviceName = "Mini"
    var instructions = "Пиши кратко"
    var profileName = "Тест"
    var renames: [[String: Any]] = []
    var cancelledInvitations = 0
    var revokedClients: [String] = []
    var homeRenames: [String] = []
    /// Links waiting to be used, and the ones cancelled by their id.
    var invitations: [(id: String, owner: Bool)] = []
    var cancelledInvitationIDs: [String] = []
    private var issuedInvitations = 0
    /// The device runs a bot linked to the owner's private chat 42.
    var bot = false
    /// The employee lives on another device of this Home.
    var profileDevice: String?
    var telegramResponder: String?
    /// Telegram reads wait, then answer with what they saw on arrival, like a slow poll.
    var holdTelegram = false
    var heldTelegramReads = 0
    private func telegram() -> [String: Any] {
        ["configured": true, "running": true, "linkedChats": ["42"],
         "chats": [["chatId": "42", "title": "Личный чат", "profileId": telegramResponder.map { $0 as Any } ?? NSNull(), "allowedSenders": ["42"], "enabled": true]]]
    }
    private func readTelegram() async -> [String: Any] {
        let seen = telegram()
        if holdTelegram { heldTelegramReads += 1 }
        while holdTelegram { try? await Task.sleep(for: .milliseconds(10)) }
        return seen
    }
    func respond(_ request: URLRequest) async -> (Int, Data) {
        if offline { return (503, Data()) }
        if revoked { return (401, Data()) }
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        func json(_ value: Any) -> (Int, Data) { (200, try! JSONSerialization.data(withJSONObject: value)) }
        let profile: () -> [String: Any] = { ["id": "employee", "name": self.profileName, "instructions": self.instructions, "capabilities": [], "createdAt": "2026-10-09T00:00:00Z", "deviceId": self.profileDevice ?? NSNull()] }
        if method == "GET", path == "/v1/mobile" { mobileChecks += 1 }
        switch (method, path) {
        case ("GET", "/health"):
            healthChecks += 1
            return json((["ok": true, "homeId": "home-fixture", "homeProtocol": 1, "nodeId": "node"] as [String: Any]).merging(flags) { _, new in new })
        case ("GET", "/v1/profiles") where bot: return json(["profiles": [profile()], "telegram": await readTelegram()])
        case ("GET", "/v1/profiles"): return json(["profiles": [profile()]])
        case ("PATCH", "/v1/profiles/employee"):
            let body = (try? JSONSerialization.jsonObject(with: Self.body(request))) as? [String: Any] ?? [:]
            renames.append(body)
            profileName = body["name"] as? String ?? profileName
            // An older Home replaces missing instructions with an empty value.
            instructions = body["instructions"] as? String ?? (flags["employeeRenameKeepsInstructions"] == 1 ? instructions : "")
            return json(["profile": profile()])
        case ("GET", "/v1/devices"):
            return json(["devices": [["id": "node", "name": deviceName, "platform": "linux", "primary": true, "online": true, "agents": 1]], "primaryId": "node"])
        case ("GET", "/v1/account"):
            while holdAccount { try? await Task.sleep(for: .milliseconds(10)) }
            if accountUnavailable { return (503, Data(#"{"error":"Лимит ChatGPT исчерпан"}"#.utf8)) }
            return json(["account": ["connected": true, "managed": true], "canManage": true])
        case ("GET", "/v1/mobile") where mobileTimesOut: return (504, Data())
        case ("GET", "/v1/mobile") where colleague: return (403, Data(#"{"error":"Откройте настройки на Mac"}"#.utf8))
        case ("GET", "/v1/integrations") where bot: return json(["telegram": await readTelegram()])
        case ("GET", "/v1/integrations"): return json(["telegram": ["configured": false, "running": false, "linkedChats": []]])
        case ("PATCH", "/v1/integrations/telegram/chats/42"):
            telegramResponder = ((try? JSONSerialization.jsonObject(with: Self.body(request))) as? [String: Any])?["profileId"] as? String
            return json(["telegram": telegram()])
        case ("GET", "/v1/mobile"):
            guard flags["colleagueInvitesVersion"] == 1 else {
                return json(["connections": 1, "clients": [["id": "legacy", "name": "Устройство 1", "owner": true]]])
            }
            let clients: [[String: Any]] = [
                ["id": "owner-phone", "label": "iPhone", "role": "owner", "pairedAt": "2026-10-14T10:00:00.000Z", "current": true],
                ["id": "colleague", "label": "Коллега", "role": "colleague", "pairedAt": "2026-10-14T11:00:00Z", "current": false],
            ].filter { !revokedClients.contains($0["id"] as! String) }
            // A Home before day-long owner links lists only colleague links, without a role.
            let listed = flags["ownerInvitesVersion"] == 1 ? invitations : invitations.filter { !$0.owner }
            return json(["connections": clients.count, "clients": clients, "invitations": listed.map { invitation -> [String: Any] in
                var item: [String: Any] = ["id": invitation.id, "label": NSNull(), "expiresAt": "2026-10-15T20:00:00.000Z"]
                if flags["ownerInvitesVersion"] == 1 { item["role"] = invitation.owner ? "owner" : "colleague" }
                return item
            }])
        case ("POST", "/v1/mobile/pairing"):
            issuedInvitations += 1
            let id = String(format: "%020d", issuedInvitations)
            let owner = ((try? JSONSerialization.jsonObject(with: Self.body(request))) as? [String: Any])?["owner"] as? Bool == true
            // A new owner link replaces the previous one.
            invitations.removeAll { owner && $0.owner }; invitations.append((id, owner))
            return json(["id": id, "url": "openstrudel://connect?host=fixture.local", "expiresAt": "2026-10-15T20:00:00Z"])
        case ("DELETE", "/v1/mobile/pairing"): cancelledInvitations += 1; invitations.removeAll { $0.owner }; return json(["ok": true])
        case ("DELETE", _) where path.hasPrefix("/v1/mobile/pairing/"):
            let id = String(path.dropFirst("/v1/mobile/pairing/".count))
            cancelledInvitationIDs.append(id); invitations.removeAll { $0.id == id }
            return json(["ok": true])
        case ("PATCH", "/v1/home"):
            let name = ((try? JSONSerialization.jsonObject(with: Self.body(request))) as? [String: Any])?["name"] as? String ?? ""
            homeRenames.append(name); deviceName = name
            return json(["home": ["id": "home-fixture", "nodeId": "node", "primaryId": "node", "role": "primary", "name": name, "epoch": 1], "devices": []])
        case ("DELETE", _) where path.hasPrefix("/v1/mobile/clients/"):
            revokedClients.append(String(path.dropFirst("/v1/mobile/clients/".count))); return json(["ok": true])
        default:
            return json(["conversation": ["id": "conversation", "channel": "api", "createdAt": "2026-10-09", "updatedAt": "2026-10-09"], "messages": [], "interactions": []])
        }
    }
    private static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class DevicesProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (URLRequest) async -> (Int, Data))?
    private var operation: Task<Void, Never>?
    static func setHandler(_ value: @escaping @Sendable (URLRequest) async -> (Int, Data)) { lock.lock(); defer { lock.unlock() }; handler = value }
    private static func getHandler() -> (@Sendable (URLRequest) async -> (Int, Data))? { lock.lock(); defer { lock.unlock() }; return handler }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        operation = Task { @Sendable [self] in
            guard let handler = Self.getHandler(), let url = request.url else { return }
            let (status, data) = await handler(request)
            guard !Task.isCancelled else { return }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { operation?.cancel() }
}
