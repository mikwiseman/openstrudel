import XCTest

/// Runs against tests/fixtures/team.ts on a disposable simulator: «Команда» right after the chat, the same rows as the
/// Mac sidebar with what each employee is doing, an employee's page with its header, a desk and one of its stories.
final class TeamUITests: XCTestCase {
    private var control = ""

    @MainActor
    func testTheTeamItsPagesAndAStory() async throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        guard let fixture = environment["OPENSTRUDEL_TEAM_FIXTURE"] else { throw XCTSkip("Start tests/fixtures/team.ts and pass its control URL.") }
        control = fixture
        XCUIDevice.shared.appearance = environment["OPENSTRUDEL_APPEARANCE"] == "dark" ? .dark : .light
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = environment["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        app.launch()
        // The second Home first: the Home paired last is the chat's.
        try await pair(app, "/invite2")
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        try await pair(app, "/invite")
        let state = try await read("/")
        let id: (String) throws -> String = { key in try XCTUnwrap(state[key] as? String) }

        // 1. The chat is still first and the only place to type; «Команда» comes right after it.
        let composer = app.textFields["Сообщение"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        let tabs = app.tabBars.buttons
        XCTAssertEqual(tabs.count, 5, app.debugDescription)
        XCTAssertEqual(tabs.element(boundBy: 0).label, "Чат")
        XCTAssertEqual(tabs.element(boundBy: 1).label, "Команда")
        tabs["Команда"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["teamRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)

        // 2. The main assistant, the desks, then the others by name; the second Home under its own name.
        let lead = app.buttons["teamLead"]
        let rows = try ["news", "startups", "failing", "working", "fresh", "gardener"].map { app.buttons["teamMember-" + (try id($0))] }
        XCTAssertTrue(lead.waitForExistence(timeout: 10), app.debugDescription)
        for row in rows { XCTAssertTrue(row.waitForExistence(timeout: 20), app.debugDescription) }
        XCTAssertEqual(rows.map(\.label), ["News", "Startups", "Репетитор", "Рецепты", "Тренер", "Садовник"])
        let tops = ([lead] + rows).map(\.frame.minY)
        XCTAssertEqual(tops, tops.sorted(), "Desks first, then by name, then the other Home")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "teamHome-")).firstMatch.exists, app.debugDescription)
        for row in [lead] + rows { XCTAssertGreaterThanOrEqual(row.frame.height, 44) }
        let failing = rows[2], working = rows[3], fresh = rows[4]
        try await expect(working, says: "Работает…")
        try await expect(failing, says: "Не получилось")
        XCTAssertFalse(value(fresh).contains("Есть новое"), "Everything written before the first meeting counts as seen")
        capture("team", app)

        // 3. A result lands while the list is in sight: its row says so within a few seconds.
        _ = try await read("/arrive")
        try await expect(fresh, says: "Есть новое")
        try await expect(fresh, says: "лёгкий бег")
        capture("team-new-result", app)

        // 4. The employee's page: who it is, when it works, and its words with their links as links.
        fresh.tap()
        XCTAssertTrue(app.descendants(matching: .any)["reader"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Утренний план тренировки на двадцать минут"].waitForExistence(timeout: 15), app.debugDescription)
        let rhythm = app.buttons["employeeRhythm"]
        XCTAssertTrue(rhythm.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(rhythm.label.contains("Каждый день в") && rhythm.label.contains("следующий запуск") && rhythm.label.contains("и ещё 1"), rhythm.label)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "памятке о приседаниях")).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "](<")).firstMatch.exists, "A link written with an angle-bracket address reads as a link")
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        capture("employee-page", app)
        // The rhythm line opens the details, where a schedule can be paused.
        rhythm.tap()
        XCTAssertTrue(app.buttons["saveEmployeeChanges"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["saveEmployeeChanges"].tap()
        // Its latest words go to the one composer as context.
        let discussLatest = app.buttons["discussLatest"]
        XCTAssertTrue(discussLatest.waitForExistence(timeout: 10), app.debugDescription); discussLatest.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "draftContext", "Из переписки · Тренер")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["removeDraftContext"].tap()
        // Back in «Команда» the page is still open; what was on screen is read.
        tabs["Команда"].tap()
        XCTAssertTrue(rhythm.waitForExistence(timeout: 10), app.debugDescription)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(fresh.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(value(fresh).contains("Есть новое"), value(fresh))

        // 5. A run that failed is said on the employee's page, with since when and why.
        failing.tap()
        let failure = app.buttons["readerFailing"]
        XCTAssertTrue(failure.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(failure.label.contains("Не получается с") && failure.label.contains("Закончился лимит модели."), failure.label)
        capture("employee-failing", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 6. The working employee finishes: its row stops saying so, and its answer is new.
        _ = try await read("/release")
        try await expect(working, says: "Меню на неделю готово")
        XCTAssertFalse(value(working).contains("Работает…"))

        // 7. A desk and one of its stories.
        rows[0].tap()
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any)["newsStatus"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["ВЫПУСК"].waitForExistence(timeout: 10), app.debugDescription)
        // The picture comes from the network; give it a moment, then show the page as it is.
        _ = app.images["newsPicture"].waitForExistence(timeout: 10)
        capture("desk", app)
        let story = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Клён 3")).firstMatch
        XCTAssertTrue(story.waitForExistence(timeout: 10), app.debugDescription); story.tap()
        XCTAssertTrue(app.scrollViews["newsStory"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["discussStory"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        capture("story", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 10), app.debugDescription)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 8. The second desk reads under its own name and its edition under the name it was given.
        XCTAssertTrue(rows[1].waitForExistence(timeout: 10), app.debugDescription); rows[1].tap()
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["СТАРТАПЫ ЗА ДЕНЬ"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.staticTexts["УТРЕННИЙ ВЫПУСК"].exists)
        XCTAssertEqual(app.buttons["readerTitle"].value as? String, "Startups")
        capture("second-desk", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // 9. News lives in the team now: Insights lists none; the first row is the chat itself.
        tabs["Инсайты"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["insightsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "newsEntry-")).firstMatch.exists)
        tabs["Команда"].tap()
        XCTAssertTrue(lead.waitForExistence(timeout: 10), app.debugDescription); lead.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
    }

    private func value(_ row: XCUIElement) -> String { row.value as? String ?? "" }

    /// The catalogue is polled, so a row changes within a few seconds.
    @MainActor private func expect(_ row: XCUIElement, says text: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let said = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", text), object: row)
        let result = await XCTWaiter().fulfillment(of: [said], timeout: 15)
        XCTAssertEqual(result, .completed, "\(row.label): \(value(row))", file: file, line: line)
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

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
