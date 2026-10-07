import Foundation
import Security
import Testing

@Suite(.serialized)
struct LocalDataResetTests {
    private func sandbox() throws -> LocalDataReset {
        let home = FileManager.default.temporaryDirectory.appending(path: "openstrudel-reset-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        return LocalDataReset(home: home, bundleID: "is.openstrudel.reset-test." + UUID().uuidString)
    }
    private func write(_ path: URL, _ value: String = "private test data") throws {
        try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(value.utf8).write(to: path)
    }

    @Test func completeResetDeletesOnlyThisInstallAndCanRunTwice() throws {
        let reset = try sandbox(), fm = FileManager.default
        defer { try? fm.removeItem(at: reset.home) }
        let agent = reset.runtime.appending(path: ".data/agents/local/chat.json")
        let auth = reset.runtime.appending(path: ".data/codex/auth.json")
        let remote = reset.home.appending(path: "independent-server/agents/remote/chat.json")
        let codex = reset.home.appending(path: ".codex/auth.json")
        let signingKey = reset.home.appending(path: ".openstrudel/sparkle-key")
        let backup = reset.home.appending(path: "Documents/backup.openstrudel")
        for file in [agent, auth, remote, codex, signingKey, backup] { try write(file) }
        try write(reset.home.appending(path: ".config/openstrudel/connection.json"))
        // A symlink *inside* app data is removed without following its target.
        try fm.createSymbolicLink(at: reset.runtime.appending(path: "external"), withDestinationURL: remote.deletingLastPathComponent())
        try reset.begin()
        #expect(reset.pending)
        try reset.eraseFiles(stop: {})
        try reset.finish()
        #expect(!reset.pending)
        #expect(!fm.fileExists(atPath: agent.path))
        #expect(!fm.fileExists(atPath: auth.path))
        #expect(!fm.fileExists(atPath: reset.home.appending(path: ".config/openstrudel").path))
        for file in [remote, codex, signingKey, backup] { #expect(try String(contentsOf: file, encoding: .utf8) == "private test data") }
        try reset.begin(); try reset.eraseFiles(stop: {}); try reset.finish()
    }

    @Test func failureToStopLeavesAllEmployeesAndCredentialsIntact() throws {
        let reset = try sandbox(), fm = FileManager.default
        defer { try? fm.removeItem(at: reset.home) }
        let file = reset.runtime.appending(path: ".data/private")
        try write(file); try reset.begin()
        #expect(throws: LocalDataReset.Failure.self) {
            try reset.eraseFiles(stop: { throw LocalDataReset.Failure.cannotStop })
        }
        #expect(fm.fileExists(atPath: file.path))
        #expect(reset.pending)
    }

    @Test func refusesRelocatedDataBeforeCreatingTheEraseMarker() throws {
        let reset = try sandbox(), fm = FileManager.default
        defer { try? fm.removeItem(at: reset.home) }
        let elsewhere = reset.home.appending(path: "other-app")
        try write(elsewhere.appending(path: "data"))
        let managed = reset.runtime.deletingLastPathComponent()
        try fm.createDirectory(at: managed.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: managed, withDestinationURL: elsewhere)
        #expect(throws: LocalDataReset.Failure.self) { try reset.begin() }
        #expect(!reset.pending)
        #expect(fm.fileExists(atPath: elsewhere.appending(path: "data").path))
    }

    @Test func refusesAServiceConfiguredToRunAnotherDatabase() throws {
        let reset = try sandbox()
        defer { try? FileManager.default.removeItem(at: reset.home) }
        let plist: [String: Any] = ["Label": "is.openstrudel.home", "WorkingDirectory": reset.runtime.path,
                                    "EnvironmentVariables": ["OPENSTRUDEL_DB": "/another/database"]]
        try FileManager.default.createDirectory(at: reset.launchAgent.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: reset.launchAgent)
        #expect(throws: LocalDataReset.Failure.self) { try reset.begin() }
        #expect(!reset.pending)
    }

    @Test @MainActor func erasesPreferencesAndOnlyAppScopedCredentials() throws {
        let reset = try sandbox()
        defer { try? FileManager.default.removeItem(at: reset.home) }
        let defaults = try #require(UserDefaults(suiteName: reset.bundleID))
        let remoteName = reset.bundleID + ".device.remote"
        let remote = try #require(UserDefaults(suiteName: remoteName))
        defaults.set(true, forKey: "openstrudel.aiConsent")
        remote.set("https://remote.invalid", forKey: "openstrudel.homeURL")
        let service = reset.bundleID + ".credentials"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "test"]
        #expect(SecItemAdd(query.merging([kSecValueData as String: Data("test".utf8)]) { _, new in new } as CFDictionary, nil) == errSecSuccess)
        defer { SecItemDelete(query as CFDictionary); defaults.removePersistentDomain(forName: reset.bundleID); remote.removePersistentDomain(forName: remoteName) }
        try reset.eraseCredentials()
        try reset.erasePreferences(connectionIDs: ["remote"])
        #expect(SecItemCopyMatching(query as CFDictionary, nil) == errSecItemNotFound)
        #expect(defaults.object(forKey: "openstrudel.aiConsent") == nil)
        #expect(remote.object(forKey: "openstrudel.homeURL") == nil)
        let fresh = HomeClient(defaults: defaults, pendingDirectory: reset.home.appending(path: "Pending"), connectionID: reset.bundleID)
        #expect(!fresh.hasToken)
        #expect(!fresh.shouldRestoreConnection)
        #expect(fresh.profiles.isEmpty)
        #expect(!fresh.isSignedOut)
    }

    @Test @MainActor func aSuspendedClientCannotReinstallCloudCredentials() async throws {
        let reset = try sandbox()
        defer { try? FileManager.default.removeItem(at: reset.home) }
        let defaults = try #require(UserDefaults(suiteName: reset.bundleID))
        defer { defaults.removePersistentDomain(forName: reset.bundleID) }
        let client = HomeClient(defaults: defaults, pendingDirectory: reset.home.appending(path: "Pending"), connectionID: reset.bundleID)
        client.suspendForLocalErase()
        let connection = HomeConnection(url: "https://remote.invalid:7789", token: String(repeating: "a", count: 64), pin: String(repeating: "b", count: 64), name: "Remote")
        #expect(await client.connectToCloud(connection) == false)
        #expect(!client.hasToken)
        #expect(defaults.object(forKey: "openstrudel.homeURL") == nil)
    }
}
