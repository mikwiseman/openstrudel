import XCTest

final class AgentCharactersUITests: XCTestCase {
    @MainActor func testAppearanceAndDeviceSignOut() async throws {
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_CHARACTERS_FIXTURE"] else {
            throw XCTSkip("Requires the isolated agent-characters fixture.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"] {
            app.launchArguments = ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: fixture + "/invite")))
        let invite = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let pair = app.buttons["confirmMacPairing"]
        XCTAssertTrue(pair.waitForExistence(timeout: 15)); pair.tap()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 3) { consent.tap() }
        let chats = app.buttons["Чаты"]
        XCTAssertTrue(chats.waitForExistence(timeout: 15)); chats.tap()
        let editor = app.buttons["Редактор"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5)); editor.tap()
        app.buttons["Настройки сотрудника"].tap()
        let kind = app.buttons["agentKind-fold"]
        XCTAssertTrue(kind.waitForExistence(timeout: 5)); reveal(kind, app); kind.tap()
        reveal(app.buttons["agentTone-4"], app); app.buttons["agentTone-4"].tap()
        capture("ios-character-picker", app)
        app.buttons["saveEmployeeChanges"].tap()
        XCTAssertTrue(app.buttons["Настройки сотрудника"].waitForExistence(timeout: 5))
        app.buttons["Настройки сотрудника"].tap()
        XCTAssertTrue(kind.waitForExistence(timeout: 5)); XCTAssertTrue(kind.isSelected)
        XCTAssertTrue(app.buttons["agentTone-4"].isSelected)
        app.buttons["cancelEmployeeChanges"].tap()
        chats.tap()
        let settings = app.buttons["teamSettings"]
        reveal(settings, app); settings.tap()
        let leave = app.buttons["signOutThisDevice"]
        reveal(leave, app); leave.tap()
        let confirm = app.buttons["confirmDeviceSignOut"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        capture("ios-device-sign-out", app)
        app.buttons["Отмена"].tap()
        XCTAssertTrue(leave.waitForExistence(timeout: 5)); leave.tap()
        XCTAssertTrue(confirm.waitForExistence(timeout: 5)); reveal(confirm, app); confirm.tap()
        let reconnect = app.buttons["pasteInvitation"]
        XCTAssertTrue(reconnect.waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        XCTAssertTrue(reconnect.waitForExistence(timeout: 10))
        XCTAssertFalse(chats.exists)
        XCTAssertFalse(app.buttons["setupCloud"].exists)
        capture("ios-signed-out-after-relaunch", app)
    }

    @MainActor private func reveal(_ element: XCUIElement, _ app: XCUIApplication) {
        for _ in 0..<12 where !element.isHittable { (app.scrollViews.allElementsBoundByIndex.last(where: \.isHittable) ?? app).swipeUp() }
        XCTAssertTrue(element.isHittable)
    }
    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
