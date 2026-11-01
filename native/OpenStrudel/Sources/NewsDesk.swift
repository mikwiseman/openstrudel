import Foundation

struct NewsDesk {
    struct Item: Identifiable {
        let id: String
        /// Oldest first; the last one is the story as it stands now.
        var versions: [HomeMessage] = []
        /// Questions about this story and their answers, oldest first.
        var thread: [HomeMessage] = []
        var latest: HomeMessage { versions[versions.count - 1] }
        var story: NewsStory { latest.story! }
        /// Curation and copy edits keep versions for identity and discussion, but are not new events.
        var developments: [HomeMessage] {
            versions.filter { $0.id == versions.first?.id || $0.story?.change?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
        }
    }

    let items: [Item]
    let edition: String?
    let editionItems: [Item]
    let radarItems: [Item]

    init(_ messages: [HomeMessage]) {
        var byID: [String: Item] = [:], order: [String] = []
        for message in messages {
            guard let id = message.story?.id ?? message.storyId else { continue }
            if byID[id] == nil { byID[id] = Item(id: id); order.append(id) }
            if message.story != nil { byID[id]!.versions.append(message) } else { byID[id]!.thread.append(message) }
        }
        let all = order.compactMap { byID[$0] }.filter { !$0.versions.isEmpty }
        let latest = all.flatMap { $0.versions.compactMap(\.story?.edition) }.max()
        func rank(_ item: Item) -> Int { item.versions.last { $0.story?.edition == latest }?.story?.rank ?? .max }
        func activity(_ item: Item) -> String { item.versions.last { $0.story?.edition == nil }?.createdAt ?? "" }
        items = all
        edition = latest
        editionItems = latest == nil ? [] : all.filter { $0.versions.contains { $0.story?.edition == latest } }
            .sorted { rank($0) == rank($1) ? $0.latest.createdAt < $1.latest.createdAt : rank($0) < rank($1) }
        radarItems = all.filter { !activity($0).isEmpty }.sorted { activity($0) > activity($1) }
    }

    func item(_ id: String?) -> Item? { items.first { $0.id == id } }
}
