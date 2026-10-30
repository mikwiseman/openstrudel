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
    var employeeTransferVersion: Int? = nil
    var homeProtocol: Int? = nil
    var homeId: String? = nil
    var nodeId: String? = nil
    var primaryId: String? = nil
    var agentAppearanceVersion: Int? = nil
    var deviceLogoutVersion: Int? = nil
    var turnControlVersion: Int? = nil
    var speechVersion: Int? = nil
    var diagnosticsVersion: Int? = nil
    var conversationModelsVersion: Int? = nil
    var queueControlVersion: Int? = nil
    var employeeTimelineVersion: Int? = nil
    var employeeRenameKeepsInstructions: Int? = nil
    var deviceRenameVersion: Int? = nil
    var colleagueInvitesVersion: Int? = nil
    var ownerInvitesVersion: Int? = nil
    var providers: Int? = nil
    /// 1: the Grok subscription, signed in on the device.
    var subscriptionsVersion: Int? = nil
    /// 1: an employee can answer the bot's private chat, which keeps answering after the switch back.
    var telegramPrivateChoiceVersion: Int? = nil
}

struct HomeConversation: Decodable {
    var effectiveModel: ModelSelection? = nil
    /// Present when the chat has News stories; changes whenever the reader has something new.
    var news: String? = nil
    let id: String
    let channel: String
    let externalId: String?
    let title: String?
    let codexThreadId: String?
    let createdAt: String
    let updatedAt: String
}

struct MessagePagination: Decodable {
    let olderCursor: String?
    let newerCursor: String?
    let hasMore: Bool
}

struct ConversationEnvelope: Decodable {
    let conversation: HomeConversation
    let messages: [HomeMessage]
    let interactions: [ChatInteraction]?
    var pagination: MessagePagination? = nil
    var updates: [HomeMessage]? = nil
    var queuedMessages: [HomeMessage]? = nil
    var timeline: Bool? = nil
    var removedIds: [String]? = nil
}

struct MessageQueueEnvelope: Decodable { let queuedMessages: [HomeMessage] }

/// One event as News told it at one moment. Later developments are new versions with the same id.
struct NewsStory: Codable, Hashable {
    struct Source: Codable, Hashable { let title: String; let url: String; let role: String; let publishedAt: String? }
    let id: String
    let edition: String?
    let rank: Int?
    let section: String
    let status: String
    let title: String
    let summary: String
    let body: String
    let view: String?
    let check: String?
    let verification: String
    let eventAt: String?
    let change: String?
    let sources: [Source]
}

struct NewsFeedEnvelope: Decodable { let messages: [HomeMessage]; let stamp: String? }

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
    var access: String? = nil
    var replies: String? = nil
    var enabled: Bool? = nil
    var id: String { chatId }
    var isGroup: Bool { chatId.hasPrefix("-") }
    var isPairedOwner: Bool { !isGroup && allowedSenders.contains(chatId) }
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
    var lastRunStatus: String? = nil
    var isOneTime: Bool { cron.hasPrefix("@once ") }
    var oneTimeResult: String? {
        guard isOneTime, !enabled, let lastRunStatus else { return nil }
        switch lastRunStatus {
        case "completed", "quiet": return L("Выполнено")
        case "running": return L("Выполняется")
        case "ready": return L("Ожидает доставки")
        case "failed": return L("Не выполнено")
        case "skipped": return L("Пропущено")
        case "uncertain": return L("Проверьте результат")
        default: return nil
        }
    }
    var timing: String {
        if isOneTime { return L("Разово · ") + nextTime }
        let fields = cron.split(separator: " ")
        if fields.count == 5, let minute = Int(fields[0]), let hour = Int(fields[1]), fields[2...] == ["*", "*", "*"] {
            return String(format: L("Ежедневно в %02d:%02d"), hour, minute) + " · " + timeZoneLabel
        }
        if fields.count == 5, let minute = Int(fields[0]), let hour = Int(fields[1]), fields[2] == "*", fields[3] == "*", let day = Int(fields[4]), (0...7).contains(day) {
            let names = [L("По воскресеньям"), L("По понедельникам"), L("По вторникам"), L("По средам"), L("По четвергам"), L("По пятницам"), L("По субботам"), L("По воскресеньям")]
            return names[day] + String(format: L(" в %02d:%02d"), hour, minute) + " · " + timeZoneLabel
        }
        return L("Следующий выпуск · ") + nextTime
    }
    private var nextTime: String {
        guard let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(nextRunAt) else { return L("по расписанию") }
        var style = Date.FormatStyle.dateTime.day().month(.abbreviated).hour().minute().locale(L10n.locale)
        style.timeZone = TimeZone(identifier: timezone) ?? .gmt
        return date.formatted(style) + " · " + timeZoneLabel
    }
    private var timeZoneLabel: String { timezone == "Europe/Moscow" ? L("Москва") : timezone == "UTC" ? "UTC" : TimeZone(identifier: timezone)?.localizedName(for: .standard, locale: L10n.locale) ?? timezone }
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
    var expiryDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
    }
}
struct TelegramLinkState: Decodable {
    let status: String
    let error: String?
}

struct MessageOrigin: Codable, Hashable {
    let channel: String
    let title: String
    var chatId: String? = nil
    var url: String? = nil
    var canReply: Bool? = nil
}

struct MessageDelivery: Codable, Hashable {
    let state: String
    var error: String? = nil
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
    var origin: MessageOrigin? = nil
    var delivery: MessageDelivery? = nil
    /// A version of a News story; `text` is the same story as Markdown for the chat.
    var story: NewsStory? = nil
    /// The story this message belongs to: a version, or a question and answer about it.
    var storyId: String? = nil

    var scheduleTitle: String? {
        guard direction == "inbound", externalId?.hasPrefix("schedule:") == true else { return nil }
        let firstLine = text.components(separatedBy: "\n").first ?? ""
        return firstLine.hasPrefix("Scheduled request: ") ? String(firstLine.dropFirst("Scheduled request: ".count)) : L("По расписанию")
    }

    /// Some imported history knows only the day, so it has no honest time.
    var hasTime: Bool { !(imported == true && createdAt.hasSuffix("T00:00:00.000Z")) }

    var sentAt: Date? {
        if hasTime { return try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(createdAt) }
        return try? Date.ISO8601FormatStyle(timeZone: .current).year().month().day().parse(String(createdAt.prefix(10)))
    }

    var time: String? { hasTime ? sentAt.map(ChatClock.time) : nil }
}

/// A Form gives a modifier on several rows to every row, so a settings view's `.task` also runs for each
/// row that appears later. Loading again then would reset what the person is choosing; load once per key.
struct LoadedKey<Key: Equatable> {
    private var key: Key?
    private var loaded = false
    /// True the first time for each key.
    mutating func claim(_ next: Key) -> Bool {
        if loaded && key == next { return false }
        key = next; loaded = true
        return true
    }
}

struct ChatAttachment: Codable, Hashable, Identifiable {
    let id: String
    let conversationId: String
    let name: String
    let mimeType: String
    let size: Int
    var icon: String { mimeType.hasPrefix("image/") ? "photo" : mimeType == "application/pdf" ? "doc.richtext" : mimeType.hasPrefix("audio/") ? "waveform" : "doc" }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file) }
    /// Homes issue 36-character ids of hex digits and dashes; a download folder is named by one.
    static func isHomeFileID(_ id: String) -> Bool {
        id.count == 36 && id.allSatisfy { $0.isHexDigit || $0 == "-" }
    }
}

struct PickedFile: Codable, Equatable, Identifiable, Sendable {
    var id = UUID()
    let name: String
    let mimeType: String
    let data: Data
}
struct AttachmentEnvelope: Decodable { let attachment: ChatAttachment }

/// Chat dates follow the selected interface language.
enum ChatClock {
    private static var locale: Locale { L10n.locale }

    static func time(_ date: Date) -> String { date.formatted(.dateTime.hour().minute().locale(locale)) }

    static func day(_ date: Date) -> String {
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return L("Сегодня") }
        if calendar.isDateInYesterday(date) { return L("Вчера") }
        let style = Date.FormatStyle.dateTime.day().month(.wide).locale(locale)
        return date.formatted(calendar.isDate(date, equalTo: .now, toGranularity: .year) ? style : style.year())
    }

    /// A time-cluster heading: "Today, 12:02", or the day alone when history kept no time.
    static func cluster(_ date: Date, hasTime: Bool) -> String {
        hasTime ? day(date) + ", " + time(date) : day(date)
    }

    /// The full moment for the Mac tooltip and VoiceOver.
    static func exact(_ date: Date, hasTime: Bool) -> String {
        let style = Date.FormatStyle.dateTime.weekday(.wide).day().month(.wide).year().locale(locale)
        return date.formatted(hasTime ? style.hour().minute() : style)
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
    var mode: ComposerSendMode? = nil
    var telegramReplyToID: String? = nil
    var telegramChatTitle: String? = nil
    /// A question from a News story's reader: the story version it asks about.
    var storyReplyToID: String? = nil
}

enum ComposerSendMode: String, Codable, CaseIterable {
    case steer, queue
    var title: String { self == .steer ? L("Уточнить сейчас") : L("После ответа") }
}

enum PendingMessagesFile {
    static func url(directory: URL, home: String) -> URL {
        let key = SHA256.hash(data: Data(home.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appending(path: key + ".json")
    }
    static func save(_ messages: [PendingHomeMessage], directory: URL, home: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(messages)
        guard data.count <= 128 * 1024 * 1024 else { throw HomeClientError.server(L("Слишком много неотправленных файлов. Дождитесь их доставки.")) }
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
    var serviceTier: String? = nil
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
    var telegram: TelegramStatus? = nil
}

struct ImportedConversation: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let profileId: String?
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
struct HomeDevice: Decodable, Identifiable, Equatable {
    let id: String; let name: String; let platform: String; let primary: Bool; let online: Bool; let agents: Int
    let endpoint: HomeEndpoint?
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id); name = deviceTitle(try values.decode(String.self, forKey: .name))
        platform = try values.decode(String.self, forKey: .platform); primary = try values.decode(Bool.self, forKey: .primary)
        online = try values.decode(Bool.self, forKey: .online); agents = try values.decode(Int.self, forKey: .agents)
        endpoint = try values.decodeIfPresent(HomeEndpoint.self, forKey: .endpoint)
    }
    private enum CodingKeys: String, CodingKey { case id, name, platform, primary, online, agents, endpoint }
}

/// A Home's shared name as people read it: the server default in the interface
/// language, and a Mac's network hostname without its ".local" suffix. An older
/// server Home still names itself by its container ID, which reads as the default.
func deviceTitle(_ name: String, language: AppLanguage? = nil) -> String {
    if name == "Server" || name.range(of: "^[a-f0-9]{12}([a-f0-9]{52})?$", options: [.regularExpression, .caseInsensitive]) != nil {
        return L10n.text("Server", language: language)
    }
    return name.count > 6 && name.lowercased().hasSuffix(".local") ? String(name.dropLast(6)) : name
}

/// A device paired with this Home, as its owner sees it in Settings.
struct MobileClient: Decodable, Identifiable, Equatable {
    let id: String
    var label: String? = nil
    var role: String? = nil
    var pairedAt: String? = nil
    var current: Bool? = nil
    var isColleague: Bool { role == "colleague" }
    /// Any other device, an owner's lost phone included. The Home refuses the one asking.
    var canDisconnect: Bool { current != true }
    var pairedDate: Date? {
        guard let pairedAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: pairedAt) ?? ISO8601DateFormatter().date(from: pairedAt)
    }
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
                switch windowDurationMins { case 300: return L("5 часов"); case 10080: return L("Неделя"); case 1440: return L("Сутки"); default: return name }
            }
        }
        struct Credits: Decodable { let hasCredits: Bool; let unlimited: Bool; let balance: String? }
        struct ResetCredits: Decodable { let availableCount: Int; let nextExpiresAt: Double? }
        var credits: Credits? = nil
        var resetCredits: ResetCredits? = nil
        let checkedAt: String; let ordinaryUsageAllowed: Bool?; let windows: [Window]; let unavailable: Bool?
    }
    let id: String; let name: String; let account: OpenAIAccount; let usage: Usage; let activeRuns: Int; let loginPending: Bool
    var displayName: String? = nil
    var title: String {
        if let displayName { return displayName }
        return ["Основной", "Аккаунт", "OpenAI", "Account", "ChatGPT", ""].contains(name) ? account.email ?? "ChatGPT" : name
    }
    var emailDetail: String? { account.email == title ? nil : account.email }
    var identityLabel: String { [title, account.planLabel].joined(separator: " · ") }
}
struct ManagedCodexAccounts: Decodable { let accounts: [ManagedCodexAccount]; let canManage: Bool }
extension [ManagedCodexAccount] {
    /// Limits and credits belong to a signed-in ChatGPT account, also one OpenAI cannot confirm right now.
    var hasUsage: Bool { contains { $0.account.connected || $0.account.isUnavailable } }
}

/// Who powers employees on a device: ChatGPT sign-in or an API key, which never comes back from the Home.
struct ProviderSummary: Decodable, Identifiable, Equatable {
    let id: String; let name: String; let auth: String; let connected: Bool
    /// `••••7Qa`: the key itself never leaves its device.
    let keyHint: String?; let keysUrl: String?; let usedBy: Int
    var canAddKey: Bool { auth == "key" && !connected }
    var connectedKey: Bool { auth == "key" && connected }
    /// Grok signs in inside its own agent on the device; ChatGPT has its own accounts.
    var isSubscription: Bool { auth == "signin" && id != "chatgpt" }
    /// `usedBy` counts employees, the main chat and the device default together, so it is not a number of employees.
    var removalWarning: String { L("Сотрудников и настроек на этом ключе: \(usedBy). Их модель станет «Как на устройстве» или «Автоматически».") }
    var signOutWarning: String { L("Сотрудников и настроек на этой подписке: \(usedBy). Их модель станет «Как на устройстве» или «Автоматически».") }
}
struct ProviderList: Decodable {
    let providers: [ProviderSummary]; let canManage: Bool
    /// Codex reviews actions only on ChatGPT. With every model on a key the device asks instead.
    var reviewsAutomatically: Bool { providers.contains { $0.id == "chatgpt" && $0.usedBy > 0 } }
}
/// The key sheet's field: a new key clears the provider's answer about the old one.
struct ProviderKeyEntry {
    var key = "" { didSet { if key != oldValue { error = nil } } }
    var error: String?
    var busy = false
    var ready: Bool { !busy && !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

struct ModelSelection: Codable, Hashable {
    /// Nil from older Homes, and with a nil model: as on the device, or automatic for the device itself.
    var provider: String? = nil
    let model: String?
    let serviceTier: String?
    var reasoningEffort: String? = nil
    var ref: ModelRef? { model.map { ModelRef(provider: provider, model: $0) } }
}
/// A model is unique only within its provider: ChatGPT and an OpenAI API key share model ids.
struct ModelRef: Hashable { let provider: String?; let model: String }
struct ModelChoice: Decodable, Identifiable {
    struct Speed: Decodable, Identifiable { let id: String; let name: String; let description: String }
    let id: String
    let name: String
    let description: String
    let isDefault: Bool
    let defaultReasoningEffort: String?
    var reasoningEfforts: [Speed]? = nil
    let speeds: [Speed]
    var provider: String? = nil
    var ref: ModelRef { ModelRef(provider: provider, model: id) }
}
struct ModelSettings: Decodable {
    let models: [ModelChoice]
    let selection: ModelSelection
    let defaults: ModelSelection
    let effective: ModelSelection
    let recommended: ModelChoice?
    let canManage: Bool
    var fallbacks: [ModelSelection]? = nil
    /// Direct chats on the device's model run at Fast where the model offers it. Older Homes send none.
    var directFast: Bool? = nil
    /// Connected providers, ChatGPT first. Older Homes send none.
    var providers: [ProviderSummary]? = nil

    struct Group: Identifiable { let provider: ProviderSummary?; let models: [ModelChoice]; var id: String { provider?.id ?? "" } }
    /// The picker's groups: one per connected provider once there are several, otherwise one unnamed list.
    var groups: [Group] {
        guard let providers, providers.count > 1 else { return [Group(provider: nil, models: models)] }
        return providers.map { provider in Group(provider: provider, models: models.filter { $0.provider == provider.id }) }.filter { !$0.models.isEmpty }
    }
    func model(_ ref: ModelRef?) -> ModelChoice? { models.first { $0.ref == ref } }
    /// With several providers a name alone is ambiguous: ChatGPT and an OpenAI key share models, OpenRouter repeats vendors' names,
    /// and the Grok subscription shares xAI's: "Grok 4.7 · подписка Grok" beside "Grok 4.7 · xAI".
    func title(_ model: ModelChoice) -> String {
        guard let providers, providers.count > 1, let provider = providers.first(where: { $0.id == model.provider }) else { return model.name }
        return model.name + " · " + (provider.isSubscription ? L("подписка \(provider.name)") : provider.name)
    }
    /// Only OpenAI's catalog marks its own default; for another provider the recommended model is our pick.
    func recommendation(_ model: ModelChoice) -> String {
        !model.isDefault ? L("Модель по умолчанию") : [nil, "chatgpt", "openai"].contains(model.provider) ? L("Рекомендует OpenAI") : L("Рекомендуем")
    }
    /// An OpenAI account choice applies only on ChatGPT; older Homes know nothing else.
    var runsOnChatGPT: Bool { (effective.provider ?? "chatgpt") == "chatgpt" }
}
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
        case "waiting": return L("Ждём завершения принятых поручений")
        case "preparing": return L("Готовим копию")
        case "staging": return L("Проверяем копию на новом устройстве")
        case "releasing", "transferred": return L("Передаём управление")
        case "activating": return L("Включаем на новом устройстве")
        case "canceling": return L("Отменяем подготовку")
        case "completed", "active": return L("Перенос завершён")
        case "canceled": return L("Подготовка отменена")
        case "attention", "activation_failed": return L("Нужна проверка устройств")
        default: return L("Проверяем состояние переноса")
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
    let managed: Bool?
    var issue: String? = nil
    /// The agent's provider; absent from older Homes, which know only ChatGPT.
    var provider: String? = nil
    var providerName: String? = nil

    /// The API-key provider this account stands for, by name; nil for ChatGPT.
    var keyProviderName: String? { provider.flatMap { $0 == "chatgpt" ? nil : providerName ?? $0 } }
    /// Grok signs in again; a key provider needs its key.
    var signsIn: Bool { provider == "grok" }
    var providerNeed: String? { keyProviderName.map { signsIn ? L("Нужен вход в \($0)") : L("Нужен ключ \($0)") } }

    var planLabel: String {
        switch planType?.lowercased() {
        case "plus": return "ChatGPT Plus"
        case "pro": return "ChatGPT Pro"
        case "promax": return "ChatGPT Pro Max"
        case "prolite": return "ChatGPT Pro Lite"
        case "go": return "ChatGPT Go"
        case "team", "business", "self_serve_business_prolite", "self_serve_business_usage_based": return "ChatGPT Business"
        case "enterprise", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based": return "ChatGPT Enterprise"
        case "edu", "edu_plus", "edu_pro": return "ChatGPT Edu"
        case "free": return "ChatGPT Free"
        default: return "ChatGPT"
        }
    }
    var isWorkspace: Bool? {
        switch planType?.lowercased() {
        case "free", "go", "plus", "pro", "prolite", "promax": false
        case "team", "business", "self_serve_business_prolite", "self_serve_business_usage_based",
             "enterprise", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based", "edu", "edu_plus", "edu_pro": true
        default: nil
        }
    }
    var categoryLabel: String? {
        isWorkspace.map { $0 ? L("Workspace account") : L("Personal account") }
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
    let alreadyConnected: Bool?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        loginId = try values.decode(String.self, forKey: .loginId)
        status = try values.decode(String.self, forKey: .status)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        account = try values.decodeIfPresent(OpenAIAccount.self, forKey: .account)
        alreadyConnected = try values.decodeIfPresent(Bool.self, forKey: .alreadyConnected)
    }

    private enum CodingKeys: String, CodingKey { case loginId, status, error, account, alreadyConnected }
}

struct ServiceConnection: Decodable, Identifiable {
    var isAvailableToAdd: Bool { kind == "app" && !connected && (status == "available" || status == "sign_in") }
    var actionTitle: String {
        if status == "available" { return L("Добавить") }
        if status == "unknown" || status == "unavailable" { return L("Проверить") }
        return L("Подключить")
    }
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
    var status: String? = nil
    var toolCount: Int? = nil
    var removable: Bool? = nil
}
struct ConnectionsEnvelope: Decodable { let connections: [ServiceConnection]; let notice: String? }
struct EmployeeExtension: Decodable, Identifiable {
    let id: String
    let name: String
    let description: String
    let kind: String
    let enabled: Bool
    let removable: Bool
}
struct ExtensionsEnvelope: Decodable { let items: [EmployeeExtension]; let notice: String? }
struct ExtensionContext: Decodable, Identifiable { let id: String; let title: String; let isGroup: Bool; var sharedNotice: String? = nil }
struct ExtensionContextsEnvelope: Decodable { let contexts: [ExtensionContext] }
struct ExtensionFile: Encodable, Sendable { let path: String; let contentBase64: String; let executable: Bool }
struct ExtensionPreview: Decodable {
    let kind: String
    let name: String
    let description: String
    let files: Int
    let bytes: Int
    let digest: String
    let services: [String]
    let hasHooks: Bool
    let replaces: String?
}
struct ConnectionLink: Decodable { let url: String?; let signInId: String? }

enum ServiceOAuthCallback {
    static func accepts(_ url: URL, signInID: String) -> Bool {
        guard signInID.range(of: "^[a-f0-9]{48}$", options: .regularExpression) != nil,
              url.scheme == "openstrudel", url.host == "oauth", url.port == nil,
              url.user == nil, url.password == nil, url.fragment == nil else { return false }
        let base = "/service/" + signInID
        return url.path == base || url.path.hasPrefix(base + "/")
    }
}
struct ChatInteraction: Decodable, Identifiable, Equatable {
    let id: String
    let conversationId: String
    let messageId: String
    let title: String
    let detail: String?
    let url: String?
    let questions: [ChatQuestion]
    var sourceTitle: String? = nil
}
struct ChatQuestion: Decodable, Identifiable, Equatable {
    let id: String
    let question: String
    let options: [String]
}
