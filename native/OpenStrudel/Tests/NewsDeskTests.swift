import Testing

struct NewsDeskTests {
    private func version(_ id: String, edition: String? = nil, change: String? = nil) -> HomeMessage {
        HomeMessage(id: id, conversationId: "news", channel: "api", direction: "outbound", replyToId: nil,
                    text: "Story", externalId: nil, createdAt: "2026-11-01T06:00:00.000Z", status: "completed", error: nil, kind: "text",
                    story: NewsStory(id: "story", edition: edition, rank: edition == nil ? nil : 1, section: "Агенты", status: "Прототип",
                                     title: "Новый агент", summary: "Суть", body: "Факты", view: nil, check: nil, verification: "Прочитан источник",
                                     eventAt: nil, change: change, sources: []))
    }

    @Test func anEditionAndCopyEditAreNotNewDevelopments() throws {
        let desk = NewsDesk([version("first"), version("edition", edition: "2026-11-01"), version("copy", edition: "2026-11-01")])
        let item = try #require(desk.item("story"))
        #expect(item.developments.map(\.id) == ["first"])
        #expect(item.latest.id == "copy")
        #expect(item.versions.count == 3)
        #expect(desk.editionItems.map(\.id) == ["story"])
        #expect(desk.radarItems.map(\.id) == ["story"])
    }

    @Test func aRealUpdateRemainsAfterCuration() throws {
        let desk = NewsDesk([version("first"), version("update", change: "Опубликованы веса."), version("edition", edition: "2026-11-01")])
        let item = try #require(desk.item("story"))
        #expect(item.developments.map(\.id) == ["first", "update"])
        #expect(item.latest.id == "edition")
    }
}
