import XCTest

/// Runs against a disposable Home seeded with one Telegram poll and two weeks of answers: the Progress page shows the
/// check-in card with each person's bars, the latest answer, the streak and today's state, and the card opens its chat.
final class CheckInUITests: XCTestCase {
    @MainActor
    func testProgressShowsTheCheckInCard() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_CHECKIN_FIXTURE"] else { throw XCTSkip("Start the seeded check-in fixture and pass its control URL.") }
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        app.launch()
        let (data, response) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: fixture + "/invite")))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let invite = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        app.open(try XCTUnwrap(URL(string: try XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
        confirm.tap(); app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        // Progress opens from its tile on the home.
        app.openTile("tile-progress")
        let card = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "checkIn-")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Сколько суеты сегодня?"].exists, app.debugDescription)
        XCTAssertTrue(app.staticTexts["Mik"].exists && app.staticTexts["Гриша"].exists, app.debugDescription)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Серия: ")).firstMatch.exists, app.debugDescription)
        capture("progress-check-in", app)
        card.tap()
        // The card opens the chat the poll lives in: a reader, never a composer, and the Progress list is gone.
        let reader = app.descendants(matching: .any).matching(identifier: "reader").firstMatch
        XCTAssertTrue(reader.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["readerTitle"].waitForExistence(timeout: 5) || app.navigationBars.staticTexts["WAI HQ"].exists, app.debugDescription)
        XCTAssertFalse(card.exists, "The Progress list must be behind the reader")
        XCTAssertFalse(app.textFields["Сообщение"].exists, "A reader has no composer")
        capture("check-in-source", app)
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let shot = XCTAttachment(screenshot: screenshot); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        if let directory = ProcessInfo.processInfo.environment["OPENSTRUDEL_SCREENSHOT_DIR"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
        }
    }
}
