import XCTest

/// Runs against tests/fixtures/team.ts on a disposable simulator. Home is the root: what waits as a card, today's work
/// as tiles, the team as one list, one composer capsule and search; there is no tab bar. Every place opens from a card,
/// a tile or a row and leads back.
final class TeamUITests: XCTestCase {
    private var control = ""
    private let environment = ProcessInfo.processInfo.environment

    /// A new install: the bun, one sentence, one button.
    @MainActor
    func testANewInstallOpensOnTheWelcome() throws {
        guard environment["OPENSTRUDEL_TEAM_FIXTURE"] != nil else { throw XCTSkip("Start tests/fixtures/team.ts and pass its control URL.") }
        let app = launch()
        XCTAssertTrue(app.buttons["scanInvitation"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.buttons["pasteInvitation"].exists)
        XCTAssertEqual(app.tabBars.count, 0)
        capture("welcome", app)
    }

    @MainActor
    func testTheHomeItsPlacesAndTheOneComposer() async throws {
        continueAfterFailure = false
        guard let fixture = environment["OPENSTRUDEL_TEAM_FIXTURE"] else { throw XCTSkip("Start tests/fixtures/team.ts and pass its control URL.") }
        control = fixture
        let app = launch()
        // The second Home first: the Home paired last is the chat's.
        try await pair(app, "/invite2")
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { capture("consent", app); consent.tap() }
        try await pair(app, "/invite")
        let state = try await read("/")
        let id: (String) throws -> String = { key in try XCTUnwrap(state[key] as? String) }

        // 1. Home is the first screen: no tab bar, the wordmark, the shelf, the team, and one way to write.
        let home = app.descendants(matching: .any)["homeRoot"]
        XCTAssertTrue(home.waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertEqual(app.tabBars.count, 0, "What waits, Progress and Statistics open from the home itself")
        XCTAssertTrue(app.staticTexts["OpenStrudel"].firstMatch.exists, app.debugDescription)
        let composer = app.buttons["homeComposer"], search = app.buttons["openChats"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10) && search.exists, app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists, "The home's capsule opens the composer; it is not a second one")

        // 2. The chat first, then one list: who has something waiting, who is working, then the latest answers.
        let lead = app.buttons["teamLead"]
        let rows = try ["news", "startups", "failing", "working", "fresh"].map { app.buttons["teamMember-" + (try id($0))] }
        XCTAssertTrue(lead.waitForExistence(timeout: 10), app.debugDescription)
        for row in rows { XCTAssertTrue(row.waitForExistence(timeout: 20), app.debugDescription) }
        XCTAssertEqual(rows.map(\.label), ["News", "Startups", "Репетитор", "Рецепты", "Тренер"])
        for row in [lead] + rows { XCTAssertGreaterThanOrEqual(row.frame.height, 44) }
        let failing = rows[2], working = rows[3], fresh = rows[4]
        try await expect(working, says: "Работает…")
        try await expect(failing, says: "Не получилось")
        XCTAssertFalse(value(fresh).contains("Есть новое"), "Everything written before the first meeting counts as seen")
        // A result that says what is now true is shown by that line, not by the report's first words.
        try await expect(fresh, says: "План на утро готов: двадцать минут.")

        XCTAssertLessThan(lead.frame.minY, failing.frame.minY)
        XCTAssertLessThan(failing.frame.minY, working.frame.minY, "Whoever has something waiting comes first")
        for row in [rows[0], rows[1], fresh] { XCTAssertLessThan(working.frame.minY, row.frame.minY, "Then whoever is working") }

        // 2a. Two Homes make one list. A Home is a word on a row and a filter over the list: «Все», then each Home by
        // name. An employee pinned from its menu stands right under the chat.
        let all = app.buttons["teamHome-all"]
        let office = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "teamHome-", "Тестовый Mac")).firstMatch
        let cabin = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "teamHome-", "Дачный Mac")).firstMatch
        let gardener = app.buttons["teamMember-" + (try id("gardener"))]
        XCTAssertTrue(all.waitForExistence(timeout: 10) && office.exists && cabin.exists, app.debugDescription)
        XCTAssertTrue(all.isSelected && !cabin.isSelected, app.debugDescription)
        XCTAssertTrue(gardener.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(value(gardener).contains("Дачный Mac"), "Another Home's employee says where it lives")
        XCTAssertFalse(value(fresh).contains("Тестовый Mac"), "The chat's own Home goes without saying")
        bring(all, in: app)
        capture("home-all", app)
        office.tap()
        XCTAssertTrue(gardener.waitForNonExistence(timeout: 10), app.debugDescription)
        cabin.tap()
        XCTAssertTrue(gardener.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(fresh.waitForNonExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "teamAssistant-")).firstMatch.exists, "Its own assistant is listed with it")
        XCTAssertTrue(cabin.isSelected)
        capture("home-one-home", app)
        all.tap()
        XCTAssertTrue(fresh.waitForExistence(timeout: 10), app.debugDescription)
        bring(fresh, in: app)
        fresh.press(forDuration: 1.2)
        let pin = app.buttons["Закрепить"]
        XCTAssertTrue(pin.waitForExistence(timeout: 5), app.debugDescription); pin.tap()
        try await expect(fresh, says: "Закреплено")
        XCTAssertLessThan(fresh.frame.minY, failing.frame.minY, "A pinned employee stands above the rest")
        for _ in 0..<3 { home.swipeDown() }
        capture("home-pinned", app)
        bring(fresh, in: app)
        fresh.press(forDuration: 1.2)
        let unpin = app.buttons["Открепить"]
        XCTAssertTrue(unpin.waitForExistence(timeout: 5), app.debugDescription); unpin.tap()
        XCTAssertFalse(value(fresh).contains("Закреплено"))
        for _ in 0..<3 { home.swipeDown() }

        // 2b. What waits leads the home: the employee whose run failed is one card that says so, with its step. Its
        // page lists every card whole. Set aside until tomorrow, the card leaves and one calm sentence stays.
        let count = app.buttons["needsCount"], later = app.buttons["needAction-later"]
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "need-failing:")).firstMatch
        XCTAssertTrue(count.waitForExistence(timeout: 20) && card.exists && later.exists, app.debugDescription)
        XCTAssertTrue(card.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Репетитор")).firstMatch.exists, card.debugDescription)
        capture("home-needs", app)
        count.tap()
        XCTAssertTrue(app.descendants(matching: .any)["insightsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(card.waitForExistence(timeout: 10) && later.exists, app.debugDescription)
        capture("needs", app)
        back(app)
        app.buttons["needAction-open"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["reader"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(app.buttons["readerTitle"].value as? String, "Репетитор")
        back(app)
        XCTAssertTrue(later.waitForExistence(timeout: 10), app.debugDescription); later.tap()
        let calm = app.buttons["needsCalm"]
        XCTAssertTrue(calm.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(card.exists)
        try await expect(failing, says: "Не получилось")
        capture("home-calm", app)

        // 3. The shelf holds answers: each desk's lead, the polls, the next run. No gauges: the limit is a figure at the
        // foot of the home.
        let desk = app.buttons["tile-desk:" + (try newsRoute(app, rows[0]))].firstMatch
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tile-desk:")).firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.buttons["tile-next"].waitForExistence(timeout: 20), app.debugDescription)
        for gone in ["tile-important", "tile-limit", "tile-progress"] { XCTAssertFalse(app.buttons[gone].exists, gone) }
        _ = desk
        // The picture comes from the fixture itself; give it a moment before the first look.
        try await Task.sleep(for: .seconds(2))
        capture("home", app)
        // What scrolls up closes into the paper before it reaches the clock.
        home.swipeUp(velocity: .slow)
        capture("home-scrolled", app)
        home.swipeDown()

        // 4. A result lands while the home is in sight: its row says so within a few seconds.
        _ = try await read("/arrive")
        try await expect(fresh, says: "Есть новое")
        try await expect(fresh, says: "лёгкий бег")

        // 5. An ordinary employee: a calm feed under one quiet line, and one capsule to ask about it.
        open(fresh, in: app)
        XCTAssertTrue(app.descendants(matching: .any)["reader"].waitForExistence(timeout: 10), app.debugDescription)
        let rhythm = app.buttons["employeeRhythm"]
        XCTAssertTrue(rhythm.waitForExistence(timeout: 15), app.debugDescription)
        try await expectLabel(rhythm, says: "Каждый день в")
        // One line that never wraps: the rhythm and the next run's day; «и ещё 1» is always spoken, shown when it fits.
        XCTAssertTrue(rhythm.label.contains("следующий") && rhythm.label.contains("и ещё 1") && !rhythm.label.contains("ноября"), rhythm.label)
        if environment["OPENSTRUDEL_TEXT_SIZE"] == nil { XCTAssertLessThan(rhythm.frame.height, 60, "The page's head is one line") }
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "памятке о приседаниях")).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "](<")).firstMatch.exists, "A link written with an angle-bracket address reads as a link")
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        capture("employee", app)
        // The quiet line opens the details, where a schedule can be paused.
        rhythm.tap()
        XCTAssertTrue(app.buttons["saveEmployeeChanges"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["saveEmployeeChanges"].tap()
        // «Спросить про…» takes its latest words to the one composer, with the keyboard up.
        let ask = app.buttons["discussLatest"]
        XCTAssertTrue(ask.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(ask.label, "Спросить про Тренер")
        ask.tap()
        let field = app.textFields["Сообщение"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
        // A fresh simulator explains its keyboard once.
        let tip = app.buttons["Continue"]
        if tip.waitForExistence(timeout: 3) { tip.tap() }
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "draftContext", "Из переписки · Тренер")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10), app.debugDescription)
        capture("chat-context", app)
        app.buttons["removeDraftContext"].tap()
        // Back leads to the page the chat was opened from, then home; what was on screen is read.
        back(app)
        XCTAssertTrue(rhythm.waitForExistence(timeout: 10), app.debugDescription)
        back(app)
        XCTAssertTrue(fresh.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(value(fresh).contains("Есть новое"), value(fresh))

        // 6. A run that failed is said on the employee's page, with since when and why.
        open(failing, in: app)
        let failure = app.buttons["readerFailing"]
        XCTAssertTrue(failure.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(failure.label.contains("Не получается с") && failure.label.contains("Закончился лимит модели."), failure.label)
        capture("employee-failing", app)
        back(app)

        // 7. The working employee finishes: its row stops saying so.
        _ = try await read("/release")
        try await expect(working, says: "Меню на неделю готово")
        XCTAssertFalse(value(working).contains("Работает…"))

        // 8. A desk and one of its stories.
        rows[0].tap()
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any)["newsStatus"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Выпуск"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["discussDesk"].waitForExistence(timeout: 10), app.debugDescription)
        try await Task.sleep(for: .seconds(2))
        capture("desk", app)
        let story = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Клён 3")).firstMatch
        XCTAssertTrue(story.waitForExistence(timeout: 10), app.debugDescription); story.tap()
        XCTAssertTrue(app.scrollViews["newsStory"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["discussStory"].waitForExistence(timeout: 10), app.debugDescription)
        // The story's picture is the fixture's own, so it is there.
        XCTAssertTrue(app.images["newsPicture"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        capture("story", app)
        back(app)
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 10), app.debugDescription)
        back(app)

        // 9. The second desk opens from its tile, reads under its own name and its edition under the name it was given.
        let startups = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "tile-desk:", "Startups")).firstMatch
        XCTAssertTrue(startups.waitForExistence(timeout: 10), app.debugDescription); scrollShelf(app, to: startups); startups.tap()
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Стартапы за день"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.staticTexts["Утренний выпуск"].exists)
        XCTAssertEqual(app.buttons["readerTitle"].value as? String, "Startups")
        capture("second-desk", app)
        back(app)

        // 10. Statistics opens from the foot of the home, which says the fullest limit as a figure; the limits in full
        // are a step further. What waits and the recent results are one page behind the home's lead.
        let statistics = app.buttons["homeStatistics"]
        XCTAssertTrue(statistics.waitForExistence(timeout: 20), app.debugDescription)
        bring(statistics, in: app)
        try await expectLabel(statistics, says: "68 %".replacingOccurrences(of: " ", with: "\u{a0}"))
        statistics.tap()
        XCTAssertTrue(app.descendants(matching: .any)["statisticsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        try await Task.sleep(for: .seconds(2))
        capture("statistics", app)
        let progress = app.buttons["openProgress"]
        for _ in 0..<8 where !progress.exists || !progress.isHittable { app.swipeUp() }
        XCTAssertTrue(progress.waitForExistence(timeout: 10), app.debugDescription); progress.tap()
        XCTAssertTrue(app.descendants(matching: .any)["progressRoot"].waitForExistence(timeout: 10), app.debugDescription)
        capture("progress", app)
        back(app); back(app)
        for _ in 0..<4 { home.swipeDown() }
        XCTAssertTrue(calm.waitForExistence(timeout: 10), app.debugDescription); calm.tap()
        XCTAssertTrue(app.descendants(matching: .any)["insightsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "insight-")).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        capture("insights", app)
        back(app)

        // 10a. The evening polls are a place behind their tile: the day's answers with the people side by side, what
        // stands out, each question over the weeks, and the chat they live in.
        let polls = app.buttons["tile-checkIns"]
        XCTAssertTrue(polls.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(polls.label, "Пульс")
        XCTAssertTrue((polls.value as? String ?? "").contains("Аня: Спокойствие 7"), polls.debugDescription)
        bring(polls, in: app); polls.tap()
        XCTAssertTrue(app.descendants(matching: .any)["checkInsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(app.staticTexts["checkInDay"].label, "Сегодня")
        let anya = app.descendants(matching: .any)["checkInPerson-42"], mark = app.descendants(matching: .any)["checkInPerson-77"]
        XCTAssertTrue(anya.waitForExistence(timeout: 10) && mark.exists, app.debugDescription)
        XCTAssertTrue((anya.value as? String ?? "").contains("Энергия 9"), anya.debugDescription)
        XCTAssertTrue((mark.value as? String ?? "").contains("Пока без ответа"), mark.debugDescription)
        // His calm fell against the week before, and her energy today is far above her usual.
        for kind in ["week:", "unusual:"] {
            XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "checkInStandout-" + kind)).firstMatch.exists, app.debugDescription)
        }
        capture("polls", app)
        // The chat the polls live in is one tap away, and it is only read.
        let source = app.buttons["checkInSource"]
        for _ in 0..<6 where !source.exists || !source.isHittable { app.swipeUp() }
        XCTAssertTrue(app.descendants(matching: .any)["checkInWeeks"].exists, app.debugDescription)
        capture("polls-weeks", app)
        source.tap()
        XCTAssertTrue(app.descendants(matching: .any)["reader"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        back(app); back(app)

        // 11. The first row is the chat itself; an approval arrives there as a card with its two answers.
        lead.tap()
        XCTAssertTrue(app.buttons["openEmployeeDetails"].waitForExistence(timeout: 10), app.debugDescription)
        _ = try await read("/ask")
        let decline = app.buttons["Отказать"], allow = app.buttons["Разрешить"]
        XCTAssertTrue(allow.waitForExistence(timeout: 20) && decline.exists, app.debugDescription)
        // The action's arguments read as rows of name and value, not as JSON.
        XCTAssertTrue(app.staticTexts["partners@lodka.example"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "\"to\":")).firstMatch.exists, app.debugDescription)
        try await Task.sleep(for: .seconds(1))
        capture("chat-card", app)
        decline.tap()
        XCTAssertTrue(app.staticTexts["Хорошо, не отправляю."].waitForExistence(timeout: 20), app.debugDescription)
        back(app)
        // The home's capsule opens the same chat with the keyboard up.
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription); composer.tap()
        XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
        // One request, one answer: typing here is the only way to send.
        field.tap(); field.typeText("Спасибо")
        let send = app.buttons["sendMessage"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), app.debugDescription); send.tap()
        XCTAssertTrue(app.staticTexts["Принято: Спасибо"].waitForExistence(timeout: 30), app.debugDescription)
        // What the bar offered before is behind one button.
        app.buttons["chatMore"].tap()
        XCTAssertTrue(app.buttons["chatHistory"].waitForExistence(timeout: 5) && app.buttons["chatSettings"].exists, app.debugDescription)
        app.buttons["chatHistory"].tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        capture("search", app)
        app.buttons["Готово"].firstMatch.tap()
        back(app)

        // 12. Search and settings open from the home too; the first row is the chat itself.
        XCTAssertTrue(search.waitForExistence(timeout: 10), app.debugDescription); search.tap()
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["Готово"].firstMatch.tap()
        app.buttons["openSettings"].tap()
        XCTAssertTrue(app.buttons["openStatistics"].waitForExistence(timeout: 10), app.debugDescription)
        capture("settings", app)
        app.buttons["openStatistics"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["statisticsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        app.terminate()
    }

    /// On an iPad at full width the home stands beside the open place, as on the Mac: the chat first, then whatever a
    /// row or a tile opens. The home keeps its search; the composer is the chat's own.
    @MainActor
    func testAnIPadShowsTheHomeBesideTheOpenPlace() async throws {
        continueAfterFailure = false
        guard let fixture = environment["OPENSTRUDEL_TEAM_FIXTURE"] else { throw XCTSkip("Start tests/fixtures/team.ts and pass its control URL.") }
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("An iPad's layout.") }
        control = fixture
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch()
        try await pair(app, "/invite")
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        let state = try await read("/")
        XCTAssertTrue(app.descendants(matching: .any)["homeRoot"].waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertTrue(app.buttons["openEmployeeDetails"].waitForExistence(timeout: 20), "The chat is open beside the home: " + app.debugDescription)
        XCTAssertTrue(app.buttons["openChats"].exists && !app.buttons["homeComposer"].exists, app.debugDescription)
        XCTAssertEqual(app.tabBars.count, 0)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tile-desk:")).firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        try await Task.sleep(for: .seconds(2))
        capture("ipad-home-chat", app)
        let desk = app.buttons["teamMember-" + (try XCTUnwrap(state["news"] as? String))]
        XCTAssertTrue(desk.waitForExistence(timeout: 20), app.debugDescription); desk.tap()
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any)["homeRoot"].exists, "The home stays beside the desk")
        try await Task.sleep(for: .seconds(2))
        capture("ipad-desk", app)
        open(app.buttons["teamMember-" + (try XCTUnwrap(state["fresh"] as? String))], in: app)
        XCTAssertTrue(app.buttons["discussLatest"].waitForExistence(timeout: 15), app.debugDescription)
        capture("ipad-employee", app)
        // «Спросить про…» leads to the chat beside the same home.
        app.buttons["discussLatest"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", "draftContext")).firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["removeDraftContext"].tap()
    }

    /// The chat grows out of a glass capsule at the bottom of the home, or of an employee's page, and goes back into
    /// it while its keyboard is still on its way, after a sheet over the chat has closed. SwiftUI's glass effect on
    /// those capsules took the app down right here within a few rounds; UIKit's glass does not.
    @MainActor
    func testTheChatGoesBackIntoItsCapsuleWithTheKeyboardUp() async throws {
        continueAfterFailure = false
        guard let fixture = environment["OPENSTRUDEL_TEAM_FIXTURE"] else { throw XCTSkip("Start tests/fixtures/team.ts and pass its control URL.") }
        control = fixture
        let app = launch()
        try await pair(app, "/invite2")
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        try await pair(app, "/invite")
        let state = try await read("/")
        let composer = app.buttons["homeComposer"], field = app.textFields["Сообщение"]
        let employee = app.buttons["teamMember-" + (try XCTUnwrap(state["fresh"] as? String))], ask = app.buttons["discussLatest"]
        XCTAssertTrue(composer.waitForExistence(timeout: 40), app.debugDescription)
        for round in 0..<9 {
            // Every third round passes through an employee's page and its «Спросить про…».
            let viaPage = round % 3 == 2
            if viaPage {
                open(employee, in: app)
                XCTAssertTrue(ask.waitForExistence(timeout: 15), app.debugDescription); ask.tap()
            } else {
                composer.tap()
            }
            XCTAssertTrue(field.waitForExistence(timeout: 10), "round \(round): " + app.debugDescription)
            if round == 0 { let tip = app.buttons["Continue"]; if tip.waitForExistence(timeout: 3) { tip.tap() } }
            // A letter and its removal: the keyboard is up and no draft is left behind.
            field.tap(); field.typeText("а" + XCUIKeyboardKey.delete.rawValue)
            if viaPage { app.buttons["removeDraftContext"].tap() }
            app.buttons["chatMore"].tap()
            XCTAssertTrue(app.buttons["chatHistory"].waitForExistence(timeout: 5), app.debugDescription); app.buttons["chatHistory"].tap()
            XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
            app.buttons["Готово"].firstMatch.tap()
            back(app)
            if viaPage {
                XCTAssertTrue(ask.waitForExistence(timeout: 10), "round \(round): " + app.debugDescription)
                back(app)
            }
            XCTAssertTrue(composer.waitForExistence(timeout: 10), "round \(round): " + app.debugDescription)
        }
    }

    // MARK: Helpers

    @MainActor private func launch() -> XCUIApplication {
        XCUIDevice.shared.appearance = environment["OPENSTRUDEL_APPEARANCE"] == "dark" ? .dark : .light
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = environment["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        app.launch()
        return app
    }

    private func value(_ row: XCUIElement) -> String { row.value as? String ?? "" }

    /// The desk's route as its tile names it; the tile and the row open the same reader.
    @MainActor private func newsRoute(_ app: XCUIApplication, _ row: XCUIElement) throws -> String {
        let tile = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "tile-desk:", "News")).firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 20), app.debugDescription)
        return String(tile.identifier.dropFirst("tile-desk:".count))
    }

    /// Brings an element of the home between its top and the dock.
    @MainActor private func bring(_ element: XCUIElement, in app: XCUIApplication) {
        let home = app.descendants(matching: .any)["homeRoot"], dock = app.buttons["homeComposer"].exists ? app.buttons["homeComposer"] : app.buttons["openChats"]
        for _ in 0..<4 where element.exists && element.frame.minY < 110 { home.swipeDown(velocity: .slow) }
        for _ in 0..<6 where element.exists && dock.exists && element.frame.maxY > dock.frame.minY - 12 { home.swipeUp(velocity: .slow) }
    }

    /// A row below the dock is scrolled above it before it is pressed.
    @MainActor private func open(_ row: XCUIElement, in app: XCUIApplication) {
        // On a phone the dock is the composer capsule; beside an open place it is the search capsule.
        let dock = app.buttons["homeComposer"].exists ? app.buttons["homeComposer"] : app.buttons["openChats"]
        XCTAssertTrue(row.waitForExistence(timeout: 20), app.debugDescription)
        for _ in 0..<4 where dock.exists && row.frame.maxY > dock.frame.minY - 12 {
            app.descendants(matching: .any)["homeRoot"].swipeUp(velocity: .slow)
        }
        row.tap()
    }

    /// The shelf scrolls sideways; a tile out of sight is brought in before it is pressed.
    @MainActor private func scrollShelf(_ app: XCUIApplication, to tile: XCUIElement) {
        // The home may have been scrolled to a row; the shelf is at its top.
        let home = app.descendants(matching: .any)["homeRoot"]
        for _ in 0..<3 where tile.exists && tile.frame.minY < 80 { home.swipeDown() }
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tile-")).firstMatch
        for _ in 0..<4 where !tile.isHittable { first.swipeLeft() }
        for _ in 0..<4 where !tile.isHittable { app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tile-")).element(boundBy: 2).swipeRight() }
    }

    @MainActor private func back(_ app: XCUIApplication) {
        let button = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(button.waitForExistence(timeout: 10), app.debugDescription)
        button.tap()
    }

    /// The catalogue is polled, so a row changes within a few seconds.
    @MainActor private func expect(_ row: XCUIElement, says text: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let said = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", text), object: row)
        let result = await XCTWaiter().fulfillment(of: [said], timeout: 15)
        XCTAssertEqual(result, .completed, "\(row.label): \(value(row))", file: file, line: line)
    }

    @MainActor private func expectLabel(_ element: XCUIElement, says text: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let said = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", text), object: element)
        let result = await XCTWaiter().fulfillment(of: [said], timeout: 15)
        XCTAssertEqual(result, .completed, element.label, file: file, line: line)
    }

    @MainActor private func pair(_ app: XCUIApplication, _ path: String) async throws {
        let invite = try await read(path)
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
        confirm.tap(); app.finishDevicePairing()
    }

    @MainActor private func read(_ path: String) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: control + path)))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// A screenshot kept with the test, and beside the others when a folder is named for them.
    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let shot = XCTAttachment(screenshot: screenshot); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        guard let folder = environment["OPENSTRUDEL_SHOTS"] else { return }
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent(name + (environment["OPENSTRUDEL_SHOT_SUFFIX"] ?? "") + ".png"))
    }
}
