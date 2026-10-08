import Foundation
import Testing

struct ChatClockTests {
    private func message(_ createdAt: String, imported: Bool? = nil) -> HomeMessage {
        HomeMessage(id: "m", conversationId: "c", channel: "api", direction: "inbound", replyToId: nil, text: "Привет",
                    externalId: nil, createdAt: createdAt, status: "completed", error: nil, kind: "text", imported: imported)
    }

    @Test func liveMessagesKeepTheirExactMoment() throws {
        let sent = message("2026-09-28T06:14:05.120Z")
        #expect(try #require(sent.sentAt).timeIntervalSince1970 == 1_790_576_045.12)
        #expect(sent.time?.count == 5)
    }

    @Test func dayOnlyHistoryShowsItsDayWithoutAnInventedTime() throws {
        let imported = message("2026-09-24T00:00:00.000Z", imported: true)
        #expect(imported.time == nil)
        #expect(Calendar.current.component(.day, from: try #require(imported.sentAt)) == 24)
    }

    @Test func daysReadAsPeopleSayThem() throws {
        #expect(ChatClock.day(.now) == "Сегодня")
        #expect(ChatClock.day(try #require(Calendar.current.date(byAdding: .day, value: -1, to: .now))) == "Вчера")
        let older = try Date.ISO8601FormatStyle().parse("2025-03-05T12:00:00Z")
        #expect(ChatClock.day(older).hasPrefix("5 марта 2025"))
    }

    @Test func lazyDateHeadingsKeepTheirConversationSnapshot() throws {
        var messages = [message("2026-10-07T12:00:00Z"), message("2026-10-07T12:01:00Z"), message("2026-10-08T12:00:00Z")]
        let rows = MessagePages.rows(messages)
        // SwiftUI can render these rows after switching to a short or empty chat.
        messages = [message("2026-10-09T12:00:00Z")]
        #expect(rows[0].day == rows[0].message.sentAt)
        #expect(rows[1].day == nil)
        #expect(rows[2].day == rows[2].message.sentAt)
        messages.removeAll()
        #expect(MessagePages.rows(messages).isEmpty)
        #expect(rows[2].message.createdAt == "2026-10-08T12:00:00Z")
    }

    @Test func prependingHistoryRecomputesTheBoundaryOfTheNewSnapshot() {
        let recent = message("2026-10-08T12:01:00Z")
        let before = MessagePages.rows([recent])
        let after = MessagePages.rows([message("2026-10-08T12:00:00Z"), recent])
        #expect(before[0].day != nil)
        #expect(after[0].day != nil)
        #expect(after[1].day == nil)
    }
}
