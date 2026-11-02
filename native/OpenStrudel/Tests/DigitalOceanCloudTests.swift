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
        let file = "OpenStrudel-Home-1.0-59.tar.gz"
        let quote = try DigitalOceanQuote.make(sizes: [size], regions: regions, releaseSHA256: String(repeating: "a", count: 64), releaseFile: file)
        #expect(quote.monthlyPrice == 24)
        #expect(quote.region == "fra1")
        #expect(quote.size == "s-2vcpu-4gb")
        #expect(quote.releaseFile == file)
        #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [], regions: regions, releaseSHA256: quote.releaseSHA256, releaseFile: file) }
        #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [size], regions: regions, releaseSHA256: "bad", releaseFile: file) }
        for name in ["../" + file, "OpenStrudel-Home-1.0.tar.gz", file + "\n"] {
            #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [size], regions: regions, releaseSHA256: quote.releaseSHA256, releaseFile: name) }
        }
        var unavailable = size
        unavailable.available = false
        #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [unavailable], regions: regions, releaseSHA256: quote.releaseSHA256, releaseFile: file) }
        for price in [0.0, -1.0, Double.infinity, Double.nan] {
            var invalid = size; invalid.priceMonthly = price
            #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [invalid], regions: regions, releaseSHA256: quote.releaseSHA256, releaseFile: file) }
        }
        #expect(throws: (any Error).self) { try DigitalOceanQuote.make(sizes: [size], regions: [], releaseSHA256: quote.releaseSHA256, releaseFile: file) }
    }

    @Test func checksumPinsTheImmutableArchiveBehindTheCurrentAlias() throws {
        let hash = String(repeating: "a", count: 64), previous = String(repeating: "c", count: 64)
        let alias = "\(hash)  OpenStrudel-Home-1.0.tar.gz"
        // Until a release finishes cleaning up, the previous build is still listed.
        let published = [String(repeating: "d", count: 64) + "  OpenStrudel-1.0-59-arm64.dmg", "\(previous)  OpenStrudel-Home-1.0-58.tar.gz",
                         "\(hash)  OpenStrudel-Home-1.0-59.tar.gz", alias].joined(separator: "\n") + "\n"
        let release = try DigitalOceanQuote.release(from: published)
        #expect(release.sha256 == hash)
        #expect(release.file == "OpenStrudel-Home-1.0-59.tar.gz")
        #expect(try DigitalOceanQuote.release(from: "\(hash)  OpenStrudel-Home-1.0-35.1.tar.gz\n" + alias).file == "OpenStrudel-Home-1.0-35.1.tar.gz")
        for input in [alias, "\(previous)  OpenStrudel-Home-1.0-58.tar.gz\n" + alias,
                      "\(hash)  ../OpenStrudel-Home-1.0-59.tar.gz\n" + alias, "\(hash)  OpenStrudel-Home-1.0-59.tar.gz.sig\n" + alias,
                      "\(hash)  OpenStrudel-Home-1.0-59.tar.gz\n\(hash)  OpenStrudel-Home-1.0-60.tar.gz\n" + alias,
                      "\(hash)  OpenStrudel-Home-1.0-59.tar.gz\n\(alias)\n\(alias)", "\(hash)  Another.tar.gz",
                      "bad  OpenStrudel-Home-1.0-59.tar.gz\nbad  OpenStrudel-Home-1.0.tar.gz"] {
            #expect(throws: (any Error).self) { try DigitalOceanQuote.release(from: input) }
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
            quote: .init(monthlyPrice: 24, hourlyPrice: 0.035714, region: "fra1", size: "s-2vcpu-4gb", releaseSHA256: String(repeating: "b", count: 64), releaseFile: "OpenStrudel-Home-1.0-58.tar.gz"),
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

    @MainActor @Test func createSendsTheVersionedArchiveWithItsHash() async throws {
        let store = DigitalOceanMemoryStore()
        try store.save(JSONEncoder().encode(try initialState()))
        let observations = DigitalOceanObservations()
        let session = mockSession { request in
            if request.httpMethod == "POST", request.url?.path == "/v2/droplets" {
                let payload = try #require(JSONSerialization.jsonObject(with: Self.body(request)) as? [String: Any])
                let files = Self.userDataFiles(try #require(payload["user_data"] as? String))
                #expect(files["/var/lib/openstrudel-cloud/release.sha256"] == Data(String(repeating: "a", count: 64).utf8))
                #expect(files["/var/lib/openstrudel-cloud/release.file"] == Data("OpenStrudel-Home-1.0-59.tar.gz".utf8))
                await MainActor.run { observations.creates += 1 }
                throw URLError(.timedOut)
            }
            return try Self.mockResponse(request)
        }
        let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await cloud.resume()
        #expect(cloud.quote?.releaseFile == "OpenStrudel-Home-1.0-59.tar.gz")
        await cloud.confirmCreate()
        #expect(observations.creates == 1)
    }

    @MainActor @Test func installationSavedBeforeArchivesWerePinnedStillLoads() throws {
        var record = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(try attemptedState(dropletID: 12345))) as? [String: Any])
        var installation = try #require(record["installation"] as? [String: Any])
        var quote = try #require(installation["quote"] as? [String: Any])
        quote.removeValue(forKey: "releaseFile"); installation["quote"] = quote; record["installation"] = installation
        let restored = try JSONDecoder().decode(DigitalOceanSavedState.self, from: JSONSerialization.data(withJSONObject: record))
        #expect(restored.installation?.quote.releaseFile == nil)
        #expect(restored.installation?.dropletID == 12345)
    }

    @MainActor @Test func deletedServerStartsOverOnlyWithAFreshQuote() async throws {
        let store = DigitalOceanMemoryStore()
        let state = try attemptedState(dropletID: 12345)
        let old = try #require(state.installation)
        try store.save(JSONEncoder().encode(state))
        let observations = DigitalOceanObservations()
        let session = mockSession { request in
            if request.httpMethod == "POST" { await MainActor.run { observations.creates += 1 } }
            if request.url?.path == "/v2/droplets/12345" { return (404, Data(#"{"id":"not_found"}"#.utf8)) }
            if request.url?.path == "/v2/droplets" {
                #expect(request.url?.query == "tag_name=\(old.name)&per_page=200")
                await MainActor.run { observations.requests += 1 }
            }
            return try Self.mockResponse(request)
        }
        let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await cloud.resume()
        #expect(cloud.phase == .failed)
        #expect(cloud.canStartOver)
        await cloud.startOver()
        #expect(observations.requests == 1, "Forget it only after DigitalOcean lists no server with its tag")
        #expect(cloud.phase == .readyToCreate)
        #expect(!cloud.canStartOver)
        #expect(cloud.quote?.releaseFile == "OpenStrudel-Home-1.0-59.tar.gz")
        #expect(cloud.managementURL == nil)
        let data = try #require(store.data)
        let saved = try #require(JSONDecoder().decode(DigitalOceanSavedState.self, from: data).installation)
        #expect(saved.id != old.id)
        #expect(saved.privateKeyPEM != old.privateKeyPEM)
        #expect(saved.createAttemptedAt == nil)
        #expect(saved.dropletID == nil)
        #expect(observations.creates == 0, "A new server still needs the user's confirmation of the price")
    }

    @MainActor @Test func startOverKeepsTheInstallationUnlessDigitalOceanListsNoServer() async throws {
        for mode in ["listed", "serverError", "offline", "otherAccount"] {
            let store = DigitalOceanMemoryStore()
            let state = try attemptedState(dropletID: nil)
            let old = try #require(state.installation)
            try store.save(JSONEncoder().encode(state))
            let observations = DigitalOceanObservations()
            let session = mockSession { request in
                if request.httpMethod == "POST" { await MainActor.run { observations.creates += 1 } }
                let current = await MainActor.run { observations.mode }
                switch (request.url?.path, current) {
                case ("/v2/droplets", "listed"):
                    return (200, Data(#"{"droplets":[{"id":7,"name":"\#(old.name)","status":"active","tags":["\#(old.name)"],"networks":{"v4":[]}}]}"#.utf8))
                case ("/v2/droplets", "serverError"): return (500, Data("{}".utf8))
                case ("/v2/droplets", "offline"): throw URLError(.notConnectedToInternet)
                case ("/v2/account", "otherAccount"):
                    return (200, Data(#"{"account":{"uuid":"account-2","email_verified":true,"status":"active","droplet_limit":25}}"#.utf8))
                default: return try Self.mockResponse(request)
                }
            }
            let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
            await cloud.resume()
            #expect(cloud.canStartOver, "\(mode)")
            observations.mode = mode
            await cloud.startOver()
            let saved = try JSONDecoder().decode(DigitalOceanSavedState.self, from: #require(store.data)).installation
            #expect(saved?.id == old.id, "\(mode)")
            #expect(saved?.createAttemptedAt == old.createAttemptedAt, "\(mode)")
            #expect(cloud.phase != .readyToCreate, "\(mode)")
            #expect(observations.creates == 0, "\(mode)")
        }
    }

    @MainActor @Test func startOverWaitsWhileARecentCreateCanStillAppear() async throws {
        let store = DigitalOceanMemoryStore()
        let state = try attemptedState(dropletID: nil, attemptedAt: Date())
        let old = try #require(state.installation)
        try store.save(JSONEncoder().encode(state))
        let observations = DigitalOceanObservations()
        let session = mockSession { request in
            if request.url?.path == "/v2/droplets" { await MainActor.run { observations.requests += 1 } }
            return try Self.mockResponse(request)
        }
        let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
        await cloud.resume()
        #expect(cloud.canStartOver)
        let listed = observations.requests
        await cloud.startOver()
        #expect(observations.requests == listed, "An empty list right after an unanswered create proves nothing")
        #expect(try JSONDecoder().decode(DigitalOceanSavedState.self, from: #require(store.data)).installation?.id == old.id)
        #expect(cloud.phase == .failed)
        #expect(cloud.message != nil)
    }

    @MainActor @Test func resumeDoesNotReAddAConnectionWhoseServerWasDeleted() async throws {
        let connection = HomeConnection(url: "https://8.8.8.8:7789", token: String(repeating: "a", count: 64), pin: String(repeating: "c", count: 64), name: "Моя команда")
        for (mode, connected) in [("deleted", false), ("active", true), ("offline", true), ("signedOut", true)] {
            let store = DigitalOceanMemoryStore()
            var state = try attemptedState(dropletID: 12345, connection: connection)
            if mode == "signedOut" { state.tokens = nil }
            try store.save(JSONEncoder().encode(state))
            let session = mockSession { request in
                guard request.url?.path == "/v2/droplets/12345" else { return try Self.mockResponse(request) }
                switch mode {
                case "active": return (200, Data(#"{"droplet":{"id":12345}}"#.utf8))
                case "offline": throw URLError(.notConnectedToInternet)
                case "signedOut":
                    Issue.record("Without a DigitalOcean sign-in the saved connection is used as it is")
                    throw URLError(.userAuthenticationRequired)
                default: return (404, Data(#"{"id":"not_found"}"#.utf8))
                }
            }
            let cloud = DigitalOceanCloud(store: store, session: session, pollingAttempts: 1)
            await cloud.resume()
            #expect((cloud.phase == .connected) == connected, "\(mode)")
            #expect((cloud.connection?.url == connection.url) == connected, "\(mode)")
            #expect(cloud.canStartOver == !connected, "\(mode)")
            let saved = try JSONDecoder().decode(DigitalOceanSavedState.self, from: #require(store.data))
            #expect(saved.installation?.connection?.url == connection.url, "Only a confirmed start over forgets it")
        }
    }

    @MainActor private func attemptedState(dropletID: Int?, attemptedAt: Date = Date().addingTimeInterval(-3600),
                                           connection: HomeConnection? = nil) throws -> DigitalOceanSavedState {
        var state = try initialState()
        state.installation = .init(id: UUID().uuidString.lowercased(), accountID: "account:account-1",
            privateKeyPEM: P256.Signing.PrivateKey().pemRepresentation, ownerToken: String(repeating: "a", count: 64),
            quote: .init(monthlyPrice: 24, hourlyPrice: 0.035714, region: "fra1", size: "s-2vcpu-4gb",
                         releaseSHA256: String(repeating: "b", count: 64), releaseFile: "OpenStrudel-Home-1.0-58.tar.gz"),
            createAttemptedAt: attemptedAt, dropletID: dropletID, connection: connection)
        return state
    }

    /// The cloud-config files by path, decoded from their base64 content.
    private static func userDataFiles(_ userData: String) -> [String: Data] {
        var files: [String: Data] = [:]
        var path: String?
        for line in userData.components(separatedBy: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }) {
            if line.hasPrefix("- path: ") { path = String(line.dropFirst("- path: ".count)) }
            if line.hasPrefix("content: "), let current = path {
                files[current] = Data(base64Encoded: String(line.dropFirst("content: ".count))); path = nil
            }
        }
        return files
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
        case "/openstrudel/downloads/SHA256SUMS":
            let hash = String(repeating: "a", count: 64)
            return (200, Data("\(hash)  OpenStrudel-Home-1.0-59.tar.gz\n\(hash)  OpenStrudel-Home-1.0.tar.gz\n".utf8))
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
    var mode = ""
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
        operation = Task { @Sendable [self] in
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
