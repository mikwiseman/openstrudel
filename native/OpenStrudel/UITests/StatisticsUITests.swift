import XCTest

/// Runs against tests/fixtures/statistics.ts on a disposable simulator: every connected Home's usage by day and by week,
/// one Home at a time and all together. Pass the Homes as `Name|control URL` pairs separated by commas in
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
            XCTAssertTrue(app.textFields["Сообщение"].waitForExistence(timeout: 30), app.debugDescription)
        }

        // 1. Its own place: today's requests of all Homes, the bars of the last days, and each Home's share.
        let tab = app.tabBars.buttons["Статистика"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10), app.debugDescription); tab.tap()
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
