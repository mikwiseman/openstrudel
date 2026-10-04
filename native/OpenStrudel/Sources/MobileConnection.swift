import Foundation
import CryptoKit
import Security

enum HomeClientError: LocalizedError {
    case authenticationExpired
    case invalidURL
    case invalidResponse
    case server(String)
    case empty(String)

    var errorDescription: String? {
        switch self {
        case .authenticationExpired: return "Подключение отозвано. Создайте новое приглашение в OpenStrudel на компьютере."
        case .invalidURL: return "Не удалось открыть подключение. Используйте новое приглашение."
        case .invalidResponse: return "Не удалось получить ответ. Попробуйте ещё раз."
        case .server(let message): return UserFacingError.text(message)
        case .empty(let message): return message
        }
    }
}

enum UserFacingError {
    static let storageFull = "На основном Mac или сервере закончилось место. Освободите место. Перед повторной отправкой проверьте, успел ли сотрудник выполнить задачу."

    static func text(_ message: String) -> String {
        let normalized = message.lowercased()
        if normalized.contains("enospc") || normalized.contains("sqlite_full")
            || normalized.contains("no space left on device") || normalized.contains("database or disk is full") {
            return storageFull
        }
        if normalized.hasPrefix("codex не ответил") {
            return "Сотрудник не ответил вовремя. Перед повторной отправкой проверьте, успел ли он выполнить задачу."
        }
        if normalized.hasPrefix("связь с codex прервалась") {
            return "Связь с сотрудником прервалась. Перед повторной отправкой проверьте результат последней задачи."
        }
        if normalized.contains("workspace routing discovery unauthorized") {
            return "Нужно восстановить вход в OpenAI. Откройте настройки OpenStrudel. Ваши чаты и сотрудники сохранены."
        }
        return message
    }
}

struct MobileInvitation: Decodable {
    let url: URL
    let expiresAt: String

    func remainingSeconds(at date: Date) -> Int {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiry = formatter.date(from: expiresAt) else { return 0 }
        return max(0, Int(ceil(expiry.timeIntervalSince(date))))
    }
}

/// Store the destination, certificate and credential together in one Keychain write.
struct HomeConnection: Codable {
    let url: String
    let token: String
    let pin: String
    let name: String
}

struct MacPairing: Identifiable {
    let id = UUID()
    let host: String
    let port: Int
    let key: String
    let pin: String
    var baseURL: String { "https://\(host):\(port)" }
    let name: String

    init(url: URL) throws {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "openstrudel", parts.host == "connect",
              parts.path.isEmpty, parts.fragment == nil, parts.user == nil,
              parts.password == nil, parts.port == nil else { throw HomeClientError.invalidURL }
        let items = parts.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { throw HomeClientError.invalidURL }
        func value(_ key: String) -> String? { items.first { $0.name == key }?.value }
        guard let host = value("host"), host.count <= 253,
              host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({
                  !$0.isEmpty && $0.count <= 63 && $0.range(of: "^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$", options: .regularExpression) != nil
              }),
              let port = value("port").flatMap(Int.init), (1...65535).contains(port),
              let key = value("key"), key.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let pin = value("pin"), pin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        else { throw HomeClientError.server("Это не приглашение OpenStrudel. Создайте новое в настройках на компьютере.") }
        self.host = host; self.port = port; self.key = key; self.pin = pin
        let encodedName = parts.percentEncodedQueryItems?.first { $0.name == "name" }?.value
        let name = encodedName?.replacingOccurrences(of: "+", with: " ").removingPercentEncoding?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.name = String((name.isEmpty ? host.replacingOccurrences(of: ".local", with: "") : name).prefix(80))
    }
}

/// Trust exactly the certificate scanned from the user's Mac. Never accepts
/// another certificate, HTTP redirects, or a different destination host.
final class PinnedHomeSession: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    private let host: String
    private let port: Int
    private let pin: String

    init(host: String, port: Int, pin: String) { self.host = host.lowercased(); self.port = port; self.pin = pin }

    func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 600
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              space.host.lowercased() == host, space.port == port,
              let trust = space.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first
        else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        let actual = SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
        guard actual == pin else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
