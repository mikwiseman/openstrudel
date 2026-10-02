import Foundation
import Combine
import CryptoKit
import Security
import AuthenticationServices
#if os(macOS)
import AppKit
#else
import UIKit
#endif

private enum DigitalOceanFailure: Error {
    case storage, response, signIn, callback, accountNotReady, unavailablePlan, release
    case wrongAccount, uncertainCreate, missingServer, ambiguousServer, serverIdentity, serverAuthentication
}

private struct DigitalOceanHTTPFailure: Error {
    let status: Int
    let paymentRequired: Bool
}

struct DigitalOceanSize: Codable, Sendable {
    var slug: String
    var memory: Int
    var vcpus: Int
    var disk: Int
    var priceMonthly: Double
    var priceHourly: Double
    var regions: [String]
    var available: Bool
    enum CodingKeys: String, CodingKey {
        case slug, memory, vcpus, disk, regions, available
        case priceMonthly = "price_monthly", priceHourly = "price_hourly"
    }
}

struct DigitalOceanRegion: Codable, Sendable { let slug: String; let available: Bool }

struct DigitalOceanQuote: Codable, Equatable, Sendable {
    let monthlyPrice: Double
    let hourlyPrice: Double
    let region: String
    let size: String
    let releaseSHA256: String
    var title: String { "Basic · 2 CPU · 4 ГБ" }

    static func make(sizes: [DigitalOceanSize], regions: [DigitalOceanRegion], releaseSHA256: String) throws -> Self {
        let matches = sizes.filter { $0.slug == "s-2vcpu-4gb" }
        guard matches.count == 1, let size = matches.first, size.available,
              size.memory == 4096, size.vcpus == 2, size.disk >= 50,
              size.priceMonthly.isFinite, size.priceMonthly > 0,
              size.priceHourly.isFinite, size.priceHourly > 0,
              releaseSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        else { throw DigitalOceanFailure.unavailablePlan }
        // Amsterdam is the only fallback: the same plan, still within the EU.
        guard let region = ["fra1", "ams3"].first(where: { slug in
            size.regions.contains(slug) && regions.contains { $0.slug == slug && $0.available }
        }) else { throw DigitalOceanFailure.unavailablePlan }
        return .init(monthlyPrice: size.priceMonthly, hourlyPrice: size.priceHourly,
                     region: region, size: size.slug, releaseSHA256: releaseSHA256)
    }

    static func releaseHash(from checksums: String) throws -> String {
        let matches = checksums.split(whereSeparator: \.isNewline).compactMap { line -> String? in
            let columns = line.split(whereSeparator: \.isWhitespace)
            guard columns.count == 2, columns[1] == "OpenStrudel-Home-1.0.tar.gz" else { return nil }
            return String(columns[0])
        }
        guard matches.count == 1, let hash = matches.first,
              hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        else { throw DigitalOceanFailure.release }
        return hash
    }
}

enum DigitalOceanOAuth {
    static let callback = "openstrudel://oauth/digitalocean"
    // DO requires these read dependencies when granting droplet:create/tag:create.
    static let scopes = "account:read droplet:read droplet:create image:read sizes:read regions:read actions:read snapshot:read vpc:read tag:read tag:create"

    static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw DigitalOceanFailure.storage }
        return base64URL(Data(bytes))
    }
    static func challenge(_ verifier: String) -> String { base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func code(from url: URL, state: String) throws -> String {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "openstrudel", parts.host == "oauth", parts.path == "/digitalocean",
              parts.port == nil, parts.user == nil, parts.password == nil, parts.fragment == nil
        else { throw DigitalOceanFailure.callback }
        let items = parts.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count,
              items.first(where: { $0.name == "state" })?.value == state, !state.isEmpty
        else { throw DigitalOceanFailure.callback }
        if items.contains(where: { $0.name == "error" }) { throw DigitalOceanFailure.signIn }
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty, code.count <= 4096
        else { throw DigitalOceanFailure.callback }
        return code
    }
}

struct DigitalOceanSavedState: Codable {
    struct Registration: Codable {
        let clientID: String
        let registrationAccessToken: String
        let registrationClientURI: String
    }
    struct Tokens: Codable {
        let accessToken: String
        let refreshToken: String
        let expiresAt: Date
    }
    struct PendingOAuth: Codable { let state: String; let verifier: String; let startedAt: Date }
    struct Installation: Codable {
        let id: String
        let accountID: String
        let privateKeyPEM: String
        let ownerToken: String
        var quote: DigitalOceanQuote
        var createAttemptedAt: Date?
        var dropletID: Int?
        var connection: HomeConnection?
        var name: String { "openstrudel-" + id }
    }
    var registration: Registration?
    var tokens: Tokens?
    var pendingOAuth: PendingOAuth?
    var installation: Installation?
}

@MainActor protocol DigitalOceanCredentialStore {
    func load() throws -> Data?
    func save(_ data: Data) throws
}

@MainActor private struct DigitalOceanKeychain: DigitalOceanCredentialStore {
    private var query: [String: Any] {
        var value: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "is.openstrudel.native") + ".digitalocean",
         kSecAttrAccount as String: "setup"]
        #if os(iOS)
        value[kSecUseDataProtectionKeychain as String] = true
        #endif
        return value
    }
    func load() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw DigitalOceanFailure.storage }
        return data
    }
    func save(_ data: Data) throws {
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw DigitalOceanFailure.storage }
    }
}

/// One durable installation. Only confirmCreate may issue a paid request; resume
/// never repeats it, even after a timeout, cancellation, or application restart.
@MainActor final class DigitalOceanCloud: ObservableObject {
    enum Phase { case idle, signingIn, billingRequired, readyToCreate, creating, waitingForServer, connected, failed }
    typealias Quote = DigitalOceanQuote
    static let shared = DigitalOceanCloud()
    static let billingURL = URL(string: "https://cloud.digitalocean.com/account/billing")!

    static func managementURL(for connectionURL: String, store: (any DigitalOceanCredentialStore)? = nil) -> URL? {
        guard let data = try? (store ?? DigitalOceanKeychain()).load(),
              let saved = try? JSONDecoder().decode(DigitalOceanSavedState.self, from: data),
              let installation = saved.installation, let id = installation.dropletID, id > 0,
              let connection = installation.connection, connection.url == connectionURL,
              let parts = URLComponents(string: connectionURL), parts.scheme == "https", parts.port == 7789,
              let host = parts.host, DigitalOceanHomeTrust.isPublicIPv4(host), parts.path.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil
        else { return nil }
        return URL(string: "https://cloud.digitalocean.com/droplets/\(id)")
    }

    var managementURL: URL? {
        guard let installation = state.installation, installation.createAttemptedAt != nil else { return nil }
        if let id = installation.dropletID, id > 0 { return URL(string: "https://cloud.digitalocean.com/droplets/\(id)") }
        return URL(string: "https://cloud.digitalocean.com/")
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var quote: Quote?
    @Published private(set) var connection: HomeConnection?
    @Published private(set) var message: String?

    private let store: any DigitalOceanCredentialStore
    private let session: URLSession
    private let pollingAttempts: Int
    private let browser = DigitalOceanWebLogin()
    private var state = DigitalOceanSavedState()
    private var operation: Task<Void, Never>?

    init(store: (any DigitalOceanCredentialStore)? = nil, session: URLSession? = nil, pollingAttempts: Int = 90) {
        self.store = store ?? DigitalOceanKeychain()
        self.session = session ?? DigitalOceanNoRedirects.session()
        self.pollingAttempts = max(1, min(90, pollingAttempts))
    }

    func signIn() async {
        await perform {
            self.phase = .signingIn
            try await self.authenticate()
            try await self.advance()
        }
    }
    func resume() async {
        await perform {
            if let saved = self.state.installation?.connection {
                self.connection = saved; self.phase = .connected; return
            }
            guard self.state.tokens != nil else { self.phase = .idle; return }
            try await self.advance()
        }
    }
    func confirmCreate() async {
        guard phase == .readyToCreate else { return }
        let approvedQuote = quote
        await perform {
            guard self.state.installation?.createAttemptedAt == nil else { try await self.waitForServer(); return }
            self.phase = .creating
            let currentQuote = try await self.prepareQuote()
            guard currentQuote == approvedQuote else {
                self.phase = .readyToCreate
                self.message = "Условия установки обновились. Проверьте стоимость и подтвердите запуск ещё раз."
                return
            }
            guard var installation = self.state.installation else { throw DigitalOceanFailure.storage }
            let ownerHash = Self.hex(SHA256.hash(data: Data(installation.ownerToken.utf8)))
            let userData = try DigitalOceanBootstrap.userData(installationID: installation.id,
                privateKeyPEM: installation.privateKeyPEM, ownerTokenHash: ownerHash, releaseSHA256: currentQuote.releaseSHA256)
            guard userData.utf8.count <= 65_536 else { throw DigitalOceanFailure.release }
            let body: [String: Any] = ["name": installation.name, "region": currentQuote.region,
                "size": currentQuote.size, "image": "ubuntu-24-04-x64", "tags": [installation.name],
                "backups": false, "monitoring": false, "ipv6": false, "user_data": userData]
            let data = try JSONSerialization.data(withJSONObject: body)
            // Persist the receipt BEFORE POST. Even a crash immediately afterwards
            // is treated as an unknown outcome, never as permission to create again.
            installation.createAttemptedAt = Date()
            var next = self.state; next.installation = installation; try self.save(next)
            do {
                let result = try await self.api("/droplets", method: "POST", body: data)
                let response = try JSONDecoder().decode(DropletEnvelope.self, from: result)
                guard self.matches(response.droplet, installation) else { throw DigitalOceanFailure.ambiguousServer }
                next = self.state; next.installation?.dropletID = response.droplet.id; try self.save(next)
            } catch let error as DigitalOceanHTTPFailure where (400...499).contains(error.status) && error.status != 408 {
                // Explicit rejection proves no request was accepted. A retry still
                // requires a fresh visible quote and the user's confirmation.
                next = self.state; next.installation?.createAttemptedAt = nil; try self.save(next)
                throw error
            } catch {
                if Task.isCancelled { throw CancellationError() }
                throw DigitalOceanFailure.uncertainCreate
            }
            try await self.waitForServer()
        }
    }
    func cancel() { operation?.cancel(); browser.cancel() }

    private func perform(_ work: @escaping @MainActor () async throws -> Void) async {
        guard operation == nil else { return }
        let task = Task { @MainActor in
            defer { self.operation = nil }
            self.message = nil
            do {
                if let data = try self.store.load() { self.state = try JSONDecoder().decode(DigitalOceanSavedState.self, from: data) }
                else { self.state = .init() }
                try Task.checkCancellation()
                try await work()
            } catch {
                self.handle(error)
            }
        }
        operation = task
        await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    }
    private func save(_ next: DigitalOceanSavedState) throws {
        do { try store.save(JSONEncoder().encode(next)); state = next }
        catch { throw DigitalOceanFailure.storage }
    }

    private func authenticate() async throws {
        if state.registration == nil {
            let body: [String: Any] = ["redirect_uris": [DigitalOceanOAuth.callback],
                "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"], "client_name": "OpenStrudel", "client_uri": "https://waiwai.is/openstrudel"]
            let data = try await request(URL(string: "https://cloud.digitalocean.com/v1/oauth/register")!,
                                         method: "POST", body: JSONSerialization.data(withJSONObject: body))
            struct Registered: Decodable {
                let client_id: String; let registration_access_token: String; let registration_client_uri: String
            }
            let result = try JSONDecoder().decode(Registered.self, from: data)
            guard !result.client_id.isEmpty, !result.registration_access_token.isEmpty,
                  let uri = URLComponents(string: result.registration_client_uri), uri.scheme == "https",
                  uri.host == "cloud.digitalocean.com", uri.port == nil, uri.user == nil, uri.password == nil,
                  uri.path.hasPrefix("/v1/oauth/register/"), uri.query == nil, uri.fragment == nil
            else { throw DigitalOceanFailure.response }
            var next = state
            next.registration = .init(clientID: result.client_id, registrationAccessToken: result.registration_access_token,
                                      registrationClientURI: result.registration_client_uri)
            try save(next)
        }
        guard let registration = state.registration else { throw DigitalOceanFailure.storage }
        let pending = DigitalOceanSavedState.PendingOAuth(state: try DigitalOceanOAuth.random(), verifier: try DigitalOceanOAuth.random(), startedAt: Date())
        var next = state; next.pendingOAuth = pending; try save(next)
        var authorize = URLComponents(string: "https://cloud.digitalocean.com/v1/oauth/authorize")!
        authorize.queryItems = [URLQueryItem(name: "client_id", value: registration.clientID),
            .init(name: "redirect_uri", value: DigitalOceanOAuth.callback), .init(name: "response_type", value: "code"),
            .init(name: "scope", value: DigitalOceanOAuth.scopes), .init(name: "state", value: pending.state),
            .init(name: "code_challenge", value: DigitalOceanOAuth.challenge(pending.verifier)),
            .init(name: "code_challenge_method", value: "S256"), .init(name: "prompt", value: "select_account")]
        let callback = try await browser.open(authorize.url!)
        guard Date().timeIntervalSince(pending.startedAt) < 900 else { throw DigitalOceanFailure.signIn }
        let code = try DigitalOceanOAuth.code(from: callback, state: pending.state)
        // The authorization code is one-use; retain no resumable copy of it.
        next = state; next.pendingOAuth = nil; try save(next)
        try await exchange(["grant_type": "authorization_code", "code": code,
                            "client_id": registration.clientID, "code_verifier": pending.verifier,
                            "redirect_uri": DigitalOceanOAuth.callback])
    }

    private func exchange(_ parameters: [String: String]) async throws {
        var form = URLComponents()
        form.queryItems = parameters.sorted { $0.key < $1.key }.map { .init(name: $0.key, value: $0.value) }
        let body = Data((form.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8)
        let data = try await request(URL(string: "https://cloud.digitalocean.com/v1/oauth/token")!, method: "POST",
                                     body: body, contentType: "application/x-www-form-urlencoded")
        struct Token: Decodable {
            let access_token: String; let refresh_token: String; let token_type: String; let expires_in: Int; let scope: String?
        }
        let token = try JSONDecoder().decode(Token.self, from: data)
        let required = Set(DigitalOceanOAuth.scopes.split(separator: " "))
        guard token.token_type.lowercased() == "bearer", !token.access_token.isEmpty, !token.refresh_token.isEmpty,
              token.expires_in > 0, token.expires_in <= 86_400,
              token.scope.map({ required.isSubset(of: Set($0.split(separator: " "))) }) ?? true
        else { throw DigitalOceanFailure.signIn }
        var next = state
        next.tokens = .init(accessToken: token.access_token, refreshToken: token.refresh_token,
                            expiresAt: Date().addingTimeInterval(Double(token.expires_in)))
        try save(next)
    }

    private func accessToken() async throws -> String {
        guard let token = state.tokens else { throw DigitalOceanFailure.signIn }
        if token.expiresAt.timeIntervalSinceNow > 90 { return token.accessToken }
        guard let registration = state.registration else { throw DigitalOceanFailure.signIn }
        // Refresh tokens rotate and are one-use. If the response is lost, re-login
        // is safe; reusing the old refresh token is not.
        var next = state; next.tokens = nil; try save(next)
        do {
            try await exchange(["grant_type": "refresh_token", "refresh_token": token.refreshToken,
                                "client_id": registration.clientID])
        } catch { if Task.isCancelled { throw CancellationError() }; throw DigitalOceanFailure.signIn }
        guard let refreshed = state.tokens else { throw DigitalOceanFailure.signIn }
        return refreshed.accessToken
    }

    private func advance() async throws {
        if state.installation?.createAttemptedAt != nil {
            try await verifyAccount()
            try await waitForServer()
        } else {
            _ = try await prepareQuote()
            phase = .readyToCreate
        }
    }

    private struct AccountEnvelope: Decodable { let account: Account }
    private struct Account: Decodable {
        struct Team: Decodable { let uuid: String }
        let uuid: String; let email_verified: Bool; let status: String; let droplet_limit: Int?; let team: Team?
        var identity: String { team.map { "team:" + $0.uuid } ?? "account:" + uuid }
    }
    @discardableResult private func verifyAccount() async throws -> String {
        let account = try JSONDecoder().decode(AccountEnvelope.self, from: await api("/account")).account
        guard account.email_verified, account.status == "active", (account.droplet_limit ?? 0) > 0 else { throw DigitalOceanFailure.accountNotReady }
        if let installation = state.installation, installation.accountID != account.identity { throw DigitalOceanFailure.wrongAccount }
        return account.identity
    }

    private func prepareQuote() async throws -> Quote {
        let accountID = try await verifyAccount()
        struct Sizes: Decodable { let sizes: [DigitalOceanSize] }
        struct Regions: Decodable { let regions: [DigitalOceanRegion] }
        var sizes: [DigitalOceanSize] = []
        for page in 1...10 {
            let batch = try JSONDecoder().decode(Sizes.self, from: await api("/sizes?per_page=200&page=\(page)")).sizes
            sizes.append(contentsOf: batch)
            if batch.count < 200 { break }
        }
        let regions = try JSONDecoder().decode(Regions.self, from: await api("/regions?per_page=200")).regions
        let checksums = try await request(URL(string: "https://waiwai.is/openstrudel/downloads/SHA256SUMS")!)
        guard let text = String(data: checksums, encoding: .utf8) else { throw DigitalOceanFailure.release }
        let result = try Quote.make(sizes: sizes, regions: regions, releaseSHA256: Quote.releaseHash(from: text))
        var next = state
        if next.installation == nil {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw DigitalOceanFailure.storage }
            next.installation = .init(id: UUID().uuidString.lowercased(), accountID: accountID,
                privateKeyPEM: P256.Signing.PrivateKey().pemRepresentation, ownerToken: Self.hex(bytes), quote: result)
        } else { next.installation?.quote = result }
        try save(next); quote = result
        if result.region == "ams3" { message = "Франкфурт сейчас недоступен. Установим ту же конфигурацию в Амстердаме, в Евросоюзе." }
        return result
    }

    private struct DropletEnvelope: Decodable { let droplet: Droplet }
    private struct DropletsEnvelope: Decodable { let droplets: [Droplet] }
    private struct Droplet: Decodable {
        struct Networks: Decodable {
            struct V4: Decodable { let ip_address: String; let type: String }
            let v4: [V4]
        }
        let id: Int; let name: String; let status: String; let tags: [String]; let networks: Networks
    }
    private func matches(_ droplet: Droplet, _ installation: DigitalOceanSavedState.Installation) -> Bool {
        droplet.id > 0 && droplet.name == installation.name && droplet.tags.contains(installation.name)
    }
    private func waitForServer() async throws {
        guard let initial = state.installation, initial.createAttemptedAt != nil else { throw DigitalOceanFailure.storage }
        phase = .waitingForServer
        let deadline = Date().addingTimeInterval(900)
        for attempt in 0..<pollingAttempts {
            try Task.checkCancellation()
            guard let installation = state.installation else { throw DigitalOceanFailure.storage }
            let droplet: Droplet?
            if let id = installation.dropletID {
                do { droplet = try JSONDecoder().decode(DropletEnvelope.self, from: await api("/droplets/\(id)")).droplet }
                catch let error as DigitalOceanHTTPFailure where error.status == 404 { throw DigitalOceanFailure.missingServer }
            } else {
                let result = try JSONDecoder().decode(DropletsEnvelope.self, from: await api("/droplets?tag_name=\(installation.name)&per_page=200")).droplets
                guard result.count <= 1, result.allSatisfy({ matches($0, installation) }) else { throw DigitalOceanFailure.ambiguousServer }
                droplet = result.first
            }
            if let droplet {
                guard matches(droplet, installation) else { throw DigitalOceanFailure.ambiguousServer }
                if installation.dropletID == nil { var next = state; next.installation?.dropletID = droplet.id; try save(next) }
                if droplet.status == "active", let ip = droplet.networks.v4.first(where: { $0.type == "public" })?.ip_address {
                    guard DigitalOceanHomeTrust.isPublicIPv4(ip) else { throw DigitalOceanFailure.serverIdentity }
                    if let connected = try await connect(ip: ip, installation: installation) {
                        var next = state; next.installation?.connection = connected; try save(next)
                        connection = connected; phase = .connected; message = nil; return
                    }
                }
            }
            if attempt + 1 < pollingAttempts, Date() < deadline { try await Task.sleep(for: .seconds(10)) }
            else { break }
        }
        throw DigitalOceanFailure.uncertainCreate
    }

    private func connect(ip: String, installation: DigitalOceanSavedState.Installation) async throws -> HomeConnection? {
        let key = try P256.Signing.PrivateKey(pemRepresentation: installation.privateKeyPEM)
        let trust = DigitalOceanHomeTrust(host: ip, publicKey: key.publicKey.x963Representation)
        let session = trust.session()
        defer { session.invalidateAndCancel() }
        let baseURL = "https://\(ip):7789"
        var request = URLRequest(url: URL(string: baseURL + "/health")!)
        request.setValue("Bearer " + installation.ownerToken, forHTTPHeaderField: "Authorization")
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.url == request.url else { throw DigitalOceanFailure.serverIdentity }
            if http.statusCode == 401 || http.statusCode == 403 { throw DigitalOceanFailure.serverAuthentication }
            guard http.statusCode == 200, data.count <= 262_144 else { return nil }
            struct Health: Decodable { let ok: Bool; let service: String }
            let health = try JSONDecoder().decode(Health.self, from: data)
            guard health.ok, health.service == "openstrudel", let pin = trust.certificatePin else { throw DigitalOceanFailure.serverIdentity }
            return HomeConnection(url: baseURL, token: installation.ownerToken, pin: pin, name: "Моя команда")
        } catch {
            if Task.isCancelled { throw CancellationError() }
            if trust.identityRejected { throw DigitalOceanFailure.serverIdentity }
            if error is DigitalOceanFailure { throw error }
            // Connection refused/timeouts are expected while cloud-init starts Home.
            return nil
        }
    }

    private func api(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
        guard path.hasPrefix("/"), !path.contains("#"), let url = URL(string: "https://api.digitalocean.com/v2" + path), url.host == "api.digitalocean.com" else { throw DigitalOceanFailure.response }
        let token = try await accessToken()
        return try await request(url, method: method, body: body, bearer: token)
    }
    private func request(_ url: URL, method: String = "GET", body: Data? = nil, bearer: String? = nil,
                         contentType: String = "application/json") async throws -> Data {
        try Task.checkCancellation()
        guard url.scheme == "https", ["api.digitalocean.com", "cloud.digitalocean.com", "waiwai.is"].contains(url.host ?? ""),
              url.user == nil, url.password == nil, url.port == nil else { throw DigitalOceanFailure.response }
        var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let bearer {
            guard url.host == "api.digitalocean.com" else { throw DigitalOceanFailure.response }
            request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, http.url == url, data.count <= 2_097_152 else { throw DigitalOceanFailure.response }
        guard (200...299).contains(http.statusCode) else {
            let text = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["message"] as? String ?? ""
            let payment = http.statusCode == 402 || ["payment", "billing", "credit card", "balance"].contains(where: { text.lowercased().contains($0) })
            throw DigitalOceanHTTPFailure(status: http.statusCode, paymentRequired: payment)
        }
        return data
    }

    private func handle(_ error: Error) {
        if error is CancellationError || (error as? URLError)?.code == .cancelled {
            phase = .idle; message = state.installation?.createAttemptedAt == nil ? nil : "Настройка сохранена. Сервер продолжает работать; его оплата не останавливается при закрытии окна."
            return
        }
        phase = .failed
        if let failure = error as? DigitalOceanHTTPFailure {
            if failure.status == 401 { requireSignIn(); return }
            if failure.paymentRequired { phase = .billingRequired; message = "Завершите настройку оплаты в DigitalOcean и вернитесь сюда."; return }
            if failure.status == 403 { requireSignIn(); message = "DigitalOcean не предоставил доступ для установки. Войдите ещё раз и разрешите создание сервера."; return }
            if failure.status == 429 { message = "DigitalOcean просит немного подождать. Продолжите настройку через несколько минут."; return }
            message = "DigitalOcean пока не смог выполнить запрос. Настройка сохранена — продолжите немного позже."; return
        }
        switch error as? DigitalOceanFailure {
        case .storage: message = "Не удалось безопасно сохранить настройку. Разблокируйте устройство и попробуйте ещё раз."
        case .signIn, .callback: requireSignIn()
        case .accountNotReady: phase = .billingRequired; message = "Подтвердите почту и способ оплаты в DigitalOcean, затем продолжите настройку."
        case .unavailablePlan: message = "Подходящая конфигурация сейчас недоступна. Попробуйте позже — другой сервер автоматически не заказываем."
        case .release: message = "Не удалось проверить установку OpenStrudel. Попробуйте немного позже."
        case .wrongAccount: requireSignIn(); message = "Эта установка связана с другим аккаунтом или командой DigitalOcean. Войдите в тот аккаунт, с которого её начали."
        case .uncertainCreate: message = "Установка пока не ответила. Можно проверить подключение ещё раз. Если ожидание не помогает, откройте DigitalOcean, чтобы проверить установку или остановить оплату удалением. Повторная проверка не создаёт новую установку."
        case .missingServer: message = "Начатый сервер больше не найден в DigitalOcean. Проверьте его состояние в аккаунте провайдера."
        case .ambiguousServer, .serverIdentity: message = "Не удалось подтвердить, что это ваш сервер. Подключение остановлено; новый сервер не создаём."
        case .serverAuthentication: message = "Сервер найден, но пока не принимает сохранённое подключение. Продолжите настройку позже."
        default: message = "Не удалось закончить настройку. Проверьте интернет и продолжите — ваш прогресс сохранён."
        }
    }
    private func requireSignIn() {
        var next = state; next.tokens = nil; next.pendingOAuth = nil
        do { try save(next); phase = .idle; message = "Войдите в DigitalOcean, чтобы продолжить сохранённую настройку." }
        catch { phase = .failed; message = "Разблокируйте устройство, чтобы продолжить настройку." }
    }
    private static func hex(_ bytes: some Sequence<UInt8>) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
}

final class DigitalOceanNoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 60
        return URLSession(configuration: config, delegate: DigitalOceanNoRedirects(), delegateQueue: nil)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/// The server certificate is new, but its key is already known: generated on this
/// device and sent through the authenticated provider API. This is not TOFU.
final class DigitalOceanHomeTrust: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let host: String
    private let publicKey: Data
    private let lock = NSLock()
    private var pin: String?
    private var rejected = false
    var certificatePin: String? { lock.lock(); defer { lock.unlock() }; return pin }
    var identityRejected: Bool { lock.lock(); defer { lock.unlock() }; return rejected }
    init(host: String, publicKey: Data) { self.host = host; self.publicKey = publicKey }
    func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 20
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    static func matches(actualKey: Data, expectedKey: Data, host: String, expectedHost: String, port: Int) -> Bool {
        actualKey.count == 65 && actualKey.first == 4 && actualKey == expectedKey && host == expectedHost && port == 7789
    }
    static func isPublicIPv4(_ address: String) -> Bool {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let numbers = parts.compactMap { UInt8($0) }
        guard numbers.count == 4, zip(parts, numbers).allSatisfy({ String($0.1) == String($0.0) }) else { return false }
        let a = numbers[0], b = numbers[1]
        return a != 0 && a != 10 && a != 127 && a < 224 && !(a == 169 && b == 254)
            && !(a == 172 && (16...31).contains(b)) && !(a == 192 && b == 168)
            && !(a == 100 && (64...127).contains(b)) && !(a == 198 && (18...19).contains(b))
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = space.serverTrust, let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = chain.first, let key = SecCertificateCopyKey(certificate),
              let raw = SecKeyCopyExternalRepresentation(key, nil) as Data?,
              Self.matches(actualKey: raw, expectedKey: publicKey, host: space.host, expectedHost: host, port: space.port)
        else {
            lock.lock(); rejected = true; lock.unlock()
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        let hash = SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
        lock.lock(); pin = hash; lock.unlock()
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor final class DigitalOceanWebLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    typealias Completion = @Sendable (URL?, (any Error)?) -> Void
    private let makeSession: (URL, @escaping Completion) -> ASWebAuthenticationSession
    private var session: ASWebAuthenticationSession?
    private var sessionID: UUID?
    private var continuation: CheckedContinuation<URL, any Error>?

    init(makeSession: @escaping (URL, @escaping Completion) -> ASWebAuthenticationSession = {
        ASWebAuthenticationSession(url: $0, callbackURLScheme: "openstrudel", completionHandler: $1)
    }) {
        self.makeSession = makeSession
        super.init()
    }

    func open(_ url: URL) async throws -> URL {
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                self.sessionID = id
                // AuthenticationServices can complete on its XPC queue.
                // Keep this callback nonisolated, then hop to the UI actor.
                let session = makeSession(url) { @Sendable [weak self] url, error in
                    Task { @MainActor in
                        if let url { self?.finish(.success(url), for: id) }
                        else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { self?.finish(.failure(CancellationError()), for: id) }
                        else { self?.finish(.failure(DigitalOceanFailure.signIn), for: id) }
                    }
                }
                session.presentationContextProvider = self
                session.prefersEphemeralWebBrowserSession = false
                self.session = session
                if !session.start() { finish(.failure(DigitalOceanFailure.signIn), for: id) }
            }
        } onCancel: { Task { @MainActor in self.cancel(id) } }
    }
    func cancel() { if let id = sessionID { cancel(id) } }
    private func cancel(_ id: UUID) {
        guard sessionID == id else { return }
        session?.cancel(); finish(.failure(CancellationError()), for: id)
    }
    private func finish(_ result: Result<URL, any Error>, for id: UUID) {
        // A canceled browser can report back after the next sign-in starts.
        guard sessionID == id else { return }
        let pending = continuation; continuation = nil; session = nil; sessionID = nil
        pending?.resume(with: result)
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        #else
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        #endif
    }
}
