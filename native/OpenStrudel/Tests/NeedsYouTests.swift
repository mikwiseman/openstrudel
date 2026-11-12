import Foundation
import Testing

/// What waits for the owner: a Home's own cards as it sends them, what an older Home's rows and chat already tell,
/// the order of the list, and what this device sets aside. Every name and sentence here is invented.
@Suite(.serialized)
@MainActor struct NeedsYouTests {
    private static let moscow: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Moscow")!
        return calendar
    }()
    /// Tuesday 10 November 2026, 14:50 in Moscow.
    private static let now = instant("2026-11-10T11:50:00.000Z")
    private static func instant(_ text: String) -> Date { try! Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) }

    private func member(_ id: String, _ name: String, home: String = "home") throws -> TeamMember {
        let profile = try JSONDecoder().decode(EmployeeProfile.self, from: Data(#"{"id":"\#(id)","name":"\#(name)","instructions":"","capabilities":[],"model":null,"tokenLimit":null,"createdAt":"2026-01-01T00:00:00.000Z","failing":true}"#.utf8))
        return TeamMember(profile: profile, route: ReaderRoute(connectionID: home, kind: .employee(id), title: name))
    }
    private func interaction(_ json: String) throws -> ChatInteraction { try JSONDecoder().decode(ChatInteraction.self, from: Data(json.utf8)) }
    private func card(_ id: String, _ kind: NeedCard.Kind, at: Date? = nil) -> NeedCard {
        NeedCard(id: id, home: "home", kind: kind, origin: .card(id), employee: "Scout", title: id, at: at)
    }

    @Test func aFailingEmployeeIsACardThatSaysWhyAndSinceWhen() throws {
        let scout = try member("p1", "Scout")
        let words = TeamWords(language: .russian, calendar: Self.moscow)
        let told = NeedsYou.failing(scout, failure: .init(since: Self.instant("2026-11-10T04:15:00.000Z"), reason: "Закончился лимит модели."), words: words, now: Self.now)
        #expect(told.kind == .failed && told.profileID == "p1" && told.employee == "Scout" && told.home == "home")
        // What is true leads; since when stands under it.
        #expect(told.title == "Закончился лимит модели." && told.text == "Не получается с 07:15.")
        #expect(told.actions.map(\.id) == [NeedsYou.open, NeedsYou.later])
        #expect(told.origin == .failing(scout.route) && !told.readsFirst)
        // A Home that does not say why still says that it failed, and it is the same card.
        let silent = NeedsYou.failing(scout, failure: nil, words: words, now: Self.now)
        #expect(silent.title == "Последний запуск не получился" && silent.text == nil && silent.id == told.id)
        // A run's long complaint is cut between words, never mid-word.
        let long = NeedsYou.failing(scout, failure: .init(since: nil, reason: String(repeating: "слово ", count: 40)), words: words, now: Self.now)
        #expect(long.title.count <= 121 && long.title.hasSuffix("…"))
    }

    @Test func aShortQuestionIsAnsweredWhereItIsSeenAndALongOneInItsChat() throws {
        let choice = try interaction(#"{"id":"i1","conversationId":"c","messageId":"m","title":"Письмо в «Клён» готово","detail":"Отправлю его сегодня.\n\n{\"to\":\"reader@example.com\"}","url":null,"questions":[{"id":"decision","question":"","options":["Отправить","Не сейчас"]}]}"#)
        let short = NeedsYou.question(choice, home: "home", assistant: "OpenStrudel")
        #expect(short.kind == .answer && short.profileID == nil && short.employee == "OpenStrudel")
        // The sentence is said; the arguments the Home appended are for the chat's own card.
        #expect(short.title == "Письмо в «Клён» готово" && short.text == "Отправлю его сегодня.")
        #expect(short.actions.map(\.id) == ["option:Отправить", "option:Не сейчас"])
        // A yes-or-no decision leads with its yes, as its card in the chat does.
        #expect(short.actions.map(\.role) == [.primary, .plain])
        // Words to type, several questions, a link to open or a long list of choices are answered in the chat.
        let typed = try interaction(#"{"id":"i2","conversationId":"c","messageId":"m","title":"Нужен адрес","detail":null,"url":null,"questions":[{"id":"q","question":"Куда доставить?","options":[]}]}"#)
        #expect(NeedsYou.question(typed, home: "home", assistant: "OpenStrudel").actions.map(\.id) == [NeedsYou.open])
        #expect(NeedsYou.question(typed, home: "home", assistant: "OpenStrudel").text == "Куда доставить?")
        let two = try interaction(#"{"id":"i3","conversationId":"c","messageId":"m","title":"Два вопроса","detail":null,"url":null,"questions":[{"id":"a","question":"Первый?","options":["Да","Нет"]},{"id":"b","question":"Второй?","options":["Да","Нет"]}]}"#)
        #expect(NeedsYou.question(two, home: "home", assistant: "OpenStrudel").actions.map(\.id) == [NeedsYou.open])
        let many = try interaction(#"{"id":"i4","conversationId":"c","messageId":"m","title":"Выбор","detail":null,"url":null,"questions":[{"id":"a","question":"Какой?","options":["1","2","3","4"]}]}"#)
        #expect(NeedsYou.question(many, home: "home", assistant: "OpenStrudel").actions.map(\.id) == [NeedsYou.open])
        // Two Homes can ask the same thing; each card is its own.
        #expect(NeedsYou.question(choice, home: "cabin", assistant: "OpenStrudel").id != short.id)
    }

    @Test func aQuestionInAChatLeadsThenDecisionsThenFailuresEachOldestFirst() throws {
        let now = Self.now, hour = 3600.0
        let asked = NeedsYou.question(try interaction(#"{"id":"i1","conversationId":"c","messageId":"m","title":"Вопрос","detail":null,"url":null,"questions":[{"id":"q","question":"Да?","options":["Да","Нет"]}]}"#), home: "home", assistant: "OpenStrudel")
        let cards = [card("failed-new", .failed, at: now - hour), card("send-new", .send, at: now - hour), card("failed-old", .failed, at: now - 30 * hour),
                     card("due", .due, at: now - 3 * hour), asked, card("connect-old", .connect, at: now - 50 * hour)]
        #expect(NeedsYou.ordered(cards).map(\.id) == [asked.id, "connect-old", "due", "send-new", "failed-old", "failed-new"])
        // Equal cards keep the order their Homes gave them.
        #expect(NeedsYou.ordered([card("b", .answer), card("a", .answer)]).map(\.id) == ["b", "a"])
    }

    @Test func aDayIsSaidAsAPersonWould() throws {
        let now = Self.now, day = 86_400.0
        #expect(NeedsYou.until(now + day, now: now, language: .english) == "tomorrow")
        #expect(NeedsYou.until(now, now: now, language: .english) == "today")
        #expect(NeedsYou.until(now + 3 * day, now: now, language: .english) == "in 3 days")
        #expect(NeedsYou.until(now - day, now: now, language: .english) == "yesterday")
        #expect(NeedsYou.until(now + day, now: now, language: .russian) == "завтра")
        // The Home writes a day as a local calendar date; it is that day here too, whatever the hour.
        let promised = try #require(NeedsYou.day("2026-11-14", calendar: Self.moscow))
        #expect(Self.moscow.dateComponents([.year, .month, .day], from: promised) == DateComponents(year: 2026, month: 11, day: 14))
        #expect(NeedsYou.until(promised, now: now, language: .english, calendar: Self.moscow) == "in 4 days")
        #expect(NeedsYou.day(nil) == nil && NeedsYou.day("soon") == nil)
    }

    @Test func aHomesOwnCardsAreReadAsItSendsThem() throws {
        let sent = try JSONDecoder().decode(HomeCards.self, from: Data(#"""
        {"open":[
          {"id":"c1","kind":"send","state":"open","createdAt":"2026-11-09T09:00:00.000Z","raiser":{"profileId":"p1","name":"Юрист"},"conversationId":"k1",
           "title":"Отправить ответ в «Клён»?","reason":"Без него заявку отклонят 12 ноября.",
           "content":{"to":"Клён","via":"Почта","subject":"Re: заявка","text":"Добрый день.","details":[{"label":"Копия","value":"reader@example.com"}]},
           "choices":[{"id":"send","label":"Отправить","role":"primary"},{"id":"draft","label":"Оставить черновиком","role":"plain"}],
           "chat":null,"for":null,"canAnswer":true,"answer":null,"somethingNew":{"deep":[1,2]}},
          {"id":"c2","kind":"answer","state":"open","createdAt":"2026-11-10T08:00:00.000Z","raiser":{"profileId":null,"name":"OpenStrudel"},"conversationId":"k2",
           "title":"Кофейня, 3 €","reason":null,"content":{},
           "choices":[{"id":"c0","label":"Да","role":"primary"},{"id":"other","label":"Другое","role":"plain","needsText":true}],
           "chat":{"id":"-100","title":"Команда"},"for":[{"id":"7001","name":"Марк"}],"canAnswer":false,"answer":null},
          {"id":"c3","kind":"due","state":"open","createdAt":"2026-11-10T08:30:00.000Z","raiser":{"profileId":"p2","name":"Продажи"},"conversationId":"k3",
           "title":"Позвонить в «Берёзу»","reason":null,"content":{"due":"2026-11-14"},
           "choices":[{"id":"done","label":"Готово","role":"primary"},{"id":"date","label":"Новая дата","role":"plain","needsText":true}],"canAnswer":true,"answer":null},
          {"id":"c4","kind":"connect","state":"open","createdAt":"2026-11-10T09:00:00.000Z","raiser":{"profileId":"p2","name":"Продажи"},"conversationId":"k3",
           "title":"Нет доступа к таблице","reason":null,"content":{"url":"https://example.com/access"},
           "choices":[{"id":"open","label":"Открыть","role":"link"},{"id":"done","label":"Готово","role":"plain"}],"canAnswer":true,"answer":null},
          {"id":"c5","kind":"failed","state":"open","createdAt":"2026-11-10T04:05:00.000Z","raiser":{"profileId":"p1","name":"Юрист"},"conversationId":"k1",
           "title":"Утренний обзор не пришёл","reason":"Закончился лимит.","content":{"nextTry":"2026-11-10T07:00:00.000Z"},
           "choices":[{"id":"ok","label":"Понятно","role":"primary"}],"canAnswer":true,"answer":null},
          {"id":"c6","kind":"something-new","title":"Не для этой версии"}
        ],
        "recent":[
          {"id":"c0","kind":"send","state":"answered","createdAt":"2026-11-10T07:00:00.000Z","raiser":{"profileId":null,"name":"OpenStrudel"},"conversationId":"k2",
           "title":"Отправить Марку?","reason":null,"content":{"to":"Марк","via":"Telegram","text":"Встретимся в десять."},"choices":[],"canAnswer":true,
           "answer":{"choice":"send","label":"Отправить","text":null,"by":"Аня","via":"telegram","at":"2026-11-10T07:01:00.000Z","outcome":"Отправлено: Команда"}}
        ]}
        """#.utf8))
        let cards = sent.open.compactMap { $0.card(home: "home") }
        // A kind this version does not know is left out rather than drawn wrong; fields it does not know are passed over.
        #expect(cards.map(\.id) == ["home:c1", "home:c2", "home:c3", "home:c4", "home:c5"])
        let letter = cards[0]
        #expect(letter.kind == .send && letter.origin == .card("c1") && letter.employee == "Юрист" && letter.profileID == "p1" && letter.text == "Без него заявку отклонят 12 ноября.")
        #expect(letter.draft == NeedCard.Draft(to: "Клён", via: "Почта", subject: "Re: заявка", text: "Добрый день.") && letter.readsFirst)
        #expect(letter.details == [.init(label: "Копия", value: "reader@example.com")] && letter.at == Self.instant("2026-11-09T09:00:00.000Z"))
        #expect(letter.actions == [.init(id: "send", label: "Отправить", role: .primary), .init(id: "draft", label: "Оставить черновиком")])
        #expect(letter.waitsFor == nil && letter.decision == nil)
        // A card for someone this device cannot answer for names who it waits for; a choice in words is marked so.
        let coffee = cards[1]
        #expect(coffee.profileID == nil && coffee.employee == "OpenStrudel" && coffee.text == nil && !coffee.readsFirst && coffee.waitsFor == ["Марк"])
        #expect(coffee.actions.map(\.needsText) == [false, true])
        // A promise has its day, an access its link, a failure its next try.
        #expect(cards[2].due == NeedsYou.day("2026-11-14") && cards[2].actions.last?.needsText == true)
        #expect(cards[3].actions.first == .init(id: "open", label: "Открыть", role: .link, url: URL(string: "https://example.com/access")))
        #expect(cards[4].nextTry == Self.instant("2026-11-10T07:00:00.000Z") && cards[4].kind == .failed)
        // What was decided keeps how, by whom and when.
        let decided = try #require((sent.recent ?? []).compactMap { $0.card(home: "home") }.first)
        #expect(decided.decision == NeedCard.Decision(words: "Отправлено: Команда", by: "Аня", at: Self.instant("2026-11-10T07:01:00.000Z")))
    }

    @Test func theModelKeepsEachHomesOpenAndDecidedCardsApart() throws {
        let model = NeedsYouModel(defaults: try #require(UserDefaults(suiteName: "OpenStrudel.needs." + UUID().uuidString)))
        let cards = try JSONDecoder().decode(HomeCards.self, from: Data(#"""
        {"open":[{"id":"a","kind":"failed","title":"Обзор не пришёл","choices":[{"id":"ok","label":"Понятно","role":"primary"}]}],
         "recent":[{"id":"b","kind":"due","title":"Позвонить","answer":{"label":"Готово","by":"OpenStrudel app","via":"app","at":"2026-11-10T07:01:00.000Z","outcome":null}}]}
        """#.utf8))
        model.take(cards, from: "home")
        model.take(try JSONDecoder().decode(HomeCards.self, from: Data(#"{"open":[],"recent":[]}"#.utf8)), from: "cabin")
        #expect(model.listed["home"]?.map(\.id) == ["home:a"] && model.listed["cabin"] == [])
        // Without what the Home did, the button's own word is the decision; this app is not named as who decided.
        #expect(model.decided["home"]?.first?.decision == NeedCard.Decision(words: "Готово", by: nil, at: Self.instant("2026-11-10T07:01:00.000Z")) && model.decided["cabin"] == [])
        // A choice answered in words says them after the button.
        let worded = try JSONDecoder().decode(HomeCards.self, from: Data(#"""
        {"open":[],"recent":[{"id":"d","kind":"due","title":"Позвонить","answer":{"choice":"date","label":"Новая дата","text":"в пятницу","by":"Марк","via":"telegram","at":"2026-11-10T07:01:00.000Z","outcome":null}}]}
        """#.utf8))
        model.take(worded, from: "home")
        #expect(model.decided["home"]?.first?.decision?.words == "Новая дата: в пятницу" && model.decided["home"]?.first?.decision?.by == "Марк")
    }

    @Test func aCardSetAsideIsOutOfSightUntilTomorrowMorningOnThisDevice() throws {
        let suite = "OpenStrudel.needs." + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { UserDefaults.standard.removePersistentDomain(forName: suite) }
        let model = NeedsYouModel(defaults: defaults), scout = NeedsYou.failing(try member("p1", "Scout"), failure: nil)
        #expect(model.aside.isEmpty)
        let now = Date.now
        model.setAside(scout, now: now)
        let back = try #require(model.aside[scout.id])
        #expect(Calendar.current.component(.hour, from: back) == 6 && !Calendar.current.isDate(back, inSameDayAs: now) && back.timeIntervalSince(now) < 2 * 86_400)
        // After a relaunch too.
        #expect(NeedsYouModel(defaults: defaults).aside[scout.id] == back)
    }
}
