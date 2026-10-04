import XCTest

final class AccountRecoveryUITests: XCTestCase {
    @MainActor func testLargeTypeRecoveryKeepsChatAndSignInReachable() async throws {
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_ACCOUNT_FIXTURE"] else {
            throw XCTSkip("Start the isolated account-recovery fixture.")
        }
        _ = try await read(fixture + "/seed")
        _ = try await read(fixture + "/mode?value=connected")
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let invitation = try await read(fixture + "/invite?owner=1")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invitation["url"] as? String))))
        let pair = app.buttons["confirmMacPairing"]
        XCTAssertTrue(pair.waitForExistence(timeout: 15)); pair.tap()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 3) { consent.tap() }
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 15))
        _ = try await read(fixture + "/mode?value=expired")
        let recover = app.buttons["recoverOpenAIAccount"]
        XCTAssertTrue(recover.waitForExistence(timeout: 20))
        XCTAssertTrue(recover.isHittable)
        XCTAssertTrue(app.textFields.firstMatch.isHittable)
        XCTAssertTrue(app.buttons["Чаты"].isHittable)
        capture("largest-type-recovery-controls", app)
        recover.tap()
        let signIn = app.buttons["signInOpenAI"]
        for _ in 0..<12 where !signIn.isHittable { scrollPresentedContent(app) }
        XCTAssertTrue(signIn.isHittable)
        capture("largest-type-sign-in", app)
    }

    @MainActor func testSharedHomeAccountLossRecoveryAndDraft() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_ACCOUNT_FIXTURE"] else {
            throw XCTSkip("Start the isolated account-recovery fixture.")
        }
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let invitation = try await read(fixture + "/invite?owner=1")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invitation["url"] as? String))))
        let pair = app.buttons["confirmMacPairing"]
        XCTAssertTrue(pair.waitForExistence(timeout: 15)); pair.tap()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        let signIn = app.buttons["signInOpenAI"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        let initialState = try await read(fixture + "/state")
        XCTAssertEqual(initialState["loginStarts"] as? Int, 0)
        capture("first-explicit-sign-in", app)
        signIn.tap()
        app.activate()
        XCTAssertTrue(app.staticTexts["openAIDeviceCode"].waitForExistence(timeout: 15))
        let cancel = app.buttons["cancelOpenAILogin"]
        for _ in 0..<8 where !cancel.isHittable { scrollPresentedContent(app) }
        XCTAssertTrue(cancel.isHittable)
        capture("device-code-and-cancel", app)
        cancel.tap()
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        signIn.tap(); app.activate()
        XCTAssertTrue(app.staticTexts["openAIDeviceCode"].waitForExistence(timeout: 15))
        _ = try await read(fixture + "/cancel-login")
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Вход отменён или истёк")).firstMatch.exists)
        _ = try await read(fixture + "/seed")
        _ = try await read(fixture + "/mode?value=connected")
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["openAIRecoveryNotice"].waitForNonExistence(timeout: 20))
        let composer = app.textFields.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5)); composer.tap()
        composer.typeText("Черновик должен сохраниться")
        _ = try await read(fixture + "/mode?value=expired")
        let recover = app.buttons["recoverOpenAIAccount"]
        XCTAssertTrue(recover.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Эта история остаётся")).firstMatch.exists)
        XCTAssertEqual(composer.value as? String, "Черновик должен сохраниться")
        XCTAssertFalse(app.buttons["Отправить"].isEnabled)
        capture("expired-account-with-history-and-draft", app)
        _ = try await read(fixture + "/mode?value=unavailable")
        XCTAssertTrue(app.buttons["Проверить ещё раз"].waitForExistence(timeout: 20))
        capture("network-retry-without-repairing", app)
        _ = try await read(fixture + "/mode?value=connected")
        let deadline = Date().addingTimeInterval(20)
        while !app.buttons["Отправить"].isEnabled && Date() < deadline { try await Task.sleep(for: .milliseconds(500)) }
        XCTAssertTrue(app.buttons["Отправить"].isEnabled)
        XCTAssertEqual(composer.value as? String, "Черновик должен сохраниться")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 15))
        XCTAssertEqual(app.textFields.firstMatch.value as? String, "Черновик должен сохраниться")

        let clientInvitation = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(clientInvitation["url"] as? String))))
        XCTAssertTrue(pair.waitForExistence(timeout: 15)); pair.tap()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 15))
        _ = try await read(fixture + "/mode?value=expired")
        XCTAssertTrue(app.staticTexts["openAIRecoveryNotice"].waitForExistence(timeout: 20))
        XCTAssertFalse(recover.exists)
        XCTAssertFalse(signIn.exists)
        capture("connected-device-waits-for-home-owner", app)
        _ = try await read(fixture + "/mode?value=connected")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 15))
        XCTAssertFalse(signIn.exists)
        let finalState = try await read(fixture + "/state")
        XCTAssertEqual(finalState["loginStarts"] as? Int, 2)
    }

    @MainActor private func read(_ value: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: value)))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }

    @MainActor private func scrollPresentedContent(_ app: XCUIApplication) {
        // iPad sheets leave the underlying conversation in the AX hierarchy.
        let scroller = app.scrollViews.allElementsBoundByIndex.last(where: \.isHittable) ?? app
        scroller.swipeUp()
    }
}
