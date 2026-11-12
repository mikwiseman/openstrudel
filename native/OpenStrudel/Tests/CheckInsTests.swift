import Foundation
import Testing

@MainActor
@Suite("Daily polls as a board") struct CheckInsTests {
    /// Fourteen local dates, 1 to 14 November; the Home's today is the 14th.
    private let dates = (1...14).map { String(format: "2026-11-%02d", $0) }

    /// A poll whose people answered the days given, oldest first; nil is a day without an answer.
    private func poll(_ id: String, _ name: String, question: String = "Вопрос", chat: String = "circle", _ answers: [String: [Int?]], streak: Int = 1) -> HomeActivity.CheckIn {
        let days = dates.enumerated().map { index, date in
            HomeActivity.CheckIn.Day(date: date, values: answers.compactMapValues { index < $0.count ? $0[index] : nil })
        }
        let people = answers.keys.sorted().map { HomeActivity.CheckIn.Participant(id: $0, name: $0 == "42" ? "Аня Лодочкина" : "М. К.", streak: streak, latest: nil, average: nil) }
        return HomeActivity.CheckIn(id: id, name: name, question: question, conversationId: chat, chat: "Вечерний круг", scale: 10, today: "2026-11-14", days: days, participants: people)
    }

    private func steady(_ value: Int) -> [Int?] { Array(repeating: value, count: 14) }

    @Test func thePollsOfOneChatAreOneBoardNamedByWhatTheirNamesShare() throws {
        let boards = CheckInBoard.boards([
            poll("calm", "Пульс · спокойствие", ["42": steady(6), "77": steady(5)], streak: 3),
            poll("focus", "Пульс · фокус", ["42": steady(7)], streak: 9),
            poll("mood", "Настроение дня", question: "Настроение: как вы себя чувствовали?", chat: "family", ["42": steady(8)]),
            poll("plain", "Сон", question: "Сколько часов вы спали сегодня ночью, если честно?", chat: "sleep", ["42": steady(7)]),
        ])
        #expect(boards.map(\.id) == ["circle", "family", "sleep"])
        let pulse = try #require(boards.first)
        #expect(pulse.title == "Пульс" && pulse.measures.map(\.label) == ["Спокойствие", "Фокус"])
        // Everyone who answered any of the questions, once; the streak is the longest the Home counted.
        #expect(pulse.people.map(\.id) == ["42", "77"] && pulse.people.map(\.streak) == [9, 3])
        #expect(pulse.dates == dates && pulse.today == "2026-11-14")
        // A lone poll is named by its chat; its measure by the head of its question, or by its own name.
        #expect(boards[1].title == "Вечерний круг" && boards[1].measures.map(\.label) == ["Настроение"])
        #expect(boards[2].measures.map(\.label) == ["Сон"])
        #expect(CheckInBoard.boards([]).isEmpty)
    }

    @Test func aDayWithoutAnAnswerIsMissingNeverZero() throws {
        // Nobody has answered the 14th yet, and the second person skipped the 12th.
        let board = try #require(CheckInBoard.boards([poll("calm", "Пульс · спокойствие", [
            "42": [nil, nil, nil, nil, nil, nil, nil, 4, 5, 6, 7, 8, 9, nil], "77": [nil, nil, nil, nil, nil, nil, nil, 2, 2, 2, 2, nil, 2, nil]])]).first)
        let calm = board.measures[0], anya = board.people[0], mark = board.people[1]
        #expect(board.latestDay == "2026-11-13")
        #expect(board.value(calm, anya, on: "2026-11-13") == 9 && board.value(calm, mark, on: "2026-11-12") == nil && board.value(calm, anya, on: "2026-11-14") == nil)
        #expect(board.thisWeek == Array(dates.suffix(7)) && board.lastWeek == Array(dates.prefix(7)) && board.charted == dates)
        let week = try #require(board.mean(calm, anya, over: board.thisWeek))
        #expect(week.value == 6.5 && week.answers == 6)
        #expect(board.mean(calm, mark, over: board.thisWeek)?.value == 2 && board.mean(calm, mark, over: board.thisWeek)?.answers == 5)
        #expect(board.mean(calm, anya, over: board.lastWeek) == nil)
        // A board nobody has answered has no latest day, so the home keeps no tile for it.
        #expect(CheckInBoard.boards([poll("calm", "Пульс · спокойствие", ["42": []])]).first?.latestDay == nil)
    }

    @Test func whatStandsOutNeedsEnoughAnswersAndLeadsWithTheStrongest() throws {
        let board = try #require(CheckInBoard.boards([
            // Her energy on the latest day is far above her usual; his calm fell by two and a half against the week before.
            poll("energy", "Пульс · энергия", ["42": [6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 9], "77": steady(7)]),
            poll("calm", "Пульс · спокойствие", ["42": steady(7), "77": [7, 7, 7, 7, 6, 6, 6, 4, 4, 4, 4, 4, 5, 4]]),
            poll("mood", "Пульс · настроение", ["42": steady(7), "77": steady(6)]),
        ]).first)
        let found = board.standouts(on: "2026-11-14")
        #expect(found.map(\.id) == ["week:calm:77", "unusual:energy:42", "apart:calm"])
        #expect(found[0].kind == .week(now: 29.0 / 7, before: 46.0 / 7) && found[0].person == "М. К." && found[0].measure == "Спокойствие")
        #expect(found[1].kind == .unusual(value: 9, usual: 6))
        #expect(found[2].person == nil)
        #expect(board.standouts(on: "2026-11-14", limit: 1).count == 1)
        // His calm also sits well under his own energy and mood this week: said after the stronger three.
        let all = board.standouts(on: "2026-11-14", limit: 9)
        #expect(all.map(\.id) == ["week:calm:77", "unusual:energy:42", "apart:calm", "low:calm:77"])
        #expect(all[3].kind == .low(mean: 29.0 / 7, others: 6.5))
        #expect(CheckInWords(language: .russian).text(all[3]) == "За неделю 4,1, остальное около 6,5")
        // Two answers are not a usual, and a point of difference between two people is not worth a sentence.
        let thin = try #require(CheckInBoard.boards([poll("energy", "Пульс · энергия", ["42": [nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, 5, 5, 10], "77": [nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, 6, 6, 6]])]).first)
        #expect(thin.standouts(on: "2026-11-14").isEmpty)
    }

    @Test func theWordsNameTheDayAndNeverInventAChange() throws {
        let words = CheckInWords(language: .russian), english = CheckInWords(language: .english)
        #expect(words.day("2026-11-14", today: "2026-11-14") == "Сегодня" && words.day("2026-11-13", today: "2026-11-14") == "Вчера")
        #expect(words.day("2026-11-09", today: "2026-11-14") == "Понедельник, 9 ноября")
        // The day is the Home's own: its weekday holds on a device in any time zone.
        #expect(english.day("2026-11-09", today: "2026-11-14") == "Monday, November 9" || english.day("2026-11-09", today: "2026-11-14") == "Monday, 9 November")
        #expect(words.shortDay("2026-11-14", today: "2026-11-14") == "сегодня" && words.shortDay("2026-11-01", today: "2026-11-14") == "1 нояб.")
        #expect(words.change(0.84) == "+0,8" && words.change(-1.2) == "−1,2" && words.change(0.04) == nil)
        #expect(words.number(6.25) == "6,2" || words.number(6.25) == "6,3")
        #expect(CheckInBoard.short("Аня Лодочкина") == "Аня" && CheckInBoard.short("М. К.") == "М. К." && CheckInBoard.short("Mik") == "Mik")
        let standout = CheckInBoard.Standout(id: "x", person: "Аня Лодочкина", measure: "Энергия", kind: .unusual(value: 9, usual: 6), weight: 3)
        #expect(words.title(standout) == "Энергия · Аня" && words.text(standout) == "9, обычно около 6")
        let apart = CheckInBoard.Standout(id: "y", person: nil, measure: "Спокойствие", kind: .apart(high: "Аня Лодочкина", highMean: 7, low: "М. К.", lowMean: 4.5), weight: 2.5)
        #expect(words.title(apart) == "Спокойствие" && words.text(apart) == "За неделю: Аня 7 · М. К. 4,5")
    }

    @Test func theHomeShowsABoardOnlyOnceSomeoneHasAnswered() throws {
        func activity(_ answers: [Int?], kind: String = "result") throws -> HomeActivity {
            let item = poll("calm", "Пульс · спокойствие", ["42": answers])
            let days = item.days.map { "{\"date\":\"\($0.date)\",\"values\":{\($0.values.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ","))}}" }.joined(separator: ",")
            return try JSONDecoder().decode(HomeActivity.self, from: Data("""
            {"checkedAt":"2026-11-14T17:00:00.000Z","period":{"start":"2026-11-08T00:00:00.000Z","end":"2026-11-14T17:00:00.000Z","timeZone":"Europe/Moscow"},
             "insights":[{"id":"r","kind":"\(kind)","title":"План на утро","text":"Готово","occurredAt":"2026-11-14T10:00:00.000Z","conversationId":"c","profileId":"p","employeeName":"Тренер","messageId":"m","status":"completed"}],
             "checkIns":[{"id":"calm","name":"Пульс · спокойствие","question":"Вопрос","conversationId":"circle","chat":"Вечерний круг","scale":10,"today":"2026-11-14","days":[\(days)],
               "participants":[{"id":"42","name":"Аня","streak":2,"latest":null,"average":null}]}],
             "progress":{"activeDays":1,"completedRequests":0,"completedRuns":0,"quietRuns":0,"failedRuns":0,"activeSchedules":1,"milestones":[]}}
            """.utf8))
        }
        // The day's answers are a tile; what was done and what needs the owner are not: they lead the home as cards.
        let tiles = Shelf.tiles(desks: [], activity: try activity(steady(6)), next: nil)
        #expect(tiles.map(\.id) == ["checkIns"])
        #expect(tiles.first?.place == .checkIns)
        #expect(Shelf.tiles(desks: [], activity: try activity(steady(6), kind: "attention"), next: nil).map(\.id) == ["checkIns"])
        #expect(Shelf.tiles(desks: [], activity: try activity([]), next: nil).isEmpty)
    }
}
