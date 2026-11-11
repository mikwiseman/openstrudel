import Foundation
import Testing

struct ChatClockTests {
    private func message(_ createdAt: String, imported: Bool? = nil, direction: String = "inbound", author: String? = nil) -> HomeMessage {
        HomeMessage(id: "m", conversationId: "c", channel: "api", direction: direction, replyToId: nil, text: "Привет",
                    externalId: nil, createdAt: createdAt, status: "completed", error: nil, kind: "text", author: author, imported: imported)
    }

    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    @Test func liveMessagesKeepTheirExactMoment() throws {
        let sent = message("2026-09-28T06:14:05.120Z")
        #expect(try #require(sent.sentAt).timeIntervalSince1970 == 1_790_576_045.12)
        #expect(try #require(sent.time).isEmpty == false)
    }

    @Test func dayOnlyHistoryShowsItsDayWithoutAnInventedTime() throws {
        let imported = message("2026-09-24T00:00:00.000Z", imported: true)
        #expect(imported.time == nil)
        #expect(Calendar.current.component(.day, from: try #require(imported.sentAt)) == 24)
    }

    @Test func daysReadAsPeopleSayThem() throws {
        #expect(ChatClock.day(.now) == L("Сегодня"))
        #expect(ChatClock.day(try #require(Calendar.current.date(byAdding: .day, value: -1, to: .now))) == L("Вчера"))
        let older = try Date.ISO8601FormatStyle().parse("2025-03-05T12:00:00Z")
        #expect(ChatClock.day(older).contains("2025"))
        #expect(ChatClock.day(older).contains(older.formatted(.dateTime.month(.wide).locale(L10n.locale))))
    }

    @Test func clustersReadAsTheDayAndTheTime() throws {
        #expect(ChatClock.cluster(.now, hasTime: true) == L("Сегодня") + ", " + ChatClock.time(.now))
        let imported = try #require(message("2026-09-24T00:00:00.000Z", imported: true).sentAt)
        #expect(ChatClock.cluster(imported, hasTime: false) == ChatClock.day(imported))
    }

    @Test func theExactMomentNeverInventsATime() throws {
        let live = try #require(message("2026-09-24T09:05:00Z").sentAt)
        #expect(ChatClock.exact(live, hasTime: true).contains(ChatClock.time(live)))
        let imported = try #require(message("2026-09-24T00:00:00.000Z", imported: true).sentAt)
        #expect(!ChatClock.exact(imported, hasTime: false).contains(ChatClock.time(imported)))
        #expect(ChatClock.exact(imported, hasTime: false).contains("2026"))
    }

    @Test func lazyTimeHeadingsKeepTheirConversationSnapshot() throws {
        var messages = [message("2026-10-07T12:00:00Z"), message("2026-10-07T12:01:00Z"), message("2026-10-08T12:00:00Z")]
        let rows = MessagePages.rows(messages, calendar: utc)
        // SwiftUI can render these rows after switching to a short or empty chat.
        messages = [message("2026-10-09T12:00:00Z")]
        #expect(rows[0].header == rows[0].message.sentAt)
        #expect(rows[1].header == nil)
        #expect(rows[2].header == rows[2].message.sentAt)
        messages.removeAll()
        #expect(MessagePages.rows(messages).isEmpty)
        #expect(rows[2].message.createdAt == "2026-10-08T12:00:00Z")
    }

    @Test func aPauseOfHalfAnHourOpensANewCluster() {
        let rows = MessagePages.rows([
            message("2026-10-07T12:00:00Z"),
            message("2026-10-07T12:29:59Z"), // 29:59 later
            message("2026-10-07T12:59:58Z"), // 29:59 after the previous message, not the first
            message("2026-10-07T13:29:58Z"), // exactly 30:00 later
        ], calendar: utc)
        #expect(rows.map { $0.header != nil } == [true, false, false, true])
        #expect(rows[3].header == rows[3].message.sentAt)
    }

    @Test func aNewDayOpensAClusterEvenAfterAShortPause() {
        let rows = MessagePages.rows([message("2026-10-07T23:50:00Z"), message("2026-10-08T00:05:00Z")], calendar: utc)
        #expect(rows.map { $0.header != nil } == [true, true])
    }

    @Test func prependingHistoryRecomputesTheBoundaryOfTheNewSnapshot() {
        let recent = message("2026-10-08T12:20:00Z")
        let before = MessagePages.rows([recent], calendar: utc)
        let close = MessagePages.rows([message("2026-10-08T12:00:00Z"), recent], calendar: utc)
        let distant = MessagePages.rows([message("2026-10-08T11:00:00Z"), recent], calendar: utc)
        #expect(before[0].header != nil)
        #expect(close[0].header != nil)
        #expect(close[1].header == nil)
        #expect(distant[1].header != nil)
    }

    @Test func dayOnlyHistorySharesOneHeaderPerDay() {
        let rows = MessagePages.rows([
            message("2026-09-24T00:00:00.000Z", imported: true),
            message("2026-09-24T00:00:00.000Z", imported: true),
            message("2026-09-25T00:00:00.000Z", imported: true),
        ])
        #expect(rows.map { $0.header != nil } == [true, false, true])
        #expect(rows.allSatisfy { !$0.message.hasTime })
    }

    @Test func turnsChangeWithTheSpeaker() {
        let rows = MessagePages.rows([
            message("2026-10-07T12:00:00Z"), message("2026-10-07T12:00:01Z"),
            message("2026-10-07T12:00:02Z", direction: "outbound"), message("2026-10-07T12:00:03Z", direction: "outbound"),
            message("2026-10-07T12:00:04Z"),
        ], calendar: utc)
        #expect(rows.map(\.startsTurn) == [false, false, true, false, true])
    }

    @Test func aPendingMessageOpensAClusterAfterAPause() throws {
        let last = try #require(message("2026-10-07T12:00:00Z").sentAt)
        #expect(MessagePages.opensCluster(last.addingTimeInterval(29 * 60 + 59), after: last, calendar: utc) == false)
        #expect(MessagePages.opensCluster(last.addingTimeInterval(30 * 60), after: last, calendar: utc))
        #expect(MessagePages.opensCluster(last, after: nil, calendar: utc))
    }

    @Test func importedHistoryFromOnePersonReadsAsOneToOne() {
        let history = [
            message("2026-10-07T12:00:00Z", imported: true, author: "Mik"),
            message("2026-10-07T12:01:00Z", imported: true, direction: "outbound", author: "Launch Manager"),
            message("2026-10-07T12:02:00Z", imported: true, author: "Mik"),
            message("2026-10-07T12:03:00Z", author: nil),
        ]
        #expect(!MessagePages.isMultiAuthor(history))
        #expect(!MessagePages.isMultiAuthor([]))
    }

    @Test func importedHistoryFromSeveralPeopleShowsWhoWrote() {
        let history = [
            message("2026-10-07T12:00:00Z", imported: true, author: "Anna"),
            message("2026-10-07T12:01:00Z", imported: true, direction: "outbound", author: "Launch Manager"),
            message("2026-10-07T12:02:00Z", imported: true, author: "Boris"),
        ]
        #expect(MessagePages.isMultiAuthor(history))
    }
}

/// The employee's one feed: who wrote each message, what a failed delivery offers, and what waits for a decision.
struct EmployeeFeedTests {
    private func message(_ id: String, direction: String = "inbound", channel: String = "telegram", replyTo: String? = nil, status: String = "completed",
                         author: String? = nil, imported: Bool? = nil, origin: MessageOrigin? = nil, delivery: String? = nil, conversation: String = "group") -> HomeMessage {
        HomeMessage(id: id, conversationId: conversation, channel: channel, direction: direction, replyToId: replyTo, text: "Text " + id,
                    externalId: nil, createdAt: "2026-10-14T12:00:00.000Z", status: status, error: nil, kind: "text", author: author,
                    imported: imported, origin: origin, delivery: delivery.map { MessageDelivery(state: $0) })
    }

    @Test func theOwnersExplicitTelegramReplyIsTheOwnersNotTheEmployees() {
        #expect(MessagePages.isOwnerReply(message("explicit", direction: "outbound", replyTo: "request", author: "OpenStrudel")))
        // What the Home posts by itself carries the bot's name and answers nothing: a story, an edition, a sent message.
        #expect(!MessagePages.isOwnerReply(message("post", direction: "outbound", author: "Desk Bot")))
        #expect(!MessagePages.isOwnerReply(message("employee", direction: "outbound")))
        #expect(!MessagePages.isOwnerReply(message("archive", direction: "outbound", author: "Editor", imported: true)))
        #expect(!MessagePages.isOwnerReply(message("person", author: "Anna")))
        #expect(!MessagePages.isOwnerReply(message("app", direction: "outbound", channel: "api", author: "Mik")))
    }

    @Test func aTelegramRequestHasOneSourceLineLedByItsAuthor() {
        let dm = MessageOrigin(channel: "telegram", title: "Mik", chatId: "42", canReply: true)
        let group = MessageOrigin(channel: "telegram", title: "WAI Core Team", chatId: "-1001", url: "https://t.me/c/1/7", canReply: true)
        #expect(MessagePages.sourceLine(message("dm", author: "Mik Wiseman", origin: dm)) == "Mik Wiseman · Telegram")
        #expect(MessagePages.sourceLine(message("g", author: "Гриша", origin: group)) == "Гриша · WAI Core Team")
        #expect(MessagePages.sourceLine(message("old", origin: dm)) == "Telegram · Mik")
        // Replies name the chat, so an owner's pending reply and its sent row read the same.
        #expect(MessagePages.sourceLine(message("r", direction: "outbound", origin: dm)) == "Telegram · Mik")
        #expect(MessagePages.sourceLine(message("own", direction: "outbound", author: "OpenStrudel", origin: group)) == "Telegram · WAI Core Team")
        #expect(MessagePages.sourceLine(message("a", author: "Вы", imported: true, origin: MessageOrigin(channel: "archive", title: "Старые заметки"))) == L("Архив") + " · Старые заметки")
        #expect(MessagePages.sourceLine(message("app", channel: "api", origin: MessageOrigin(channel: "api", title: ""))) == nil)
        #expect(MessagePages.sourceLine(message("none", channel: "api")) == nil)
    }

    @Test func aDeliveredReplyIsSilentAndOnlyASendInFlightOrAProblemSpeaks() {
        #expect(MessagePages.deliveryNotice(MessageDelivery(state: "delivered")) == nil)
        #expect(MessagePages.deliveryNotice(MessageDelivery(state: "pending")) == L("Отправляем в Telegram…"))
        #expect(MessagePages.deliveryNotice(MessageDelivery(state: "not_sent")) == L("Не отправлено в Telegram"))
        #expect(MessagePages.deliveryNotice(MessageDelivery(state: "unknown")) == L("Доставка не подтверждена. Проверьте Telegram перед новой отправкой."))
    }

    @Test func aFailedOrUncertainDeliveryOffersOneActionAndNothingIsResentByItself() throws {
        let group = MessageOrigin(channel: "telegram", title: "Team", chatId: "-1001", url: "https://t.me/c/1/7", canReply: true)
        let privateChat = MessageOrigin(channel: "telegram", title: "Mik", chatId: "42", canReply: true)
        let linked = message("request", origin: group)
        let unlinked = message("private", origin: privateChat)
        let link = try #require(URL(string: "https://t.me/c/1/7"))
        for state in ["not_sent", "unknown"] {
            let reply = message("reply", direction: "outbound", replyTo: "request", origin: group, delivery: state)
            #expect(MessagePages.deliveryAction(for: reply, in: [linked, reply], canReply: true) == .open(link))
            let local = message("reply", direction: "outbound", replyTo: "private", origin: privateChat, delivery: state)
            #expect(MessagePages.deliveryAction(for: local, in: [unlinked, local], canReply: true) == .resend(unlinked))
            #expect(MessagePages.deliveryAction(for: local, in: [unlinked, local], canReply: false) == nil)
            #expect(MessagePages.deliveryAction(for: local, in: [local], canReply: true) == nil)
        }
        for state in ["delivered", "pending", nil] as [String?] {
            let reply = message("reply", direction: "outbound", replyTo: "request", origin: group, delivery: state)
            #expect(MessagePages.deliveryAction(for: reply, in: [linked, reply], canReply: true) == nil)
        }
    }

    @Test func aRuleGroupMessageJoinsTheFeedOnlyOnceTheEmployeeTakesIt() {
        let rules = MessageOrigin(channel: "telegram", title: "Rules", chatId: "-1")
        let mentions = MessageOrigin(channel: "telegram", title: "Mentions", chatId: "-2")
        let feed = [
            message("deciding", status: "running", origin: rules),
            message("queued", status: "queued", origin: rules),
            message("taken", origin: rules),
            message("failed", status: "failed", origin: rules),
            message("mentioned", status: "running", origin: mentions),
            message("app", channel: "api", status: "running", origin: MessageOrigin(channel: "api", title: "")),
        ]
        #expect(MessagePages.feed(feed, decidingChats: ["-1"]).map(\.id) == ["taken", "failed", "mentioned", "app"])
        #expect(MessagePages.feed(feed, decidingChats: []).map(\.id) == feed.map(\.id))
    }

    @Test func aRequestWaitingForTheOwnersApprovalStaysVisibleWithItsCard() {
        let rules = MessageOrigin(channel: "telegram", title: "Rules", chatId: "-1")
        let feed = [message("asking", status: "running", origin: rules), message("deciding", status: "running", origin: rules)]
        #expect(MessagePages.feed(feed, decidingChats: ["-1"], awaiting: ["asking"]).map(\.id) == ["asking"])
    }

    /// Group B's reply follows group A's request on screen, so it names group B again and quotes its request.
    @Test func eachRowFollowsTheRowShownAboveItNotAHiddenMessage() {
        let a = MessageOrigin(channel: "telegram", title: "A", chatId: "-1"), b = MessageOrigin(channel: "telegram", title: "B", chatId: "-2")
        let feed = MessagePages.feed([
            message("requestB", origin: b, conversation: "b"),
            message("requestA", origin: a, conversation: "a"),
            message("hiddenB", status: "queued", origin: b, conversation: "b"),
            message("replyB", direction: "outbound", replyTo: "requestB", origin: b, conversation: "b"),
        ], decidingChats: ["-2"])
        let rows = MessagePages.rows(feed)
        #expect(rows.map(\.id) == ["requestB", "requestA", "replyB"])
        #expect(rows.map(\.previous?.id) == [nil, "requestB", "requestA"])
    }
}
