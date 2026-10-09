import Foundation
import Combine
import Testing

@Suite(.serialized)
@MainActor struct CatalogueTests {
    @Test func unchangedCatalogueDoesNotPublishAndADeletionOnTheHostClearsTheSelection() async throws {
        let fixture = CatalogueFixture()
        let (client, session, defaults, suite) = makeClient(fixture)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        await client.load()
        await client.selectProfile("employee")
        var changes = 0
        let observation = client.objectWillChange.sink { changes += 1 }
        await client.refreshCatalogue()
        #expect(fixture.requests.last?.value(forHTTPHeaderField: "If-None-Match") == "\"v1\"")
        #expect(changes == 0)
        fixture.deleted = true
        await client.refreshCatalogue()
        #expect(client.profiles.isEmpty)
        #expect(client.selectedProfileID == nil)
        #expect(client.messages.isEmpty)
        #expect(!client.homeUnreachable)
        let reopened = HomeClient(defaults: defaults, session: session, connectionID: suite)
        #expect(reopened.profiles.isEmpty)
        observation.cancel()
    }

    @Test func catalogueDoesNotWaitForSlowProviderLoading() async throws {
        let fixture = CatalogueFixture()
        fixture.accountDelay = .milliseconds(600)
        let (client, session, defaults, suite) = makeClient(fixture)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        let load = Task { await client.load() }
        for _ in 0..<100 where !fixture.requests.contains(where: { $0.url?.path == "/v1/account" }) { try await Task.sleep(for: .milliseconds(5)) }
        #expect(client.isLoading)
        #expect(client.profiles.count == 1)
        fixture.deleted = true
        await client.refreshCatalogue()
        #expect(client.isLoading)
        #expect(client.profiles.isEmpty)
        await load.value
        #expect(client.profiles.isEmpty)
    }

    @Test func publicHealthDoesNotMaskARevokedCatalogueCredential() async throws {
        let fixture = CatalogueFixture()
        let (client, session, defaults, suite) = makeClient(fixture)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        await client.load()
        fixture.catalogueStatus = 401
        await client.load(quiet: true)
        #expect(client.homeUnreachable)
        #expect(client.connectionNeedsPairing)
        #expect(client.health == nil)
        #expect(client.profiles.count == 1)
        fixture.catalogueStatus = nil
        await client.load(quiet: true)
        #expect(!client.homeUnreachable)
        #expect(!client.connectionNeedsPairing)
    }

    @Test func staleRefreshCannotResurrectALocalDeletion() async throws {
        let fixture = CatalogueFixture()
        let (client, session, defaults, suite) = makeClient(fixture)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        await client.load()
        fixture.ignoreETag = true; fixture.catalogueDelay = .milliseconds(150)
        let count = fixture.requests.count
        let oldRefresh = Task { await client.refreshCatalogue() }
        for _ in 0..<100 where fixture.requests.count == count { try await Task.sleep(for: .milliseconds(2)) }
        try await client.deleteProfile("employee")
        await oldRefresh.value
        #expect(client.profiles.isEmpty)
        fixture.catalogueDelay = nil
        await client.refreshCatalogue()
        #expect(fixture.requests.last?.value(forHTTPHeaderField: "If-None-Match") == nil)
        #expect(client.profiles.isEmpty)
    }

    @Test func hidingIsClientLocalReversibleAndSurvivesRelaunch() async throws {
        let fixture = CatalogueFixture()
        let (client, session, defaults, suite) = makeClient(fixture)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        await client.load()
        let profile = try #require(client.profiles.first)
        let library = DeviceLibrary(defaults: defaults, clients: [client])
        let otherSuite = suite + ".other"
        let otherDefaults = try #require(UserDefaults(suiteName: otherSuite))
        defer { otherDefaults.removePersistentDomain(forName: otherSuite) }
        let other = DeviceLibrary(defaults: otherDefaults, clients: [client])
        await library.setHidden(true, profile: profile, on: client)
        #expect(library.visibleProfiles(on: client).isEmpty)
        #expect(other.visibleProfiles(on: client).count == 1)
        #expect(client.profiles.count == 1)
        let reopened = DeviceLibrary(defaults: defaults, clients: [client])
        #expect(reopened.hiddenProfiles(on: client).count == 1)
        await reopened.setHidden(false, profile: profile, on: client)
        #expect(reopened.visibleProfiles(on: client).count == 1)
        #expect(fixture.requests.allSatisfy { $0.httpMethod == "GET" })
    }

    @Test func hidingDoesNotMixIdenticalEmployeeIDsOnDifferentHosts() async throws {
        let fixture = CatalogueFixture()
        let (first, session, defaults, suite) = makeClient(fixture)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        await first.load()
        let otherSuite = suite + ".host"
        let otherDefaults = try #require(UserDefaults(suiteName: otherSuite))
        defer { otherDefaults.removePersistentDomain(forName: otherSuite) }
        otherDefaults.set("http://127.0.0.1:57578", forKey: "openstrudel.homeURL")
        otherDefaults.set("another-home", forKey: "openstrudel.catalogueIdentity")
        otherDefaults.set(try JSONEncoder().encode(first.profiles), forKey: "openstrudel.employeeCatalog")
        let other = HomeClient(defaults: otherDefaults, session: session, connectionID: otherSuite)
        let library = DeviceLibrary(defaults: defaults, clients: [first, other])
        let profile = try #require(first.profiles.first)
        await library.setHidden(true, profile: profile, on: first)
        #expect(library.isHidden(profile, on: first))
        #expect(!library.isHidden(profile, on: other))
        #expect(library.visibleProfiles(on: other).count == 1)
    }

    @Test func removingAnOfflineConnectionPersistsAndSelectsTheRemainingDevice() async throws {
        let fixture = CatalogueFixture()
        let (first, session, defaults, suite) = makeClient(fixture)
        defer { session.invalidateAndCancel(); defaults.removePersistentDomain(forName: suite) }
        let remoteSuite = suite + ".remote"
        let remoteDefaults = try #require(UserDefaults(suiteName: remoteSuite))
        defer { remoteDefaults.removePersistentDomain(forName: remoteSuite) }
        remoteDefaults.set("http://127.0.0.1:57577", forKey: "openstrudel.homeURL")
        let remote = HomeClient(defaults: remoteDefaults, session: session, connectionID: remoteSuite)
        let library = DeviceLibrary(defaults: defaults, clients: [first, remote])
        library.select(remote)
        await library.removeConnection(remote)
        #expect(library.clients.count == 1)
        #expect(library.active === first)
        #expect(defaults.stringArray(forKey: "openstrudel.deviceConnections") == [first.id])
        #expect(remote.isSignedOut)
        #expect(!first.isSignedOut)
        #expect(fixture.requests.isEmpty)
        await library.removeConnection(first)
        #expect(library.clients.count == 1)
        #expect(!library.active.shouldRestoreConnection)
        #expect(library.visibleClients.isEmpty)
    }

    private func makeClient(_ fixture: CatalogueFixture) -> (HomeClient, URLSession, UserDefaults, String) {
        let suite = "OpenStrudel.catalogue-test." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set("http://127.0.0.1:57577", forKey: "openstrudel.homeURL")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CatalogueProtocol.self]
        CatalogueProtocol.setHandler { request in await fixture.respond(request) }
        let session = URLSession(configuration: config)
        return (HomeClient(defaults: defaults, session: session, connectionID: suite), session, defaults, suite)
    }
}

@MainActor private final class CatalogueFixture {
    var requests: [URLRequest] = []
    var deleted = false
    var ignoreETag = false
    var accountDelay: Duration?
    var catalogueDelay: Duration?
    var catalogueStatus: Int?
    func respond(_ request: URLRequest) async -> (Int, Data, [String: String]) {
        requests.append(request)
        let path = request.url!.path
        if request.httpMethod == "DELETE" { deleted = true; return (200, Data(#"{"ok":true}"#.utf8), [:]) }
        if path == "/v1/profiles" {
            if let catalogueStatus { return (catalogueStatus, Data(#"{"error":"revoked"}"#.utf8), [:]) }
            let etag = deleted ? "\"v2\"" : "\"v1\""
            let body = deleted ? #"{"profiles":[]}"# : #"{"profiles":[{"id":"employee","name":"Тест","instructions":"","capabilities":[],"createdAt":"2026-10-09T00:00:00Z"}]}"#
            if let catalogueDelay { try? await Task.sleep(for: catalogueDelay) }
            if !ignoreETag && request.value(forHTTPHeaderField: "If-None-Match") == etag { return (304, Data(), ["ETag": etag]) }
            return (200, Data(body.utf8), ["ETag": etag])
        }
        if path == "/v1/account", let accountDelay { try? await Task.sleep(for: accountDelay) }
        let body: String
        switch path {
        case "/health": body = #"{"ok":true,"homeId":"home-fixture"}"#
        case "/v1/account": body = #"{"account":{"connected":true,"managed":true},"canManage":true}"#
        case "/v1/integrations": body = #"{"telegram":{"configured":false,"running":false,"linkedChats":[]}}"#
        default: body = #"{"conversation":{"id":"conversation","channel":"api","createdAt":"2026-10-09","updatedAt":"2026-10-09"},"messages":[],"interactions":[]}"#
        }
        return (200, Data(body.utf8), [:])
    }
}

private final class CatalogueProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (URLRequest) async -> (Int, Data, [String: String]))?
    private var operation: Task<Void, Never>?
    static func setHandler(_ value: @escaping @Sendable (URLRequest) async -> (Int, Data, [String: String])) { lock.lock(); defer { lock.unlock() }; handler = value }
    private static func getHandler() -> (@Sendable (URLRequest) async -> (Int, Data, [String: String]))? { lock.lock(); defer { lock.unlock() }; return handler }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        operation = Task { @Sendable [self] in
            guard let handler = Self.getHandler(), let url = request.url else { return }
            let (status, data, headers) = await handler(request)
            guard !Task.isCancelled else { return }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() { operation?.cancel() }
}
