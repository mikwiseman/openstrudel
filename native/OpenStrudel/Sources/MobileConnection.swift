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
    static let storageFull = "На устройстве сотрудника закончилось место. Освободите место. Перед повторной отправкой проверьте, успел ли сотрудник выполнить задачу."

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
        if let keyPin = value("keyPin") {
            guard keyPin.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw HomeClientError.invalidURL }
            self.pin = "spki:" + keyPin
        } else { self.pin = pin }
        self.host = host; self.port = port; self.key = key
        let encodedName = parts.percentEncodedQueryItems?.first { $0.name == "name" }?.value
        let name = encodedName?.replacingOccurrences(of: "+", with: " ").removingPercentEncoding?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.name = String((name.isEmpty ? host.replacingOccurrences(of: ".local", with: "") : name).prefix(80))
    }
}

/// Trust the public key carried in the invitation. Certificate renewal keeps the
/// same key; expiry and host changes still fail. Legacy certificate pins remain valid.
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
        guard HomeCertificate.matches(certificate, pin: pin) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum HomeCertificate {
    private struct Element { let tag: UInt8; let start: Int; let content: Int; let end: Int }
    private static func element(_ bytes: [UInt8], at start: Int, limit: Int) -> Element? {
        guard start >= 0, start + 2 <= limit, limit <= bytes.count else { return nil }
        let tag = bytes[start], first = bytes[start + 1]
        var cursor = start + 2, length = Int(first)
        if first & 0x80 != 0 {
            let count = Int(first & 0x7f)
            guard (1...4).contains(count), cursor + count <= limit else { return nil }
            length = 0
            for _ in 0..<count { length = (length << 8) | Int(bytes[cursor]); cursor += 1 }
        }
        guard length <= limit - cursor else { return nil }
        return Element(tag: tag, start: start, content: cursor, end: cursor + length)
    }
    private static func children(_ bytes: [UInt8], of parent: Element) -> [Element]? {
        var cursor = parent.content, result: [Element] = []
        while cursor < parent.end {
            guard let child = element(bytes, at: cursor, limit: parent.end), child.end > cursor else { return nil }
            result.append(child); cursor = child.end
        }
        return result
    }
    private static func date(_ bytes: [UInt8], element: Element) -> Date? {
        guard [0x17, 0x18].contains(element.tag), var value = String(bytes: bytes[element.content..<element.end], encoding: .ascii) else { return nil }
        if element.tag == 0x17 {
            guard value.count == 13, let year = Int(value.prefix(2)) else { return nil }
            value = (year >= 50 ? "19" : "20") + value
        }
        guard value.count == 15, value.hasSuffix("Z") else { return nil }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "yyyyMMddHHmmss'Z'"; formatter.isLenient = false
        return formatter.date(from: value)
    }
    static func publicKeyAndValidity(_ data: Data) -> (key: Data, from: Date, until: Date)? {
        let bytes = [UInt8](data)
        guard let outer = element(bytes, at: 0, limit: bytes.count), outer.tag == 0x30,
              let tbs = element(bytes, at: outer.content, limit: outer.end), tbs.tag == 0x30,
              let fields = children(bytes, of: tbs) else { return nil }
        let offset = fields.first?.tag == 0xa0 ? 1 : 0
        guard fields.count > offset + 5, let dates = children(bytes, of: fields[offset + 3]), dates.count == 2,
              let from = date(bytes, element: dates[0]), let until = date(bytes, element: dates[1]) else { return nil }
        let key = fields[offset + 5]
        guard key.tag == 0x30 else { return nil }
        return (Data(bytes[key.start..<key.end]), from, until)
    }
    static func matches(_ certificate: SecCertificate, pin: String, at now: Date = Date()) -> Bool {
        let data = SecCertificateCopyData(certificate) as Data
        guard let parsed = publicKeyAndValidity(data), parsed.from <= now, now < parsed.until else { return false }
        let digest = SHA256.hash(data: pin.hasPrefix("spki:") ? parsed.key : data).map { String(format: "%02x", $0) }.joined()
        return digest == (pin.hasPrefix("spki:") ? String(pin.dropFirst(5)) : pin)
    }
}
