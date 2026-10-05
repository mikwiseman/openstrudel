#if os(macOS)
import Foundation
import CryptoKit

/// Reviewed backend v2. The app entry point stays closed until the live Home
/// acceptance in docs/integrated-cloud-checkout.md is complete.
enum WaiVDSContract {
    static let availableInApp = false
    static let origin = "https://server.waiwai.is"
    static let api = "/api/v2/openstrudel"
    static let callback = "openstrudel://oauth/wai-vds"
    static let paymentCallback = "openstrudel://checkout/wai-vds"
    static let releaseURL = "https://waiwai.is/openstrudel/downloads/OpenStrudel-Home-1.0.tar.gz"
    static let releaseHash = "2d2276516882aee51f79c003320ac226101f3291c1d365f25b03b520ef516a69"
    static let recipeHash = "6215040abb4acf01ce26f04f8786a97245c6532ee3e380015c9e99cbbd0f9f2a"

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        do { return try decoder.decode(type, from: data) }
        catch { throw WaiVDSFailure.response }
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func isHash(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
    static func id(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func milliseconds(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970 * 1000) }
    static func random() throws -> String { try DigitalOceanOAuth.random() }

    static func callbackParameters(_ url: URL, expected: String, state: String) throws -> [String: String] {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let destination = URLComponents(string: expected),
              parts.scheme == destination.scheme, parts.host == destination.host, parts.path == destination.path,
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil else { throw WaiVDSFailure.callback }
        let items = parts.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count, items.allSatisfy({ $0.value != nil }),
              state.range(of: "^[A-Za-z0-9._~-]{16,128}$", options: .regularExpression) != nil,
              items.first(where: { $0.name == "state" })?.value == state else { throw WaiVDSFailure.callback }
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value!) })
    }
}

enum WaiVDSFailure: Error, LocalizedError, Equatable {
    case storage, response, callback, signIn, freshSignIn, wrongAccount, unavailable, quoteExpired
    case busy, network, unknownResult, paymentPending, identity, homeAuthentication, rateLimited, conflict
    var errorDescription: String? {
        switch self {
        case .storage: return "Не удалось сохранить настройку. Разблокируйте Mac и попробуйте ещё раз."
        case .signIn: return "Войдите в аккаунт размещения, чтобы продолжить. Ваш заказ сохранён."
        case .freshSignIn: return "Подтвердите вход ещё раз, чтобы получить доступ к серверу."
        case .wrongAccount: return "Этот заказ связан с другим аккаунтом. Войдите в тот аккаунт, с которого его начали."
        case .unavailable: return "Размещение ещё проходит проверку. Оплата пока недоступна."
        case .quoteExpired: return "Цена устарела. Проверьте новую сумму перед оплатой."
        case .busy: return "Предыдущее действие ещё выполняется."
        case .network: return "Не удалось проверить заказ. Проверьте интернет и попробуйте ещё раз."
        case .unknownResult: return "Ответ не получен. Настройка сохранена. Проверьте её состояние перед следующим действием."
        case .paymentPending: return "Проверяем платёж. Повторно платить пока не нужно."
        case .identity: return "Не удалось подтвердить, что это ваш сервер. Подключение остановлено."
        case .homeAuthentication: return "Сервер найден, но сохранённый доступ больше не действует. Восстановите подключение."
        case .callback: return "Не удалось подтвердить возвращение в приложение. Повторите вход или проверку заказа."
        case .rateLimited: return "Сервис просит немного подождать. Проверьте заказ через несколько минут."
        case .conflict: return "Состояние заказа изменилось. Проверьте его перед следующим действием."
        case .response: return "Не удалось проверить ответ сервиса. Ваш заказ сохранён."
        }
    }
}

struct WaiVDSProfile: Codable, Equatable, Sendable {
    let id: String; let version: Int; let region: String
    let ramMb: Int; let diskGb: Int; let cpu: String; let publicIpv4: Int; let trafficGb: Int
    let os: String; let image: String?; let releaseUrl: String; let releaseSha256: String; let recipeSha256: String
    func validate() throws {
        guard id == "openstrudel-home-v1", version == 1, ramMb >= 4096, diskGb >= 30, publicIpv4 == 1,
              cpu == "1A", trafficGb == 5000, os == "Ubuntu 24.04 LTS", !region.isEmpty,
              releaseUrl == WaiVDSContract.releaseURL, releaseSha256 == WaiVDSContract.releaseHash,
              recipeSha256 == WaiVDSContract.recipeHash else { throw WaiVDSFailure.unavailable }
    }
}

struct WaiVDSCatalog: Decodable, Sendable {
    struct Method: Decodable, Sendable { let id: String; let currency: String; let amountMinor: Int64?; let currencyExponent: Int }
    struct Checkout: Decodable, Sendable { let type: String; let embedded: Bool; let provider: String; let returnTo: String }
    struct Platforms: Decodable, Sendable {
        struct Platform: Decodable, Sendable { let purchaseEnabled: Bool; let mode: String? }
        let mac: Platform; let web: Platform; let ios: Platform
    }
    let clientId: String; let profile: WaiVDSProfile; let purchaseEnabled: Bool; let availabilityReason: String?
    let paymentMethods: [Method]; let checkout: Checkout; let platforms: Platforms
    let automaticRenewal: Bool; let periodDays: Int; let graceDays: Int; let openai: String; let mode: String
    func validate() throws {
        try profile.validate()
        guard clientId == "openstrudel", ["live_gated", "emulator"].contains(mode),
              !automaticRenewal, periodDays == 30, graceDays == 3, openai == "owner_signs_in_on_home",
              !platforms.ios.purchaseEnabled, platforms.ios.mode == "join_by_invitation",
              checkout.type == "hosted", !checkout.embedded, checkout.provider == "WAI Pay", checkout.returnTo == "OpenStrudel",
              Set(paymentMethods.map(\.id)).count == paymentMethods.count,
              paymentMethods.allSatisfy({ Self.validMoney(method: $0.id, currency: $0.currency, exponent: $0.currencyExponent,
                                                         amount: $0.amountMinor, mode: mode, optional: !purchaseEnabled) })
        else { throw WaiVDSFailure.response }
    }
    static func validMoney(method: String, currency: String, exponent: Int, amount: Int64?, mode: String, optional: Bool = false) -> Bool {
        let validPair = (method == "card" && currency == "USD") || (method == "crypto" && currency == "USDT")
            || (mode == "emulator" && method == "test" && currency == "USD")
        return validPair && exponent == 2 && (amount.map { $0 > 0 && $0 <= 2_147_483_647 } ?? optional)
    }
}

struct WaiVDSQuote: Codable, Equatable, Sendable {
    let quoteId: String; let quoteDigest: String; let profile: WaiVDSProfile; let platform: String
    let kind: String; let installationId: String?; let paymentMethod: String; let amountMinor: Int64
    let currency: String; let currencyExponent: Int; let totalIsFinal: Bool; let taxNote: String
    let periodDays: Int; let startsAt: String; let automaticRenewal: Bool; let graceDays: Int
    let cancellation: String; let refundPolicy: String
    let createdAt: Int64?; let expiresAt: Int64?; let checkoutDeadline: Int64?; let mode: String
    func validate(at now: Date, requireUnexpired: Bool = true) throws {
        try profile.validate()
        guard WaiVDSContract.id(quoteId), WaiVDSContract.isHash(quoteDigest), platform == "mac",
              ["emulator", "live"].contains(mode), totalIsFinal, !automaticRenewal, periodDays == 30, graceDays == 3,
              !taxNote.isEmpty, !cancellation.isEmpty, !refundPolicy.isEmpty,
              WaiVDSCatalog.validMoney(method: paymentMethod, currency: currency, exponent: currencyExponent, amount: amountMinor, mode: mode),
              (kind == "initial" && installationId == nil && startsAt == "verified_home_ready")
                || (kind == "renewal" && installationId.map(WaiVDSContract.id) == true && startsAt == "current_period_end_or_payment"),
              let createdAt, let expiresAt, let checkoutDeadline,
              createdAt > 0, createdAt <= WaiVDSContract.milliseconds(now) + 60_000,
              expiresAt > createdAt, expiresAt - createdAt <= 900_000, checkoutDeadline > expiresAt
        else { throw WaiVDSFailure.response }
        if requireUnexpired && expiresAt <= WaiVDSContract.milliseconds(now) { throw WaiVDSFailure.quoteExpired }
    }
    var priceText: String {
        // USD and USDT remain distinct; do not run either through a locale's default currency.
        let amount = Decimal(amountMinor) / 100
        return "\(amount.formatted(.number.precision(.fractionLength(2)))) \(currency) за 30 дней"
    }
}

struct WaiVDSOrder: Codable, Equatable, Sendable {
    let orderId: String; let installationId: String; let quoteId: String; let quoteDigest: String
    let orderStatus: String; let kind: String; let amountMinor: Int64; let currency: String; let currencyExponent: Int
    let paymentMethod: String; let paymentState: String; let sessionState: String; let actionRequired: String
    let sessionExpiresAt: Int64?; let paymentVerifiedAt: Int64?; let provisioningState: String; let homeState: String
    let paidUntil: Int64?; let cancelAtEnd: Bool; let readinessVerifiedAt: Int64?; let mode: String; let createdAt: Int64?

    func validate() throws {
        guard [orderId, installationId, quoteId].allSatisfy(WaiVDSContract.id), WaiVDSContract.isHash(quoteDigest),
              ["initial", "renewal"].contains(kind), ["live", "emulator"].contains(mode),
              WaiVDSCatalog.validMoney(method: paymentMethod, currency: currency, exponent: currencyExponent, amount: amountMinor, mode: mode),
              ["draft", "checkout", "paid", "fulfilling", "fulfilled", "needs_refund", "refunded", "canceled"].contains(orderStatus),
              ["unpaid", "pending", "unknown", "failed", "partially_paid", "paid", "partially_refunded", "refunded", "refund_review", "additional_payment_review"].contains(paymentState),
              ["none", "open", "unknown", "expired", "canceled", "closed", "review", "confirmation_pending"].contains(sessionState),
              ["start_payment", "retry_payment", "wait_for_confirmation", "contact_support", "wait_for_home", "claim_connection", "complete_payment", "none", "new_quote_required", "purchase_unavailable"].contains(actionRequired),
              ["not_started", "paid", "creating", "configuring", "checking", "ready", "overdue", "rejected", "unknown", "attention", "deleting", "deleted"].contains(provisioningState),
              ["pending", "installing", "ready", "attention", "canceled", "deleted"].contains(homeState),
              [sessionExpiresAt, paymentVerifiedAt, paidUntil, readinessVerifiedAt, createdAt].compactMap({ $0 }).allSatisfy({ $0 > 0 })
        else { throw WaiVDSFailure.response }
    }
    func matches(quote: WaiVDSQuote, installation: String) -> Bool {
        quoteId == quote.quoteId && quoteDigest == quote.quoteDigest && installationId == installation && kind == quote.kind
            && amountMinor == quote.amountMinor && currency == quote.currency && currencyExponent == quote.currencyExponent
            && paymentMethod == quote.paymentMethod && mode == quote.mode
    }
    func canRequestCheckout(at date: Date) -> Bool {
        guard ["draft", "checkout"].contains(orderStatus), paymentState == "unpaid", homeState == "pending",
              provisioningState == "not_started" else { return false }
        return (actionRequired == "start_payment" && sessionState == "none")
            || (actionRequired == "retry_payment" && ["expired", "canceled"].contains(sessionState)
                && paymentVerifiedAt != nil && paymentVerifiedAt! <= WaiVDSContract.milliseconds(date) + 60_000)
    }
    func canClaim(at date: Date) -> Bool {
        orderStatus == "fulfilled" && paymentState == "paid" && paymentVerifiedAt != nil && homeState == "ready"
            && provisioningState == "ready" && actionRequired == "claim_connection" && readinessVerifiedAt != nil
            && (paidUntil ?? 0) > WaiVDSContract.milliseconds(date)
    }
    var message: String {
        if provisioningState == "deleted" || homeState == "deleted" { return "Размещение удалено." }
        if provisioningState == "deleting" { return "Удаляем размещение." }
        if orderStatus == "refunded" && paymentState == "refunded" { return "Возврат оформлен." }
        if ["needs_refund", "refunded"].contains(orderStatus) || ["partially_paid", "partially_refunded", "refund_review", "additional_payment_review"].contains(paymentState)
            || actionRequired == "contact_support" { return "Нужна помощь с оплатой. Ваш заказ сохранён." }
        if paymentState == "unknown" || ["unknown", "confirmation_pending"].contains(sessionState) || actionRequired == "wait_for_confirmation" {
            return "Проверяем платёж. Повторно платить пока не нужно."
        }
        if orderStatus == "canceled" { return "Заказ закрыт." }
        if paymentState == "paid" {
            if homeState == "attention" || ["attention", "unknown", "rejected"].contains(provisioningState) { return "Оплата получена. Нужна помощь с подготовкой размещения." }
            if provisioningState == "overdue" { return "Оплаченный срок закончился. Проверьте продление размещения." }
            if homeState == "ready" && provisioningState == "ready" { return "Размещение готово. Проверяем подключение." }
            return "Оплата получена. Подготовка ещё идёт."
        }
        if actionRequired == "retry_payment" { return "Предыдущий счёт закрыт без оплаты. Можно оплатить заказ." }
        if actionRequired == "new_quote_required" { return "Срок оплаты закончился. Проверьте заказ перед новой покупкой." }
        if actionRequired == "purchase_unavailable" { return "Оплата размещения временно недоступна." }
        return "Ожидаем оплату. Заказ сохранён."
    }
}

struct WaiVDSCheckout: Decodable, Sendable {
    let order: WaiVDSOrder; let type: String; let url: String?
    private enum CodingKeys: String, CodingKey { case type, url }
    init(from decoder: Decoder) throws {
        order = try WaiVDSOrder(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(String.self, forKey: .type); url = try c.decodeIfPresent(String.self, forKey: .url)
    }
    func browserURL(at now: Date) throws -> URL? {
        try order.validate()
        guard type == "hosted" else { throw WaiVDSFailure.response }
        guard let url else { return nil }
        guard order.orderStatus == "checkout", order.actionRequired == "complete_payment", order.sessionState == "open",
              ["pending", "unpaid"].contains(order.paymentState), order.paymentVerifiedAt != nil,
              (order.sessionExpiresAt ?? 0) > WaiVDSContract.milliseconds(now),
              let p = URLComponents(string: url), p.scheme == "https", p.user == nil, p.password == nil,
              p.port == nil, p.fragment == nil,
              p.host == (order.paymentMethod == "card" ? "checkout.stripe.com" : "pay.cryptomus.com"),
              ["card", "crypto"].contains(order.paymentMethod), let result = p.url else { throw WaiVDSFailure.paymentPending }
        return result
    }
}

struct WaiVDSConnectionClaim: Decodable, Sendable {
    let installationId: String; let url: String; let certificateSha256: String; let releaseSha256: String
    let ownerTokenSource: String; let openaiAction: String; let mode: String
    func endpoint(for installation: String, release: String) throws -> URL {
        guard installationId == installation, releaseSha256 == release, mode == "kamatera", ownerTokenSource == "device_keychain",
              openaiAction == "owner_sign_in_on_home", WaiVDSContract.isHash(certificateSha256),
              let p = URLComponents(string: url), p.scheme == "https", p.port == 7789, p.path.isEmpty,
              p.user == nil, p.password == nil, p.query == nil, p.fragment == nil, let host = p.host,
              DigitalOceanHomeTrust.isPublicIPv4(host), !host.hasPrefix("192.0.0."), !host.hasPrefix("192.0.2."),
              !host.hasPrefix("198.51.100."), !host.hasPrefix("203.0.113."), let value = p.url
        else { throw WaiVDSFailure.identity }
        return value
    }
}
#endif
