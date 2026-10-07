import Foundation

enum MessagePages {
    /// Pages are ordered by the server, including messages with identical dates.
    static func merge(existing: [HomeMessage], page: [HomeMessage], updates: [HomeMessage] = [], prepend: Bool = false) -> [HomeMessage] {
        let existingIDs = Set(existing.map(\.id))
        let changes = Dictionary((page + updates).map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        let current = existing.map { changes[$0.id] ?? $0 }
        let new = page.filter { !existingIDs.contains($0.id) }
        return prepend ? new + current : current + new
    }
}
