import Foundation

enum MessagePages {
    /// Half an hour of quiet, or a new day, opens a new time cluster.
    static let clusterPause: TimeInterval = 30 * 60

    struct Row: Identifiable {
        let message: HomeMessage
        /// The moment shown above this message when it opens a time cluster.
        let header: Date?
        /// The previous message came from the other side, so a new turn begins.
        let startsTurn: Bool
        /// The message shown right above, never one the feed hides.
        let previous: HomeMessage?
        var id: String { message.id }
    }

    static func opensCluster(_ date: Date, after previous: Date?, calendar: Calendar = .current) -> Bool {
        guard let previous else { return true }
        return !calendar.isDate(date, inSameDayAs: previous) || date.timeIntervalSince(previous) >= clusterPause
    }

    /// A lazy row may render after the selected conversation has changed.
    /// Derive its time heading and rhythm from the same snapshot as its message.
    static func rows(_ messages: [HomeMessage], calendar: Calendar = .current) -> [Row] {
        var previous: HomeMessage?
        return messages.map { message in
            let sentAt = message.sentAt
            let opens = sentAt.map { opensCluster($0, after: previous?.sentAt, calendar: calendar) } ?? false
            let startsTurn = previous.map { $0.direction != message.direction || $0.conversationId != message.conversationId } ?? false
            defer { previous = message }
            return Row(message: message, header: opens ? sentAt : nil, startsTurn: startsTurn, previous: previous)
        }
    }

    /// Imported history with several people's messages shows who wrote each one; history from
    /// one person reads like any one-to-one conversation.
    static func isMultiAuthor(_ messages: [HomeMessage]) -> Bool {
        var authors = Set<String>()
        for message in messages where message.imported == true && message.direction == "inbound" {
            if let author = message.author { authors.insert(author) }
            if authors.count > 1 { return true }
        }
        return false
    }

    /// The owner's explicit reply in Telegram: the bot publishes it, a person wrote it, and it answers a request.
    /// The employee's own replies carry no author. What the Home posts by itself (a story, an edition, a message an
    /// employee sent to a chat) carries the bot's name and answers nothing: it is the employee's text, read as Markdown.
    static func isOwnerReply(_ message: HomeMessage) -> Bool {
        message.direction == "outbound" && message.channel == "telegram" && message.author != nil && message.imported != true && message.replyToId != nil
    }

    /// The one line above a message from Telegram or the archive. A request names its author first, then its group,
    /// or just Telegram in a private chat, whose title only repeats the person's name.
    static func sourceLine(_ message: HomeMessage) -> String? {
        guard let origin = message.origin, origin.channel != "api" else { return nil }
        guard origin.channel == "telegram" else { return L("Архив") + " · " + origin.title }
        guard message.direction == "inbound", let author = message.author, !author.isEmpty else { return "Telegram · " + origin.title }
        return author + " · " + (origin.chatId?.hasPrefix("-") == true ? origin.title : "Telegram")
    }

    /// In a group where the employee decides by its own rules, a message still being decided is not
    /// a request yet: it joins the feed with its reply, and never if the employee stays silent.
    /// A request whose approval card waits for the owner stays visible with it.
    static func feed(_ messages: [HomeMessage], decidingChats: Set<String>, awaiting: Set<String> = []) -> [HomeMessage] {
        guard !decidingChats.isEmpty else { return messages }
        return messages.filter { message in
            awaiting.contains(message.id) || !(message.direction == "inbound" && message.origin?.channel == "telegram" && (message.status == "queued" || message.status == "running")
              && decidingChats.contains(message.origin?.chatId ?? ""))
        }
    }

    /// The line under a reply sent to Telegram. A delivered reply stays silent; only a send in flight or a problem speaks.
    static func deliveryNotice(_ delivery: MessageDelivery) -> String? {
        switch delivery.state {
        case "delivered": nil
        case "unknown": L("Доставка не подтверждена. Проверьте Telegram перед новой отправкой.")
        case "not_sent": L("Не отправлено в Telegram")
        default: L("Отправляем в Telegram…")
        }
    }

    enum DeliveryAction: Equatable { case open(URL), resend(HomeMessage) }

    /// One clear way on from a reply Telegram did not take or did not confirm: open the request in
    /// Telegram, or let the owner send the prepared text again. Nothing is resent by itself.
    static func deliveryAction(for reply: HomeMessage, in messages: [HomeMessage], canReply: Bool) -> DeliveryAction? {
        guard reply.direction == "outbound", ["not_sent", "unknown"].contains(reply.delivery?.state) else { return nil }
        let request = messages.first { $0.id == reply.replyToId }
        if let raw = reply.origin?.url ?? request?.origin?.url, let url = URL(string: raw), url.scheme == "https", url.host == "t.me" { return .open(url) }
        if canReply, let request, request.origin?.canReply == true { return .resend(request) }
        return nil
    }

    /// Pages are ordered by the server, including messages with identical dates.
    static func merge(existing: [HomeMessage], page: [HomeMessage], updates: [HomeMessage] = [], prepend: Bool = false, removedIDs: [String] = []) -> [HomeMessage] {
        let removed = Set(removedIDs)
        let existingIDs = Set(existing.map(\.id))
        let changes = Dictionary((page + updates).map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        let current = existing.filter { !removed.contains($0.id) }.map { changes[$0.id] ?? $0 }
        let new = page.filter { !existingIDs.contains($0.id) && !removed.contains($0.id) }
        return prepend ? new + current : current + new
    }
}
