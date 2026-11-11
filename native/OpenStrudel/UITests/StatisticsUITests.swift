import XCTest

/// Runs against tests/fixtures/statistics.ts on a disposable simulator: every connected Home's usage by day and by week,
/// one Home at a time and all together, then each device's models and schedules in Settings. Pass the Homes as `Name|control URL` pairs separated by commas in
/// TEST_RUNNER_OPENSTRUDEL_STATISTICS_HOMES; the first is paired first.
final class StatisticsUITests: XCTestCase {
    @MainActor
    func testUsageByDayAndWeekAcrossHomes() async throws {
        continueAfterFailure = false
        guard let list = ProcessInfo.processInfo.environment["OPENSTRUDEL_STATISTICS_HOMES"] else { throw XCTSkip("Start tests/fixtures/statistics.ts and pass its Homes.") }
        let homes = list.split(separator: ",").map { $0.split(separator: "|", maxSplits: 1).map(String.init) }.filter { $0.count == 2 }
        XCTAssertGreaterThanOrEqual(homes.count, 2, "Statistics across Homes needs two fixtures")
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        app.launch()
        for home in homes {
            try await pair(app, control: home[1], name: home[0])
            let consent = app.buttons["acceptAIDataSharing"]
            if consent.waitForExistence(timeout: 5) { consent.tap() }
            XCTAssertTrue(app.buttons["homeComposer"].waitForExistence(timeout: 30), app.debugDescription)
        }

        // 1. Its own page, opened from the settings: today's requests of all Homes, the bars of the last days, and
        // each Home's share.
        app.buttons["openSettings"].tap()
        let entry = app.buttons["openStatistics"]
        XCTAssertTrue(entry.waitForExistence(timeout: 10), app.debugDescription); entry.tap()
        let requests = app.staticTexts["statisticsRequests"]
        XCTAssertTrue(requests.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists, "Statistics is a reader, not a second composer")
        let bars = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "statisticsBar-"))
        XCTAssertGreaterThan(bars.count, 1, app.debugDescription)
        for home in homes { XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "statisticsHome-", home[0])).firstMatch.exists, app.debugDescription) }
        let today = requests.label
        capture("statistics-day-all", app)

        // 2. Choosing an earlier day shows that day, with the day before it to compare.
        let earlier = bars.element(boundBy: bars.count - 2)
        earlier.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Днём раньше")).firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(earlier.value as? String, requests.label.replacingOccurrences(of: "Запросы: ", with: ""))
        capture("statistics-day-earlier", app)

        // 3. Weeks from Monday; the unfinished week compares with the previous one up to the same moment.
        app.segmentedControls.buttons["По неделям"].tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Неделю назад к этому часу")).firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertNotEqual(requests.label, today)
        capture("statistics-week-all", app)

        // 4. One Home's share narrows the report to it; its chats and schedules follow.
        let first = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "statisticsHome-", homes[0][0])).firstMatch
        first.tap()
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "statisticsHome-")).firstMatch.waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["statisticsRow-chats"].firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        capture("statistics-week-home", app)
        app.swipeUp(); app.swipeUp()
        XCTAssertTrue(app.descendants(matching: .any)["statisticsOrigin"].waitForExistence(timeout: 5), app.debugDescription)
        capture("statistics-week-home-rows", app)

        // 5. Settings open on every device's default model, side by side.
        app.terminate(); app.launch()
        let gear = app.buttons["Настройки"].firstMatch
        XCTAssertTrue(gear.waitForExistence(timeout: 30), app.debugDescription); gear.tap()
        let models = app.buttons.matching(identifier: "modelChoice")
        XCTAssertTrue(models.firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        capture("settings-models", app)
        // The form loads rows as they scroll in; each device has its own section with its own model.
        // Slow swipes move less than a screen, so no header scrolls past between two looks (the pane is seven screens at XXXL).
        for home in homes {
            let section = app.staticTexts.matching(NSPredicate(format: "label == %@", home[0])).firstMatch
            for _ in 0..<16 where !section.exists { app.swipeUp(velocity: .slow) }
            XCTAssertTrue(section.waitForExistence(timeout: 5), app.debugDescription)
        }

        // 6. «Расписания»: every device's schedules with this week's runs, each a switch that saves on its device.
        let picker = app.buttons["settingsSection"]
        for _ in 0..<6 where !picker.isHittable { app.swipeDown() }
        openSection("Расписания", picker: picker, in: app)
        let switches = app.switches.matching(NSPredicate(format: "identifier BEGINSWITH %@", "schedule-"))
        XCTAssertTrue(switches.firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Запусков за неделю")).firstMatch.exists, app.debugDescription)
        capture("settings-schedules", app)
        let schedule = app.switches[switches.firstMatch.identifier]
        let before = schedule.value as? String, flipped = before == "1" ? "0" : "1"
        schedule.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(settles(schedule, at: flipped), app.debugDescription)
        // Another pane and back reads the device again: the switch held there.
        openSection("Модели", picker: picker, in: app)
        openSection("Расписания", picker: picker, in: app)
        XCTAssertTrue(settles(schedule, at: flipped), app.debugDescription)
        capture("settings-schedules-switched", app)
        schedule.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(settles(schedule, at: before ?? "1"), app.debugDescription)
    }

    @MainActor private func openSection(_ title: String, picker: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(picker.waitForExistence(timeout: 10), app.debugDescription); picker.tap()
        let item = app.buttons[title].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5), app.debugDescription); item.tap()
    }

    /// Waits for a switch to show a value after its save and the reload that follows.
    @MainActor private func settles(_ element: XCUIElement, at value: String) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@ AND isEnabled == true", value), object: element)
        return XCTWaiter().wait(for: [expectation], timeout: 15) == .completed
    }

    @MainActor private func pair(_ app: XCUIApplication, control: String, name: String) async throws {
        let (data, _) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: control + "/invite")))
        let invite = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var url = try XCTUnwrap(URLComponents(string: XCTUnwrap(invite["url"] as? String)))
        url.queryItems = (url.queryItems ?? []).filter { $0.name != "name" } + [URLQueryItem(name: "name", value: name)]
        app.open(try XCTUnwrap(url.url))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
        confirm.tap(); app.finishDevicePairing()
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
