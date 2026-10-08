import Foundation

enum MessagePages {
    struct Row: Identifiable {
        let message: HomeMessage
        let day: Date?
        var id: String { message.id }
    }

    /// A lazy row may render after the selected conversation has changed.
    /// Derive its date heading from the same snapshot as its message.
    static func rows(_ messages: [HomeMessage], calendar: Calendar = .current) -> [Row] {
        var previous: Date?
        return messages.map { message in
            let sentAt = message.sentAt
            let startsDay = sentAt.map { day in
                previous.map { !calendar.isDate(day, inSameDayAs: $0) } ?? true
            } ?? false
            previous = sentAt
            return Row(message: message, day: startsDay ? sentAt : nil)
        }
    }

    /// Pages are ordered by the server, including messages with identical dates.
    static func merge(existing: [HomeMessage], page: [HomeMessage], updates: [HomeMessage] = [], prepend: Bool = false) -> [HomeMessage] {
        let existingIDs = Set(existing.map(\.id))
        let changes = Dictionary((page + updates).map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        let current = existing.map { changes[$0.id] ?? $0 }
        let new = page.filter { !existingIDs.contains($0.id) }
        return prepend ? new + current : current + new
    }
}
