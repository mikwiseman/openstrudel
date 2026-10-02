import Foundation
import CryptoKit
import Security
import Testing

@Suite(.serialized)
struct DigitalOceanCloudTests {
    @Test func pkceMatchesTheRFC7636Example() {
        #expect(DigitalOceanOAuth.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func callbackRequiresExactDestinationAndSingleMatchingState() throws {
        let valid = try #require(URL(string: "openstrudel://oauth/digitalocean?code=the-code&state=expected"))
        #expect(try DigitalOceanOAuth.code(from: valid, state: "expected") == "the-code")
        for value in [
            "openstrudel://oauth/digitalocean?code=the-code&state=wrong",
            "openstrudel://oauth/digitalocean?code=the-code&state=expected&state=expected",
            "openstrudel://oauth/digitalocean?code=one&code=two&state=expected",
            "https://oauth/digitalocean?code=the-code&state=expected",
            "openstrudel://oauth.evil/digitalocean?code=the-code&state=expected",
            "openstrudel://user@oauth/digitalocean?code=the-code&state=expected",
            "openstrudel://oauth:443/digitalocean?code=the-code&state=expected",
            "openstrudel://oauth/digitalocean/?code=the-code&state=expected",
            "openstrudel://oauth/digitalocean?code=the-code&state=expected#fragment"
        ] {
            #expect(throws: (any Error).self) {
                try DigitalOceanOAuth.code(from: #require(URL(string: value)), state: "expected")
            }
        }
    }

    @Test func quoteUsesOnlyAvailableBasicPlanAndVerifiedRelease() throws {
        let size = DigitalOceanSize(slug: "s-2vcpu-4gb", memory: 4096, vcpus: 2, disk: 80,
                                    priceMonthly: 24, priceHourly: 0.035714, regions: ["fra1", "ams3"], available: true)
        let regions = [DigitalOceanRegion(slug: "fra1", available: true), DigitalOceanRegion(slug: "ams3", available: true)]
        let quote = try DigitalOceanQuote.make(sizes: [size], regions: regions, releaseSHA256: String(repeating: "a", count: 64))
        #expect(quote.monthlyPrice == 24)
        #expect(quote.region == "fra1")
        #expect(quote.size == "s-2vcpu-4gb")
        #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [], regions: regions, releaseSHA256: quote.releaseSHA256) }
        #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [size], regions: regions, releaseSHA256: "bad") }
        var unavailable = size
        unavailable.available = false
        #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [unavailable], regions: regions, releaseSHA256: quote.releaseSHA256) }
        for price in [0.0, -1.0, Double.infinity, Double.nan] {
            var invalid = size; invalid.priceMonthly = price
            #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [invalid], regions: regions, releaseSHA256: quote.releaseSHA256) }
        }
        #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [size], regions: [], releaseSHA256: quote.releaseSHA256) }
    }

    @Test func checksumMustIdentifyOneExactHomeArchive() throws {
        let hash = String(repeating: "a", count: 64)
        #expect(try DigitalOceanQuote.releaseHash(from: "\(hash)  OpenStrudel-Home-1.0.tar.gz\n") == hash)
        for input in ["\(hash)  Another.tar.gz", "bad  OpenStrudel-Home-1.0.tar.gz", "\(hash)  ../OpenStrudel-Home-1.0.tar.gz", "\(hash)  OpenStrudel-Home-1.0.tar.gz\n\(hash)  OpenStrudel-Home-1.0.tar.gz"] {
            #expect(throws: (any Error).self) { try DigitalOceanQuote.releaseHash(from: input) }
        }
    }

    @Test func initialTLSRequiresKnownKeyAndExactPublicEndpoint() throws {
        let privateKey = P256.Signing.PrivateKey()
        let publicKey = privateKey.publicKey.x963Representation
        #expect(DigitalOceanHomeTrust.matches(actualKey: publicKey, expectedKey: publicKey, host: "203.0.113.25", expectedHost: "203.0.113.25", port: 7789))
        #expect(!DigitalOceanHomeTrust.matches(actualKey: P256.Signing.PrivateKey().publicKey.x963Representation, expectedKey: publicKey, host: "203.0.113.25", expectedHost: "203.0.113.25", port: 7789))
        #expect(!DigitalOceanHomeTrust.matches(actualKey: publicKey, expectedKey: publicKey, host: "other.example", expectedHost: "203.0.113.25", port: 7789))
        #expect(!DigitalOceanHomeTrust.matches(actualKey: publicKey, expectedKey: publicKey, host: "203.0.113.25", expectedHost: "203.0.113.25", port: 443))
        for address in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.5", "172.16.1.5", "224.0.0.1", "1.2.3.999", "1.2.3.4.evil"] {
            #expect(!DigitalOceanHomeTrust.isPublicIPv4(address))
        }
        #expect(DigitalOceanHomeTrust.isPublicIPv4("8.8.8.8"))
    }

    @Test func providerAndHomeSessionsRefuseAllRedirects() async throws {
        let source = try #require(URL(string: "https://api.digitalocean.com/v2/droplets"))
        let destination = try #require(URL(string: "https://another.example/steal"))
        let response = try #require(HTTPURLResponse(url: source, statusCode: 307, httpVersion: nil, headerFields: ["Location": destination.absoluteString]))
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: source)
        let providerRequest: URLRequest? = await withCheckedContinuation { continuation in
            DigitalOceanNoRedirects().urlSession(session, task: task, willPerformHTTPRedirection: response,
                newRequest: URLRequest(url: destination)) { continuation.resume(returning: $0) }
        }
        let homeRequest: URLRequest? = await withCheckedContinuation { continuation in
            DigitalOceanHomeTrust(host: "8.8.8.8", publicKey: P256.Signing.PrivateKey().publicKey.x963Representation)
                .urlSession(session, task: task, willPerformHTTPRedirection: response,
                    newRequest: URLRequest(url: destination)) { continuation.resume(returning: $0) }
        }
        #expect(providerRequest == nil)
        #expect(homeRequest == nil)
    }

    @MainActor @Test func managementLinkOnlyMatchesTheSavedCloudConnection() throws {
        let store = DigitalOceanMemoryStore()
        var state = try initialState()
        state.installation = .init(id: UUID().uuidString.lowercased(), accountID: "account:account-1",
            privateKeyPEM: P256.Signing.PrivateKey().pemRepresentation, ownerToken: String(repeating: "a", count: 64),
            quote: .init(monthlyPrice: 24, hourlyPrice: 0.035714, region: "fra1", size: "s-2vcpu-4gb", releaseSHA256: String(repeating: "b", count: 64)),
            createAttemptedAt: Date(), dropletID: 12345,
            connection: .init(url: "https://8.8.8.8:7789", token: "owner", pin: String(repeating: "c", count: 64), name: "Моя команда"))
        try store.save(JSONEncoder().encode(state))
        #expect(DigitalOceanCloud.managementURL(for: "https://8.8.8.8:7789", store: store)?.absoluteString == "https://cloud.digitalocean.com/droplets/12345")
        #expect(DigitalOceanCloud.managementURL(for: "https://other.example:7789", store: store) == nil)
        #expect(DigitalOceanCloud.managementURL(for: "http://8.8.8.8:7789", store: store) == nil)
    }

    @MainActor @Test func freshSetupDoesNotMakeAnyRequestsAndExpiredLoginReturnsToSignIn() async throws {
        let store = DigitalOceanMemoryStore()
        let observations = DigitalOceanObservations()
        let session = mockSession { request in
            await MainActor.run { observations.requests += 1 }
            #expect(request.url?.path == "/v1/oauth/token")
            return (400, Data(#"{"error":"invalid_grant"}"#.utf8))
        }
        let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await cloud.resume()
        #expect(cloud.phase == .idle)
        #expect(observations.requests == 0)
        var expired = try initialState()
        expired.tokens = .init(accessToken: "expired", refreshToken: "old", expiresAt: .distantPast)
        try store.save(JSONEncoder().encode(expired))
        await cloud.resume()
        #expect(cloud.phase == .idle)
        #expect(observations.requests == 1)
        await cloud.resume()
        #expect(observations.requests == 1)
        #expect(try JSONDecoder().decode(DigitalOceanSavedState.self, from: #require(store.data)).tokens == nil)
    }

    @MainActor @Test func creationPersistsCredentialsBeforePOSTAndNeverRepeatsAnUnknownOutcome() async throws {
        let store = DigitalOceanMemoryStore()
        try store.save(JSONEncoder().encode(try initialState()))
        let observations = DigitalOceanObservations()
        let session = mockSession { request in
            if request.httpMethod == "POST", request.url?.path == "/v2/droplets" {
                try await MainActor.run {
                    let state = try JSONDecoder().decode(DigitalOceanSavedState.self, from: #require(store.data))
                    let installation = try #require(state.installation)
                    #expect(installation.createAttemptedAt != nil)
                    #expect(!installation.privateKeyPEM.isEmpty)
                    #expect(installation.ownerToken.count == 64)
                    #expect(UUID(uuidString: installation.id) != nil)
                    observations.creates += 1
                }
                throw URLError(.timedOut)
            }
            return try Self.mockResponse(request)
        }
        let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await cloud.resume()
        #expect(cloud.phase == .readyToCreate)
        await cloud.confirmCreate()
        #expect(observations.creates == 1)
        #expect(cloud.phase == .failed)
        // Relaunch and a much later retry are both read-only after an uncertain POST.
        let relaunched = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await relaunched.resume()
        await relaunched.confirmCreate()
        #expect(observations.creates == 1)
        #expect(try JSONDecoder().decode(DigitalOceanSavedState.self, from: #require(store.data)).installation?.createAttemptedAt != nil)
    }

    @MainActor @Test func storageFailurePreventsAnyPaidRequest() async throws {
        let store = DigitalOceanMemoryStore()
        try store.save(JSONEncoder().encode(try initialState()))
        let observations = DigitalOceanObservations()
        let session = mockSession { request in
            if request.httpMethod == "POST", request.url?.path == "/v2/droplets" {
                await MainActor.run { observations.creates += 1 }
            }
            return try Self.mockResponse(request)
        }
        let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await cloud.resume()
        #expect(cloud.phase == .readyToCreate)
        store.refuseWrites = true
        await cloud.confirmCreate()
        #expect(observations.creates == 0)
        #expect(cloud.phase == .failed)
    }

    @MainActor @Test func changedPriceRequiresFreshConfirmation() async throws {
        let store = DigitalOceanMemoryStore()
        try store.save(JSONEncoder().encode(try initialState()))
        let observations = DigitalOceanObservations()
        let session = mockSession { request in
            if request.httpMethod == "POST" { await MainActor.run { observations.creates += 1 } }
            let price = await MainActor.run { observations.newPrice }
            return try Self.mockResponse(request, price: price)
        }
        let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await cloud.resume()
        #expect(cloud.quote?.monthlyPrice == 24)
        observations.newPrice = 30
        await cloud.confirmCreate()
        #expect(cloud.phase == .readyToCreate)
        #expect(cloud.quote?.monthlyPrice == 30)
        #expect(observations.creates == 0)
    }

    @MainActor @Test func ownerTokenNeverGoesToProviderOrCloudInit() async throws {
        let store = DigitalOceanMemoryStore()
        try store.save(JSONEncoder().encode(try initialState()))
        let observations = DigitalOceanObservations()
        let session = mockSession { request in
            if request.httpMethod == "POST", request.url?.path == "/v2/droplets" {
                await MainActor.run { observations.creates += 1 }
                let state = try await MainActor.run { try JSONDecoder().decode(DigitalOceanSavedState.self, from: #require(store.data)) }
                let installation = try #require(state.installation)
                let body = try Self.body(request)
                let text = String(decoding: body, as: UTF8.self)
                #expect(!text.contains(installation.ownerToken))
                #expect(!text.contains("provider-access-token"))
                let payload = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
                let userData = try #require(payload["user_data"] as? String)
                let encoded = try #require(userData.components(separatedBy: "\n")
                    .first(where: { $0.contains("content: ") })?.components(separatedBy: "content: ").last)
                let bootstrap = try #require(Data(base64Encoded: encoded))
                let secrets = try #require(JSONSerialization.jsonObject(with: bootstrap) as? [String: String])
                #expect(secrets["ownerTokenHash"] == SHA256.hash(data: Data(installation.ownerToken.utf8)).map { String(format: "%02x", $0) }.joined())
                #expect(!String(decoding: bootstrap, as: UTF8.self).contains(installation.ownerToken))
                #expect(!String(decoding: bootstrap, as: UTF8.self).contains("provider-access-token"))
                #expect(payload["backups"] as? Bool == false)
                #expect(payload["monitoring"] as? Bool == false)
                #expect(payload["ssh_keys"] == nil)
                #expect(payload["volumes"] == nil)
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer provider-access-token")
                throw URLError(.timedOut)
            }
            return try Self.mockResponse(request)
        }
        let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await cloud.resume()
        #expect(cloud.phase == .readyToCreate)
        await cloud.confirmCreate()
        #expect(observations.creates == 1)
        #expect(cloud.phase == .failed)
    }

    @MainActor private func initialState() throws -> DigitalOceanSavedState {
        var state = DigitalOceanSavedState()
        state.registration = .init(clientID: "client", registrationAccessToken: "registration", registrationClientURI: "https://cloud.digitalocean.com/v1/oauth/register/client")
        state.tokens = .init(accessToken: "provider-access-token", refreshToken: "refresh", expiresAt: Date().addingTimeInterval(3600))
        return state
    }

    private func mockSession(_ handler: @escaping @Sendable (URLRequest) async throws -> (Int, Data)) -> URLSession {
        DigitalOceanTestURLProtocol.setHandler(handler)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DigitalOceanTestURLProtocol.self]
        return URLSession(configuration: config)
    }

    private static func body(_ request: URLRequest) throws -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { throw URLError(.badServerResponse) }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
        return data
    }

    private static func mockResponse(_ request: URLRequest, price: Double = 24) throws -> (Int, Data) {
        let json: String
        switch request.url?.path {
        case "/v2/account": json = #"{"account":{"uuid":"account-1","email_verified":true,"status":"active","droplet_limit":25}}"#
        case "/v2/sizes": json = "{\"sizes\":[{\"slug\":\"s-2vcpu-4gb\",\"memory\":4096,\"vcpus\":2,\"disk\":80,\"price_monthly\":\(price),\"price_hourly\":0.035714,\"regions\":[\"fra1\"],\"available\":true}]}"
        case "/v2/regions": json = #"{"regions":[{"slug":"fra1","available":true}]}"#
        case "/openstrudel/downloads/SHA256SUMS": return (200, Data((String(repeating: "a", count: 64) + "  OpenStrudel-Home-1.0.tar.gz\n").utf8))
        case "/v2/droplets": json = #"{"droplets":[]}"#
        default: throw URLError(.unsupportedURL)
        }
        return (200, Data(json.utf8))
    }
}

@MainActor private final class DigitalOceanMemoryStore: DigitalOceanCredentialStore {
    var data: Data?
    var refuseWrites = false
    func load() throws -> Data? { data }
    func save(_ data: Data) throws { if refuseWrites { throw URLError(.cannotWriteToFile) }; self.data = data }
}

@MainActor private final class DigitalOceanObservations {
    var creates = 0
    var requests = 0
    var newPrice = 24.0
}

private final class DigitalOceanTestURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var handler: (@Sendable (URLRequest) async throws -> (Int, Data))?
    private var operation: Task<Void, Never>?
    static func setHandler(_ handler: @escaping @Sendable (URLRequest) async throws -> (Int, Data)) {
        lock.lock(); defer { lock.unlock() }; self.handler = handler
    }
    private static func currentHandler() -> (@Sendable (URLRequest) async throws -> (Int, Data))? {
        lock.lock(); defer { lock.unlock() }; return handler
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        operation = Task {
            do {
                let handler = try #require(Self.currentHandler())
                let (status, data) = try await handler(request)
                try Task.checkCancellation()
                let url = try #require(request.url)
                let response = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"]))
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: data)
                client?.urlProtocolDidFinishLoading(self)
            } catch { client?.urlProtocol(self, didFailWithError: error) }
        }
    }
    override func stopLoading() { operation?.cancel() }
}
