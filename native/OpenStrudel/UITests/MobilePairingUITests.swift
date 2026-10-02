import XCTest

final class MobilePairingUITests: XCTestCase {
    @MainActor
    func testCloudSetupCanBeOpenedAndClosedBeforeSignIn() throws {
        let app = XCUIApplication()
        app.launch()
        let cloud = app.buttons["setupCloud"]
        XCTAssertTrue(cloud.waitForExistence(timeout: 15))
        XCTAssertGreaterThanOrEqual(cloud.frame.height, 50)
        cloud.tap()
        let signIn = app.buttons["cloudSignIn"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertGreaterThanOrEqual(signIn.frame.height, 50)
        XCTAssertFalse(app.buttons["cloudConfirmCost"].exists)
        capture("12-cloud-before-sign-in", app)
        app.buttons["Закрыть"].tap()
        XCTAssertTrue(cloud.waitForExistence(timeout: 5))
        cloud.tap()
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["cloudConfirmCost"].exists)
    }

    @MainActor
    func testOnboardingActionsHaveComfortableTargets() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
        app.launch()
        let qr = app.buttons["scanInvitation"]
        let invitation = app.buttons["pasteInvitation"]
        XCTAssertTrue(invitation.waitForExistence(timeout: 15))
        for _ in 0..<4 where !invitation.isHittable { app.swipeUp() }
        capture("10-onboarding-actions", app)
        XCTAssertGreaterThanOrEqual(qr.frame.height, 50)
        XCTAssertGreaterThanOrEqual(invitation.frame.height, 50)
        XCTAssertEqual(qr.frame.width, invitation.frame.width, accuracy: 1)
        invitation.tap()
        let input = app.secureTextFields["connectionInvitation"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(input.frame.height, 44)
        let next = app.buttons["Продолжить"]
        XCTAssertGreaterThanOrEqual(next.frame.height, 50)
        XCTAssertGreaterThan(next.frame.width, app.frame.width * 0.65)
        capture("11-invitation-actions", app)
    }

    @MainActor
    func testInvitationFailureRecoveryAndRelaunch() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_PAIRING_FIXTURE"] else {
            throw XCTSkip("Start tests/fixtures/mobile-pairing.ts on an isolated simulator first.")
        }
        let app = XCUIApplication()
        app.launch()
        // Only a disposable simulator may use this fixture. Keep real connections untouched.
        XCTAssertTrue(app.buttons["pasteInvitation"].waitForExistence(timeout: 15), app.debugDescription)
        capture("01-welcome", app)
        app.buttons["pasteInvitation"].tap()
        let input = app.secureTextFields["connectionInvitation"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("not-an-invitation")
        app.buttons["Продолжить"].tap()
        XCTAssertTrue(app.staticTexts["invitationError"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)
        capture("02-invalid-link", app)
        app.buttons["Отмена"].tap()

        let expired = try await invite(fixture + "/invite?expired=1")
        app.open(expired)
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), app.debugDescription)
        confirm.tap()
        let error = app.staticTexts["pairingError"]
        XCTAssertTrue(error.waitForExistence(timeout: 25), app.debugDescription)
        XCTAssertTrue(error.label.contains("истекло"), error.label)
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)
        capture("03-expired-inline", app)
        app.buttons["Отмена"].tap()

        let valid = try await invite(fixture + "/invite?delay=1")
        // Exercise the actual paste/manual entry path, not only URL dispatch.
        XCTAssertTrue(app.buttons["pasteInvitation"].waitForExistence(timeout: 5))
        app.buttons["pasteInvitation"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText(valid.absoluteString)
        app.buttons["Продолжить"].tap()
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), app.debugDescription)
        capture("04-confirm", app)
        confirm.tap()
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 20), app.debugDescription)
        // Initial load can fail after the one-use invitation has been consumed.
        // The saved connection must recover without a second redemption.
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 20) {
            XCTAssertFalse(app.buttons["Чаты"].exists)
            capture("05-ai-data-consent", app)
            consent.tap()
        }
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 35), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Подключение проверено."].waitForExistence(timeout: 10))
        let state = try await read(fixture + "/state")
        XCTAssertEqual(state["connections"] as? Int, 1)
        XCTAssertGreaterThan(state["unavailableResponses"] as? Int ?? 0, 0)
        capture("05-recovered", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Подключение проверено."].waitForExistence(timeout: 10))
        capture("06-relaunch", app)

        app.open(valid)
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        XCTAssertTrue(error.waitForExistence(timeout: 20))
        XCTAssertTrue(error.label.contains("уже использовано"), error.label)
        app.buttons["Отмена"].tap()
        XCTAssertTrue(app.staticTexts["Подключение проверено."].waitForExistence(timeout: 10))
        // Failed replacement must preserve the previous Keychain credential.
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 20))
        _ = try await read(fixture + "/revoke")
        XCTAssertTrue(app.staticTexts["Подключитесь снова."].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)
        capture("07-revoked", app)
    }

    @MainActor
    func testWelcomeWithLargeText() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        let button = app.buttons["pasteInvitation"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        for _ in 0..<4 where !button.isHittable { app.swipeUp() }
        XCTAssertTrue(button.isHittable, app.debugDescription)
        capture("08-accessibility-welcome", app)
        button.tap()
        XCTAssertTrue(app.secureTextFields["connectionInvitation"].waitForExistence(timeout: 5))
        capture("09-accessibility-invitation", app)
    }

    @MainActor private func read(_ value: String) async throws -> [String: Any] {
        let (data,response) = try await URLSession.shared.data(from: XCTUnwrap(URL(string:value)))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode,200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
    }
    @MainActor private func invite(_ value: String) async throws -> URL {
        let payload = try await read(value)
        return try XCTUnwrap(URL(string: XCTUnwrap(payload["url"] as? String)))
    }
    @MainActor private func capture(_ name:String,_ app:XCUIApplication) {
        let attachment=XCTAttachment(screenshot:app.screenshot());attachment.name=name;attachment.lifetime = .keepAlways;add(attachment)
    }
}
