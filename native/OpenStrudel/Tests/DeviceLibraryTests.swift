import Foundation
import Testing

@Suite(.serialized)
@MainActor struct DeviceLibraryTests {
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
        library.beginEmployee()
        #expect(library.active === remote)
        #expect(remote.isEmployeeDraft)
        #expect(!local.isEmployeeDraft)
        #expect(!remote.canManageOpenAI)
        #expect(library.employeeDestinations.count == 2)
        #expect(library.employeeDestinations.allSatisfy { $0.available })
        library.beginEmployee(on: local)
        #expect(library.active === local)
        #expect(local.isEmployeeDraft)
    }

    @Test func choosingTheExecutionDevicePreservesTheUnsentCreationPrompt() throws {
        let name = "OpenStrudel.draft-device-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("http://127.0.0.1:57102", forKey: "openstrudel.homeURL")
        let local = HomeClient(defaults: defaults, connectionID: name + "-local")
        let remote = HomeClient(defaults: defaults, connectionID: name + "-remote")
        remote.baseURLString = "https://remote.example"
        let library = DeviceLibrary(defaults: defaults, clients: [local, remote])
        library.beginEmployee(on: local)
        let appearance = local.draftAppearance
        let old = HomeDrafts.key(home: local.baseURLString, profile: local.selectedProfileID, chat: nil)
        library.saveDraft("Редактор моих текстов", for: old)
        let file = PickedFile(name: "Задача.txt", mimeType: "text/plain", data: Data("Сохрани смысл".utf8))
        library.fileDrafts[old] = [file]
        library.chooseEmployeeDevice(remote)
        let new = HomeDrafts.key(home: remote.baseURLString, profile: remote.selectedProfileID, chat: nil)
        #expect(library.active === remote)
        #expect((defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String])?[new] == "Редактор моих текстов")
        #expect(!local.isEmployeeDraft)
        #expect(remote.draftAppearance == appearance)
        #expect(library.fileDrafts[new] == [file])
        #expect(library.fileDrafts[old] == nil)
        #expect((defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String])?[old] == nil)
        // A different conversation saving after the move must not replace the
        // destination draft with an older copy of the entire draft dictionary.
        library.saveDraft("Другой разговор", for: "unrelated")
        #expect(library.draft(for: new) == "Редактор моих текстов")
        let draftID = remote.selectedProfileID
        library.chooseEmployeeDevice(remote, deviceID: "server")
        #expect(remote.selectedProfileID == draftID)
        #expect(remote.draftDeviceID == "server")
    }

    @Test func signedOutConnectionCannotReceiveANewDraftOrSilentlyCreateLocally() async throws {
        let name = "OpenStrudel.revoked-creation-test." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set("http://127.0.0.1:57105", forKey: "openstrudel.homeURL")
        let local = HomeClient(defaults: defaults, connectionID: name + "-local")
        let remote = HomeClient(defaults: defaults, connectionID: name + "-remote")
        remote.baseURLString = "https://remote.example"
        let library = DeviceLibrary(defaults: defaults, clients: [local, remote])
        library.beginEmployee(on: local)
        let draftID = local.selectedProfileID
        await remote.signOutOnThisDevice()
        #expect(!library.employeeDestinations.contains { $0.client === remote })
        library.chooseEmployeeDevice(remote)
        #expect(library.active === local)
        #expect(local.selectedProfileID == draftID)
        library.select(remote)
        library.beginEmployee()
        #expect(library.active === remote)
        #expect(!remote.isEmployeeDraft)
        #expect(local.selectedProfileID == draftID)
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
