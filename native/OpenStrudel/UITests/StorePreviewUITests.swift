import XCTest

/// Uses disposable example content, never the user's Home or account.
final class StorePreviewUITests: XCTestCase {
    @MainActor func testSignInPreventsDuplicateStarts() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_SIGNIN_FIXTURE"] else {
            throw XCTSkip("Start the isolated store-preview fixture with --sign-in.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
        app.launch()
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: fixture + "/invite")))
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(value["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 10) { consent.tap() }
        let signIn = app.buttons["signInOpenAI"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertGreaterThanOrEqual(signIn.frame.height, 50)
        XCTAssertGreaterThan(signIn.frame.width, app.frame.width * 0.60)
        capture("12-openai-welcome", app)
        let (beforeData, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: fixture + "/state")))
        let before = try XCTUnwrap(JSONSerialization.jsonObject(with: beforeData) as? [String: Any])
        let previousStarts = try XCTUnwrap(before["loginStarts"] as? Int)
        signIn.tap()
        XCTAssertFalse(signIn.isEnabled, "The sign-in button must disable immediately while a login starts.")
        let browser = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        _ = browser.wait(for: .runningForeground, timeout: 10)
        app.activate()
        let cancel = app.buttons["Отменить"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 15), app.debugDescription)
        capture("13-openai-device-code", app)
        let (state, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: fixture + "/state")))
        let status = try XCTUnwrap(JSONSerialization.jsonObject(with: state) as? [String: Any])
        XCTAssertEqual(status["loginStarts"] as? Int, previousStarts + 1)
        cancel.tap()
        XCTAssertTrue(signIn.waitForExistence(timeout: 10))
        XCTAssertTrue(signIn.isEnabled)
    }

    @MainActor func testPublicScreenshots() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_STORE_FIXTURE"] else {
            throw XCTSkip("Start the isolated store-preview fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
        app.launch()
        let (data, response) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: fixture + "/invite")))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(value["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
        confirm.tap()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 15) { consent.tap() }
        let chats = app.buttons["Чаты"]
        XCTAssertTrue(chats.waitForExistence(timeout: 30), app.debugDescription)
        chats.tap()
        XCTAssertTrue(app.staticTexts["Редактор"].firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        capture("store-01-employees", app)
        app.staticTexts["Редактор"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Место для ваших идей"].waitForExistence(timeout: 15), app.debugDescription)
        capture("store-02-conversation", app)
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
