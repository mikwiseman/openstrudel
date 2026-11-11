import XCTest

/// Runs against tests/fixtures/team.ts on a disposable simulator. Home is the root: today's work as tiles, the team as
/// rows, one composer capsule and search; there is no tab bar. Every place opens from a tile or a row and leads back.
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
        XCTAssertEqual(app.tabBars.count, 0, "Insights, Progress and Statistics open from their tiles")
        XCTAssertTrue(app.staticTexts["OpenStrudel"].firstMatch.exists, app.debugDescription)
        let composer = app.buttons["homeComposer"], search = app.buttons["openChats"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10) && search.exists, app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists, "The home's capsule opens the composer; it is not a second one")

        // 2. The main assistant, the desks, then the others by name; the second Home under its own name with its assistant.
        let lead = app.buttons["teamLead"]
        let rows = try ["news", "startups", "failing", "working", "fresh"].map { app.buttons["teamMember-" + (try id($0))] }
        XCTAssertTrue(lead.waitForExistence(timeout: 10), app.debugDescription)
        for row in rows { XCTAssertTrue(row.waitForExistence(timeout: 20), app.debugDescription) }
        XCTAssertEqual(rows.map(\.label), ["News", "Startups", "Репетитор", "Рецепты", "Тренер"])
        let tops = ([lead] + rows).map(\.frame.minY)
        XCTAssertEqual(tops, tops.sorted(), "Desks first, then by name")
        for row in [lead] + rows { XCTAssertGreaterThanOrEqual(row.frame.height, 44) }
        let failing = rows[2], working = rows[3], fresh = rows[4]
        try await expect(working, says: "Работает…")
        try await expect(failing, says: "Не получилось")
        XCTAssertFalse(value(fresh).contains("Есть новое"), "Everything written before the first meeting counts as seen")

        // 3. The shelf: each desk's lead, what matters, the next run, the limit and progress, each from what the Home says.
        let desk = app.buttons["tile-desk:" + (try newsRoute(app, rows[0]))].firstMatch
        let tiles = ["tile-important", "tile-next", "tile-limit", "tile-progress"].map { app.buttons[$0] }
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tile-desk:")).firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(tiles[0].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue((tiles[0].value as? String ?? "").contains("Репетитор"), tiles[0].debugDescription)
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

        // 10. Statistics, what matters and progress are pages behind their tiles.
        XCTAssertTrue(tiles[2].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(tiles[2].value as? String, "68 %".replacingOccurrences(of: " ", with: "\u{a0}"), tiles[2].debugDescription)
        scrollShelf(app, to: tiles[2]); tiles[2].tap()
        XCTAssertTrue(app.descendants(matching: .any)["statisticsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        try await Task.sleep(for: .seconds(2))
        capture("statistics", app)
        back(app)
        scrollShelf(app, to: tiles[0]); tiles[0].tap()
        XCTAssertTrue(app.descendants(matching: .any)["insightsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "insight-")).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        capture("insights", app)
        back(app)
        scrollShelf(app, to: tiles[3]); tiles[3].tap()
        XCTAssertTrue(app.descendants(matching: .any)["progressRoot"].waitForExistence(timeout: 10), app.debugDescription)
        capture("progress", app)
        back(app)

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
