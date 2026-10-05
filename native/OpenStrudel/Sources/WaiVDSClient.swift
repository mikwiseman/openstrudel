#if os(macOS)
import Foundation
import CryptoKit
import Security

@MainActor protocol WaiVDSCredentialStore {
    func load() throws -> Data?
    func save(_ data: Data) throws
}

@MainActor private struct WaiVDSKeychain: WaiVDSCredentialStore {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "is.openstrudel.native") + ".wai-vds",
         kSecAttrAccount as String: "owner"]
    }
    func load() throws -> Data? {
        var request = query; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw WaiVDSFailure.storage }
        return data
    }
    func save(_ data: Data) throws {
        let attrs: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(query.merging(attrs) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw WaiVDSFailure.storage }
    }
}

@MainActor protocol WaiVDSTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

@MainActor private final class WaiVDSHTTP: WaiVDSTransport {
    private let session: URLSession
    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 60
        config.httpShouldSetCookies = false; config.httpCookieAcceptPolicy = .never; config.urlCache = nil
        session = URLSession(configuration: config, delegate: DigitalOceanNoRedirects(), delegateQueue: nil)
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw WaiVDSFailure.response }
        return (data, http)
    }
}

struct WaiVDSSavedState: Codable {
    struct Login: Codable { let state: String; let verifier: String; let startedAt: Date }
    struct Tokens: Codable {
        let access: String; let refresh: String; let expiresAt: Date; let refreshExpiresAt: Date
        let signedInAt: Date; let sessionId: String
    }
    struct Offer: Codable { let quote: WaiVDSQuote; let sessionId: String }
    struct Installation: Codable {
        let id: String; let privateKeyPEM: String; let ownerToken: String; let releaseHash: String
        var connection: HomeConnection?
    }
    struct Intent: Codable {
        let quote: WaiVDSQuote; let installationId: String; let returnState: String
        let payload: Data // Exact wire bytes survive process death, including idempotency key.
        var sessionId: String; var attempted: Bool = false; var order: WaiVDSOrder?
        var checkoutUncertain: Bool = false
    }
    var login: Login?
    var tokens: Tokens?
    var offer: Offer?
    var intent: Intent?
    var installations: [String: Installation] = [:]
}

/// Dormant Mac integration, deliberately not wired into onboarding. All writes
/// require an explicit caller action. resume() only restores the owner's orders.
/// One operation at a time also prevents replay of rotating refresh credentials.
@MainActor final class WaiVDSClient {
    private let store: any WaiVDSCredentialStore
    private let transport: any WaiVDSTransport
    private let now: () -> Date
    private var state: WaiVDSSavedState
    private var busy = false

    init(store: (any WaiVDSCredentialStore)? = nil, transport: (any WaiVDSTransport)? = nil, now: @escaping () -> Date = Date.init) throws {
        let store = store ?? WaiVDSKeychain()
        self.store = store; self.transport = transport ?? WaiVDSHTTP(); self.now = now
        do { state = try store.load().map { try JSONDecoder().decode(WaiVDSSavedState.self, from: $0) } ?? WaiVDSSavedState() }
        catch { throw WaiVDSFailure.storage }
    }

    var savedOrder: WaiVDSOrder? { state.intent?.order }
    var hasUncertainCheckout: Bool { state.intent?.checkoutUncertain ?? false }

    private func save(_ next: WaiVDSSavedState) throws {
        do { try store.save(JSONEncoder().encode(next)); state = next }
        catch { throw WaiVDSFailure.storage }
    }
    private func perform<T>(_ operation: () async throws -> T) async throws -> T {
        guard !busy else { throw WaiVDSFailure.busy }
        busy = true; defer { busy = false }
        return try await operation()
    }
    private func body(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: .sortedKeys) }

    func beginSignIn(fresh: Bool = false) throws -> URL {
        guard !busy else { throw WaiVDSFailure.busy }
        let login = WaiVDSSavedState.Login(state: try WaiVDSContract.random(), verifier: try WaiVDSContract.random(), startedAt: now())
        var next = state; next.login = login; next.tokens = nil; next.offer = nil
        try save(next)
        var parts = URLComponents(string: WaiVDSContract.origin + "/oauth/authorize")!
        parts.queryItems = ["client_id": "openstrudel", "response_type": "code", "redirect_uri": WaiVDSContract.callback,
                            "scope": "home:manage", "state": login.state, "code_challenge_method": "S256",
                            "code_challenge": DigitalOceanOAuth.challenge(login.verifier)]
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        if fresh { parts.queryItems?.append(.init(name: "prompt", value: "login")) }
        return parts.url!
    }

    func finishSignIn(_ url: URL) async throws {
        try await perform {
            guard let login = state.login, now().timeIntervalSince(login.startedAt) >= 0,
                  now().timeIntervalSince(login.startedAt) < 600 else { throw WaiVDSFailure.signIn }
            let values = try WaiVDSContract.callbackParameters(url, expected: WaiVDSContract.callback, state: login.state)
            var next = state; next.login = nil; next.tokens = nil; next.offer = nil
            // Persist consumption before any exchange, including cancellation.
            try save(next)
            if values["error"] == "access_denied" { throw CancellationError() }
            guard Set(values.keys) == ["state", "code", "iss"], values["iss"] == WaiVDSContract.origin,
                  let code = values["code"], WaiVDSContract.isHash(code) else { throw WaiVDSFailure.callback }
            let data = try await request("POST", path: "/oauth/token", data: body([
                "grant_type": "authorization_code", "client_id": "openstrudel", "code": code,
                "code_verifier": login.verifier, "redirect_uri": WaiVDSContract.callback
            ]))
            let tokens = try credentials(data, sessionId: UUID().uuidString, signedInAt: now())
            next.tokens = tokens; try save(next)
        }
    }

    func catalog() async throws -> WaiVDSCatalog { try await perform { try await catalogUnlocked() } }
    private func catalogUnlocked() async throws -> WaiVDSCatalog {
        let result = try WaiVDSContract.decode(WaiVDSCatalog.self, from: await request("GET", path: WaiVDSContract.api + "/catalog"))
        try result.validate(); return result
    }

    /// No provider account or shared operator key. Re-login never assigns an old
    /// intent to the new account unless its exact order appears in this list.
    func resume() async throws -> [WaiVDSOrder] { try await perform { try await resumeUnlocked() } }
    private func resumeUnlocked() async throws -> [WaiVDSOrder] {
        struct List: Decodable { let orders: [WaiVDSOrder] }
        let token = try await access()
        let result = try WaiVDSContract.decode(List.self, from: await request("GET", path: WaiVDSContract.api + "/orders", bearer: token))
        guard Set(result.orders.map(\.orderId)).count == result.orders.count else { throw WaiVDSFailure.response }
        for order in result.orders { try order.validate() }
        if var intent = state.intent {
            let matches = result.orders.filter { $0.matches(quote: intent.quote, installation: intent.installationId) }
            guard matches.count <= 1 else { throw WaiVDSFailure.response }
            if let order = matches.first {
                if let old = intent.order, old.orderId != order.orderId { throw WaiVDSFailure.response }
                intent.order = order; intent.sessionId = state.tokens!.sessionId
                var next = state; next.intent = intent; try save(next)
            } else if intent.sessionId != state.tokens?.sessionId || intent.order != nil { throw WaiVDSFailure.wrongAccount }
        }
        return result.orders
    }

    func quote(paymentMethod: String, renewing installationId: String? = nil) async throws -> WaiVDSQuote {
        try await perform {
            _ = try await resumeUnlocked()
            let catalog = try await catalogUnlocked()
            guard catalog.purchaseEnabled, catalog.platforms.mac.purchaseEnabled,
                  let method = catalog.paymentMethods.first(where: { $0.id == paymentMethod }), method.amountMinor != nil
            else { throw WaiVDSFailure.unavailable }
            var input: [String: Any] = ["profile_id": catalog.profile.id, "platform": "mac", "payment_method": paymentMethod]
            if let installationId {
                guard WaiVDSContract.id(installationId), state.installations[installationId] != nil else { throw WaiVDSFailure.identity }
                input["installation_id"] = installationId
            }
            let token = try await access()
            let result = try WaiVDSContract.decode(WaiVDSQuote.self, from: await request("POST", path: WaiVDSContract.api + "/quotes", data: body(input), bearer: token))
            try result.validate(at: now())
            guard result.paymentMethod == paymentMethod, result.installationId == installationId,
                  result.currency == method.currency, result.amountMinor == method.amountMinor,
                  (installationId != nil || result.profile == catalog.profile),
                  result.mode == (catalog.mode == "emulator" ? "emulator" : "live") else { throw WaiVDSFailure.response }
            var next = state; next.offer = .init(quote: result, sessionId: state.tokens!.sessionId); try save(next)
            return result
        }
    }

    /// Only call after displaying this exact offer and receiving explicit consent.
    func confirmOrder(quoteId: String) async throws -> WaiVDSOrder {
        try await perform {
            let token = try await access()
            guard let offer = state.offer, offer.quote.quoteId == quoteId, offer.sessionId == state.tokens?.sessionId else { throw WaiVDSFailure.wrongAccount }
            try offer.quote.validate(at: now())
            if let previous = state.intent {
                guard let order = previous.order, ["fulfilled", "refunded", "canceled"].contains(order.orderStatus),
                      previous.sessionId == state.tokens?.sessionId, !previous.checkoutUncertain else { throw WaiVDSFailure.conflict }
            }
            var next = state
            let installation: WaiVDSSavedState.Installation
            if let id = offer.quote.installationId {
                guard let saved = state.installations[id] else { throw WaiVDSFailure.identity }
                installation = saved
            } else {
                installation = .init(id: UUID().uuidString.lowercased(), privateKeyPEM: P256.Signing.PrivateKey().pemRepresentation,
                                     ownerToken: WaiVDSContract.hash(Data(try WaiVDSContract.random().utf8)), releaseHash: offer.quote.profile.releaseSha256)
                next.installations[installation.id] = installation
            }
            let returnState = try WaiVDSContract.random()
            var input: [String: Any] = ["quote_id": quoteId, "quote_digest": offer.quote.quoteDigest,
                                       "idempotency_key": UUID().uuidString.lowercased(), "consent": true,
                                       "return_uri": WaiVDSContract.paymentCallback, "return_state": returnState]
            if offer.quote.kind == "initial" {
                input["bootstrap"] = ["installationId": installation.id, "privateKeyPEM": installation.privateKeyPEM,
                                      "ownerTokenHash": WaiVDSContract.hash(Data(installation.ownerToken.utf8))]
            }
            next.intent = .init(quote: offer.quote, installationId: installation.id, returnState: returnState,
                                payload: try body(input), sessionId: offer.sessionId)
            next.offer = nil
            try save(next) // No POST if durable storage is unavailable.
            return try await submitIntent(token: token)
        }
    }

    /// Explicit recovery of an uncertain order POST uses the identical payload.
    /// After a fresh login only resume/list may prove ownership of the old order.
    func retrySavedOrder() async throws -> WaiVDSOrder {
        try await perform {
            let token = try await access()
            guard let intent = state.intent, intent.sessionId == state.tokens?.sessionId else { throw WaiVDSFailure.wrongAccount }
            if intent.order != nil { return try await syncUnlocked() }
            return try await submitIntent(token: token)
        }
    }
    private func submitIntent(token: String) async throws -> WaiVDSOrder {
        guard var intent = state.intent else { throw WaiVDSFailure.conflict }
        if !intent.attempted { try intent.quote.validate(at: now()) }
        intent.attempted = true
        var next = state; next.intent = intent; try save(next)
        let data: Data
        do { data = try await request("POST", path: WaiVDSContract.api + "/orders", data: intent.payload, bearer: token) }
        catch let failure as WaiVDSFailure where failure == .quoteExpired || failure == .unavailable {
            // The backend checks an existing idempotency key before these gates.
            // These explicit answers therefore prove this exact order was not
            // created. A transport failure never takes this branch.
            var rejected = state; rejected.intent = nil; rejected.offer = nil; try save(rejected)
            throw failure
        }
        let order = try WaiVDSContract.decode(WaiVDSOrder.self, from: data)
        try record(order); return order
    }

    func syncPayment() async throws -> WaiVDSOrder { try await perform { try await syncUnlocked() } }
    private func syncUnlocked() async throws -> WaiVDSOrder {
        let token = try await access(); let order = try boundOrder()
        let data = try await request("POST", path: WaiVDSContract.api + "/orders/\(order.orderId)/sync", bearer: token)
        let latest = try WaiVDSContract.decode(WaiVDSOrder.self, from: data)
        try record(latest)
        // A local timeout/expiry cannot clear the uncertainty marker. Only a
        // definite, verified gateway answer may permit another payment action.
        if latest.paymentVerifiedAt != nil, !["unknown", "confirmation_pending", "none"].contains(latest.sessionState),
           latest.paymentState != "unknown", latest.actionRequired != "wait_for_confirmation" {
            var next = state; next.intent?.checkoutUncertain = false; try save(next)
        }
        return latest
    }
    func checkout() async throws -> URL? {
        try await perform {
            let latest = try await syncUnlocked()
            guard !hasUncertainCheckout, latest.canRequestCheckout(at: now())
                || (latest.actionRequired == "complete_payment" && latest.sessionState == "open" && ["pending", "unpaid"].contains(latest.paymentState))
            else { throw WaiVDSFailure.paymentPending }
            let token = try await access()
            var next = state; next.intent?.checkoutUncertain = true; try save(next)
            let data = try await request("POST", path: WaiVDSContract.api + "/orders/\(latest.orderId)/checkout", bearer: token)
            let result = try WaiVDSContract.decode(WaiVDSCheckout.self, from: data)
            try record(result.order)
            let url = try result.browserURL(at: now())
            // null URL must never resurrect a previously opened checkout URL.
            return url
        }
    }
    func handlePaymentReturn(_ url: URL) async throws -> WaiVDSOrder {
        try await perform {
            guard let intent = state.intent, let order = intent.order else { throw WaiVDSFailure.callback }
            let values = try WaiVDSContract.callbackParameters(url, expected: WaiVDSContract.paymentCallback, state: intent.returnState)
            guard Set(values.keys) == ["order_id", "state"], values["order_id"] == order.orderId else { throw WaiVDSFailure.callback }
            return try await syncUnlocked()
        }
    }

    func claimConnection() async throws -> HomeConnection {
        try await perform {
            let order = try await syncUnlocked()
            guard order.mode == "live", order.canClaim(at: now()), let installation = state.installations[order.installationId] else { throw WaiVDSFailure.identity }
            let token = try await access()
            struct Claim: Decodable { let claimToken: String; let installationId: String; let expiresIn: Int }
            let claim = try WaiVDSContract.decode(Claim.self, from: await request("POST", path: WaiVDSContract.api + "/installations/\(order.installationId)/claims", data: body(["recover_owner": false]), bearer: token))
            guard claim.installationId == installation.id, claim.expiresIn == 300, WaiVDSContract.isHash(claim.claimToken) else { throw WaiVDSFailure.identity }
            // No automatic retry and no persisted claim. A lost consume response
            // requires a newly issued claim, never replay of this one-use token.
            let connection = try WaiVDSContract.decode(WaiVDSConnectionClaim.self, from: await request("POST", path: WaiVDSContract.api + "/claims/consume",
                data: body(["claim_token": claim.claimToken, "installation_id": installation.id]), bearer: token))
            let endpoint = try connection.endpoint(for: installation.id, release: installation.releaseHash)
            let trust = WaiVDSHomeTrust(host: endpoint.host!, pin: connection.certificateSha256,
                                       publicKey: try P256.Signing.PrivateKey(pemRepresentation: installation.privateKeyPEM).publicKey.x963Representation)
            let session = trust.session(); defer { session.invalidateAndCancel() }
            var request = URLRequest(url: endpoint.appendingPathComponent("health"))
            request.setValue("Bearer " + installation.ownerToken, forHTTPHeaderField: "Authorization")
            let (data, response) = try await session.data(for: request)
            guard trust.verified, let http = response as? HTTPURLResponse, http.url == request.url, data.count <= 262_144 else { throw WaiVDSFailure.identity }
            if [401, 403].contains(http.statusCode) { throw WaiVDSFailure.homeAuthentication }
            struct Health: Decodable { let ok: Bool; let service: String }
            guard http.statusCode == 200, let health = try? JSONDecoder().decode(Health.self, from: data), health.ok, health.service == "openstrudel" else { throw WaiVDSFailure.response }
            let saved = HomeConnection(url: endpoint.absoluteString, token: installation.ownerToken, pin: connection.certificateSha256, name: "Моя команда")
            var next = state; next.installations[installation.id]?.connection = saved; try save(next)
            return saved // OpenAI login remains a separate, personal Home action.
        }
    }

    private func boundOrder() throws -> WaiVDSOrder {
        guard let intent = state.intent, intent.sessionId == state.tokens?.sessionId, let order = intent.order else { throw WaiVDSFailure.wrongAccount }
        try order.validate(); return order
    }
    private func record(_ order: WaiVDSOrder) throws {
        try order.validate()
        guard var intent = state.intent, order.matches(quote: intent.quote, installation: intent.installationId),
              intent.order == nil || intent.order?.orderId == order.orderId else { throw WaiVDSFailure.response }
        intent.order = order
        var next = state; next.intent = intent; try save(next)
    }
    private func credentials(_ data: Data, sessionId: String, signedInAt: Date) throws -> WaiVDSSavedState.Tokens {
        struct Credentials: Decodable {
            let accessToken: String; let refreshToken: String; let tokenType: String
            let expiresIn: Int; let refreshExpiresIn: Int; let scope: String
        }
        let c = try WaiVDSContract.decode(Credentials.self, from: data)
        guard c.accessToken.hasPrefix("os_access_"), WaiVDSContract.isHash(String(c.accessToken.dropFirst(10))),
              c.refreshToken.hasPrefix("os_refresh_"), WaiVDSContract.isHash(String(c.refreshToken.dropFirst(11))),
              c.tokenType == "Bearer", c.scope == "home:manage", c.expiresIn == 900,
              c.refreshExpiresIn > 0, c.refreshExpiresIn <= 30 * 86_400 else { throw WaiVDSFailure.signIn }
        return .init(access: c.accessToken, refresh: c.refreshToken, expiresAt: now().addingTimeInterval(900),
                     refreshExpiresAt: now().addingTimeInterval(TimeInterval(c.refreshExpiresIn)), signedInAt: signedInAt, sessionId: sessionId)
    }
    private func access() async throws -> String {
        guard let old = state.tokens else { throw WaiVDSFailure.signIn }
        if old.expiresAt > now().addingTimeInterval(30) { return old.access }
        var next = state; next.tokens = nil; try save(next)
        guard old.refreshExpiresAt > now() else { throw WaiVDSFailure.signIn }
        // Consume durable refresh before POST. Neither timeout nor process death
        // can replay it and revoke the whole grant family on the backend.
        let data = try await request("POST", path: "/oauth/token", data: body(["grant_type": "refresh_token", "client_id": "openstrudel", "refresh_token": old.refresh]))
        let refreshed = try credentials(data, sessionId: old.sessionId, signedInAt: old.signedInAt)
        next.tokens = refreshed; try save(next)
        return refreshed.access
    }
    private func request(_ method: String, path: String, data: Data? = nil, bearer: String? = nil) async throws -> Data {
        guard path == "/oauth/token" || path.hasPrefix(WaiVDSContract.api + "/"), !path.contains("?"), !path.contains("#"),
              !path.contains(".."), !path.contains("%"), let url = URL(string: WaiVDSContract.origin + path), url.host == "server.waiwai.is"
        else { throw WaiVDSFailure.response }
        var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if data != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let bearer { request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization") }
        let result: (Data, HTTPURLResponse)
        do { result = try await transport.send(request) }
        catch { throw method == "GET" ? WaiVDSFailure.network : WaiVDSFailure.unknownResult }
        let (bytes, http) = result
        guard http.url == url, bytes.count <= 1_048_576,
              http.mimeType == "application/json", !(300...399).contains(http.statusCode) else { throw WaiVDSFailure.response }
        if (200...299).contains(http.statusCode) { return bytes }
        struct Failure: Decodable { let code: String? }
        let code = (try? WaiVDSContract.decode(Failure.self, from: bytes))?.code
        if http.statusCode == 401 || (path == "/oauth/token" && [400, 403].contains(http.statusCode)) {
            var next = state; next.tokens = nil; next.offer = nil; try save(next); throw WaiVDSFailure.signIn
        }
        if code == "reauthorization_required" { throw WaiVDSFailure.freshSignIn }
        if code == "home_purchase_unavailable" || code == "profile_unavailable" { throw WaiVDSFailure.unavailable }
        if code == "quote_expired" { throw WaiVDSFailure.quoteExpired }
        if http.statusCode == 429 { throw WaiVDSFailure.rateLimited }
        if http.statusCode == 404 { throw WaiVDSFailure.wrongAccount }
        if http.statusCode == 409 { throw WaiVDSFailure.conflict }
        throw WaiVDSFailure.response
    }
}

/// Both the backend's certificate digest and the device-generated P-256 key must
/// match during TLS authentication, before URLSession sends the owner token.
final class WaiVDSHomeTrust: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let host: String; private let pin: String; private let publicKey: Data
    private let lock = NSLock(); private var accepted = false
    var verified: Bool { lock.lock(); defer { lock.unlock() }; return accepted }
    init(host: String, pin: String, publicKey: Data) { self.host = host; self.pin = pin; self.publicKey = publicKey }
    func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 30; config.httpShouldSetCookies = false; config.urlCache = nil
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    static func matches(host: String, port: Int, pin: String, publicKey: Data, expectedHost: String, expectedPin: String, expectedKey: Data) -> Bool {
        pin == expectedPin && WaiVDSContract.isHash(pin)
            && DigitalOceanHomeTrust.matches(actualKey: publicKey, expectedKey: expectedKey, host: host, expectedHost: expectedHost, port: port)
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first,
              let key = SecCertificateCopyKey(certificate), let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              Self.matches(host: space.host, port: space.port, pin: WaiVDSContract.hash(SecCertificateCopyData(certificate) as Data),
                           publicKey: raw, expectedHost: host, expectedPin: pin, expectedKey: publicKey)
        else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        lock.lock(); accepted = true; lock.unlock()
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
#endif
