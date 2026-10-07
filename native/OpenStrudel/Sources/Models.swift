import Foundation
import CryptoKit

enum HomeConnectionState { case idle, connecting, connected, unavailable }

enum HomeDrafts {
    static func key(home: String, profile: String?, chat: String?) -> String {
        home.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "\n" + (profile ?? "main") + ":" + (chat ?? "personal")
    }

    static func migrate(_ defaults: UserDefaults, currentHome: String) {
        guard !currentHome.isEmpty,
              let old = defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String] else { return }
        var scoped = old.filter { $0.key.contains("\n") }
        for (key, value) in old where !key.contains("\n") {
            let target = currentHome.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "\n" + key
            if scoped[target] == nil { scoped[target] = value }
        }
        if scoped != old { defaults.set(scoped, forKey: "openstrudel.drafts") }
    }
    static func relocate(_ defaults: UserDefaults, from oldHome: String, to newHome: String) {
        guard let old = defaults.dictionary(forKey: "openstrudel.drafts") as? [String: String] else { return }
        let prefix = oldHome.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "\n"
        let replacement = newHome.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) + "\n"
        var updated = old
        for (key, value) in old where key.hasPrefix(prefix) {
            let target = replacement + key.dropFirst(prefix.count)
            if updated[target] == nil { updated[target] = value }
        }
        defaults.set(updated, forKey: "openstrudel.drafts")
    }
}

struct HomeHealth: Decodable {
    let ok: Bool
    let platform: String?
    let arch: String?
    let service: String?
    let time: String?
    let telegram: TelegramStatus?
    let agentArchiveVersion: Int?
    var agentArchiveEncryption: Bool? = nil
    var homeProtocol: Int? = nil
    var homeId: String? = nil
    var nodeId: String? = nil
    var primaryId: String? = nil
    var agentAppearanceVersion: Int? = nil
    var deviceLogoutVersion: Int? = nil
}

struct HomeConversation: Decodable {
    let id: String
    let channel: String
    let externalId: String?
    let title: String?
    let codexThreadId: String?
    let createdAt: String
    let updatedAt: String
}

struct ConversationEnvelope: Decodable {
    let conversation: HomeConversation
    let messages: [HomeMessage]
    let interactions: [ChatInteraction]?
}

struct TelegramStatus: Codable {
    let configured: Bool
    let running: Bool
    let botUsername: String?
    let botName: String?
    let linkedChats: [String]
    let lastError: String?
    let chats: [TelegramChat]?
    var connectionError: String? = nil
    var lastCheckedAt: String? = nil
}
struct TelegramChat: Codable, Identifiable {
    let chatId: String
    let title: String
    let conversationId: String?
    let profileId: String?
    let allowedSenders: [String]
    var id: String { chatId }
}
struct ChatSchedule: Codable, Identifiable {
    let id: String
    let conversationId: String
    let name: String
    let prompt: String
    let cron: String
    let timezone: String
    let enabled: Bool
    let nextRunAt: String
    let telegramChatId: String?
    var delivery: String? = nil
    var timing: String {
        let fields = cron.split(separator: " ")
        if fields.count == 5, let minute = Int(fields[0]), let hour = Int(fields[1]), fields[2...] == ["*", "*", "*"] {
            return String(format: "Ежедневно в %02d:%02d", hour, minute) + " · " + timeZoneLabel
        }
        if fields.count == 5, let minute = Int(fields[0]), let hour = Int(fields[1]), fields[2] == "*", fields[3] == "*", let day = Int(fields[4]), (0...7).contains(day) {
            let names = ["По воскресеньям", "По понедельникам", "По вторникам", "По средам", "По четвергам", "По пятницам", "По субботам", "По воскресеньям"]
            return names[day] + String(format: " в %02d:%02d", hour, minute) + " · " + timeZoneLabel
        }
        return "Следующий выпуск · " + ((try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(nextRunAt))?.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(Locale(identifier: "ru_RU"))) ?? "по расписанию")
    }
    private var timeZoneLabel: String { timezone == "Europe/Moscow" ? "Москва" : timezone == "UTC" ? "UTC" : TimeZone(identifier: timezone)?.localizedName(for: .standard, locale: Locale(identifier: "ru_RU")) ?? timezone }
}
struct ScheduleRun: Decodable, Identifiable {
    let id: String
    let status: String
    let error: String?
}
struct SchedulesEnvelope: Decodable { let schedules: [ChatSchedule]; let runs: [ScheduleRun] }
struct ScheduleResponse: Decodable { let schedule: ChatSchedule }

struct TelegramEnvelope: Decodable {
    let telegram: TelegramStatus
}

struct TelegramLinkResponse: Decodable {
    let code: String
    let expiresAt: String
    let url: URL?
}

struct HomeMessage: Codable, Identifiable, Hashable {
    let id: String
    let conversationId: String
    let channel: String
    let direction: String
    let replyToId: String?
    let text: String
    let externalId: String?
    let createdAt: String
    let status: String?
    let error: String?
    let kind: String?
    var author: String? = nil
    var imported: Bool? = nil
    var attachments: [ChatAttachment]? = nil

    var scheduleTitle: String? {
        guard direction == "inbound", externalId?.hasPrefix("schedule:") == true else { return nil }
        let firstLine = text.components(separatedBy: "\n").first ?? ""
        return firstLine.hasPrefix("Scheduled request: ") ? String(firstLine.dropFirst("Scheduled request: ".count)) : "По расписанию"
    }

    /// Some imported history knows only the day, so it has no honest time.
    var hasTime: Bool { !(imported == true && createdAt.hasSuffix("T00:00:00.000Z")) }

    var sentAt: Date? {
        if hasTime { return try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(createdAt) }
        return try? Date.ISO8601FormatStyle(timeZone: .current).year().month().day().parse(String(createdAt.prefix(10)))
    }

    var time: String? { hasTime ? sentAt.map(ChatClock.time) : nil }
}

struct ChatAttachment: Codable, Hashable, Identifiable {
    let id: String
    let conversationId: String
    let name: String
    let mimeType: String
    let size: Int
    var icon: String { mimeType.hasPrefix("image/") ? "photo" : mimeType == "application/pdf" ? "doc.richtext" : mimeType.hasPrefix("audio/") ? "waveform" : "doc" }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file) }
}

struct PickedFile: Codable, Equatable, Identifiable, Sendable {
    var id = UUID()
    let name: String
    let mimeType: String
    let data: Data
}
struct AttachmentEnvelope: Decodable { let attachment: ChatAttachment }

/// Chat dates follow the Russian interface, whatever the system region.
enum ChatClock {
    private static let locale = Locale(identifier: "ru_RU")

    static func time(_ date: Date) -> String { date.formatted(.dateTime.hour().minute().locale(locale)) }

    static func day(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Сегодня" }
        if calendar.isDateInYesterday(date) { return "Вчера" }
        let style = Date.FormatStyle.dateTime.day().month(.wide).locale(locale)
        return date.formatted(calendar.isDate(date, equalTo: .now, toGranularity: .year) ? style : style.year())
    }
}

struct PendingHomeMessage: Codable, Identifiable, Equatable {
    var id = UUID()
    let text: String
    var profileID: String?
    var conversationID: String? = nil
    var error: String? = nil
    var files: [PickedFile] = []
    var draftDomain: String = "personal"
    var deviceID: String? = nil
    var deliveryState: String? = nil
    var operationID: String? = nil
    var appearance: AgentAppearance? = nil
}

enum PendingMessagesFile {
    static func url(directory: URL, home: String) -> URL {
        let key = SHA256.hash(data: Data(home.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appending(path: key + ".json")
    }
    static func save(_ messages: [PendingHomeMessage], directory: URL, home: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(messages)
        guard data.count <= 128 * 1024 * 1024 else { throw HomeClientError.server("Слишком много неотправленных файлов. Дождитесь их доставки.") }
        let file = url(directory: directory, home: home)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
    static func read(directory: URL, home: String) throws -> [PendingHomeMessage] {
        let file = url(directory: directory, home: home)
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size <= 128 * 1024 * 1024 else { throw HomeClientError.invalidResponse }
        return try JSONDecoder().decode([PendingHomeMessage].self, from: Data(contentsOf: file))
    }
}

struct EmployeeProfile: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let instructions: String
    let capabilities: [String]
    let model: String?
    let tokenLimit: Int?
    let createdAt: String
    var preview: String? = nil
    var domain: String? = nil
    var purpose: String? = nil
    var deviceId: String? = nil
    var appearance: AgentAppearance? = nil

    var isWork: Bool { domain == "work" }
    var roleText: String { purpose?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" }

    var previewText: String {
        guard let firstLine = preview?.split(separator: "\n").first else { return "" }
        let plain = (try? AttributedString(markdown: String(firstLine))) ?? AttributedString(String(firstLine))
        return String(plain.characters)
    }
}

struct ProfilesEnvelope: Decodable {
    let profiles: [EmployeeProfile]
    let importedConversations: [ImportedConversation]?
}

struct ImportedConversation: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let profileId: String
}

struct ProfileResponse: Decodable {
    let profile: EmployeeProfile
}

struct HomeMessageResponse: Decodable {
    let conversationId: String
    let messageId: String
    let text: String
    let profileId: String?
    let operationId: String?
    let deliveryState: String?
}

struct HomeEndpoint: Codable, Equatable { let url: String; let pin: String? }
struct HomeDevice: Decodable, Identifiable {
    let id: String; let name: String; let platform: String; let primary: Bool; let online: Bool; let agents: Int
    let endpoint: HomeEndpoint?
}
struct HomeDevices: Decodable { let devices: [HomeDevice]; let primaryId: String }
struct HomeManagement: Decodable {
    struct State: Decodable { let id: String; let nodeId: String; let primaryId: String; let role: String; let name: String; let epoch: Int; let mainNodeId: String? }
    let home: State; let devices: [HomeDevice]; let operations: [HomeTransferOperation]?
}
struct ManagedCodexAccount: Decodable, Identifiable {
    struct Usage: Decodable {
        struct Window: Decodable, Identifiable {
            let name: String; let remainingPercent: Double?; let windowDurationMins: Int?; let resetsAt: Double?
            var id: String { name }
            var displayName: String {
                switch windowDurationMins { case 300: return "5 часов"; case 10080: return "Неделя"; case 1440: return "Сутки"; default: return name }
            }
        }
        struct Credits: Decodable { let hasCredits: Bool; let unlimited: Bool; let balance: String? }
        var credits: Credits? = nil
        let checkedAt: String; let ordinaryUsageAllowed: Bool?; let windows: [Window]; let unavailable: Bool?
    }
    let id: String; let name: String; let account: OpenAIAccount; let usage: Usage; let activeRuns: Int; let loginPending: Bool
}
struct ManagedCodexAccounts: Decodable { let accounts: [ManagedCodexAccount]; let canManage: Bool }
struct HomeActionResult: Decodable { let ok: Bool?; let status: String?; let operationId: String? }
struct HomeRequestStatus: Decodable {
    let status: String
    let response: Response?
    struct Response: Decodable { let status: Int; let body: String }
}
struct HomeBackup: Decodable { let archive: String }
struct HomeTransferOperation: Decodable, Identifiable {
    let id: String; let phase: String; let error: String?; let backup: String?; let endpoint: HomeEndpoint?
    var kind: String? = nil
    var warnings: [String]? = nil
    var isFinished: Bool { ["completed", "active", "canceled"].contains(phase) }
    var phaseDescription: String {
        switch phase {
        case "waiting": return "Ждём завершения принятых поручений"
        case "preparing": return "Готовим копию"
        case "staging": return "Проверяем копию на новом устройстве"
        case "releasing", "transferred": return "Передаём управление"
        case "activating": return "Включаем на новом устройстве"
        case "canceling": return "Отменяем подготовку"
        case "completed", "active": return "Перенос завершён"
        case "canceled": return "Подготовка отменена"
        case "attention", "activation_failed": return "Нужна проверка устройств"
        default: return "Проверяем состояние переноса"
        }
    }
}
struct HomeMoved: Decodable { let url: String; let pin: String?; let homeId: String; let primaryId: String; let epoch: Int }
struct HomeFailure: Decodable { let error: String?; let moved: HomeMoved? }
struct HomePeerIdentity: Decodable { let homeId: String; let nodeId: String; let protocolVersion: Int; let role: String; let epoch: Int
    enum CodingKeys: String, CodingKey { case homeId, nodeId, role, epoch; case protocolVersion = "protocol" }
}

struct OpenAIAccount: Decodable, Equatable {
    let connected: Bool
    let email: String?
    let planType: String?
    let managed: Bool
    var issue: String? = nil

    var planLabel: String {
        switch planType?.lowercased() {
        case "plus": return "ChatGPT Plus"
        case "pro": return "ChatGPT Pro"
        case "team", "business": return "ChatGPT Business"
        case "enterprise": return "ChatGPT Enterprise"
        case "free": return "ChatGPT Free"
        default: return "OpenAI подключён"
        }
    }
    var needsSignInAgain: Bool { issue == "sign_in_required" }
    var isUnavailable: Bool { issue == "unavailable" }
}

struct OpenAIAccountEnvelope: Decodable {
    let account: OpenAIAccount
    var canManage: Bool? = nil
    var loginPending: Bool? = nil
}

struct OpenAILogin: Decodable, Identifiable, Equatable {
    let type: String
    let loginId: String
    let authUrl: String?
    let verificationUrl: String?
    let userCode: String?

    var id: String { loginId }
    var url: URL? {
        URL(string: type == "device" ? (verificationUrl ?? "") : (authUrl ?? ""))
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decode(String.self, forKey: .type)
        loginId = try values.decode(String.self, forKey: .loginId)
        authUrl = try values.decodeIfPresent(String.self, forKey: .authUrl)
        verificationUrl = try values.decodeIfPresent(String.self, forKey: .verificationUrl)
        userCode = try values.decodeIfPresent(String.self, forKey: .userCode)
    }

    private enum CodingKeys: String, CodingKey { case type, loginId, authUrl, verificationUrl, userCode }
}

struct OpenAILoginStatus: Decodable, Equatable {
    let loginId: String
    let status: String
    let error: String?
    let account: OpenAIAccount?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        loginId = try values.decode(String.self, forKey: .loginId)
        status = try values.decode(String.self, forKey: .status)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        account = try values.decodeIfPresent(OpenAIAccount.self, forKey: .account)
    }

    private enum CodingKeys: String, CodingKey { case loginId, status, error, account }
}

struct ServiceConnection: Decodable, Identifiable {
    var icon: String {
        switch id {
        case "mcp:cua_repl": return "desktopcomputer"
        case "mcp:wai_company": return "briefcase"
        case "mcp:wai_personal": return "person.crop.circle"
        case "mcp:creative_production_mcp": return "paintpalette"
        case "mcp:wai_telegram": return "paperplane"
        default: return "link"
        }
    }
    let id: String
    let name: String
    let kind: String
    let connected: Bool
    let detail: String?
    let url: String?
}
struct ConnectionsEnvelope: Decodable { let connections: [ServiceConnection]; let notice: String? }
struct ConnectionLink: Decodable { let url: String? }
struct ChatInteraction: Decodable, Identifiable, Equatable {
    let id: String
    let conversationId: String
    let messageId: String
    let title: String
    let detail: String?
    let url: String?
    let questions: [ChatQuestion]
}
struct ChatQuestion: Decodable, Identifiable, Equatable {
    let id: String
    let question: String
    let options: [String]
}
