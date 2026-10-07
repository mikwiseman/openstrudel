import XCTest

final class MobilePairingUITests: XCTestCase {
    @MainActor
    func testCompanionOnboardingExplainsInvitationsWithoutCheckout() throws {
        let app = XCUIApplication()
        app.launch()
        let help = app.buttons["invitationHelp"]
        XCTAssertTrue(help.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Подключите устройство"].exists)
        XCTAssertFalse(app.buttons["setupCloud"].exists)
        XCTAssertFalse(app.buttons["cloudSignIn"].exists)
        XCTAssertFalse(app.buttons["cloudConfirmCost"].exists)
        XCTAssertFalse(app.links["Управлять облаком"].exists)
        for _ in 0..<4 where !help.isHittable { app.swipeUp() }
        help.tap()
        XCTAssertTrue(app.staticTexts["Где получить ссылку"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.links.count, 0, "Connection help must not lead to signup or payment")
        capture("12-connection-help", app)
        app.buttons["closeConnectionHelp"].tap()
        XCTAssertTrue(app.buttons["pasteInvitation"].waitForExistence(timeout: 5))
        // An old provider OAuth callback must not reopen cloud setup on iOS.
        app.open(URL(string: "openstrudel://oauth/digitalocean?code=unused&state=unused")!)
        XCTAssertTrue(help.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["cloudSignIn"].exists)
        #if targetEnvironment(simulator)
        app.buttons["scanInvitation"].tap()
        XCTAssertTrue(app.staticTexts["На этом устройстве вставьте ссылку подключения."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pasteInvitation"].exists)
        #endif
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
        // iPad presents this form in a sheet narrower than the app window.
        XCTAssertGreaterThanOrEqual(next.frame.width, input.frame.width * 0.9)
        capture("11-invitation-actions", app)
    }

    @MainActor
    func testHelpRemainsReachableInLandscape() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        let app = XCUIApplication()
        app.launch()
        let help = app.buttons["invitationHelp"]
        XCTAssertTrue(help.waitForExistence(timeout: 15))
        for _ in 0..<4 where !help.isHittable { app.swipeUp() }
        XCTAssertTrue(help.isHittable)
        help.tap()
        XCTAssertTrue(app.staticTexts["Где получить ссылку"].waitForExistence(timeout: 5))
        let close = app.buttons["closeConnectionHelp"]
        XCTAssertTrue(close.isHittable)
        XCTAssertEqual(app.links.count, 0)
        capture("13-landscape-help", app)
        close.tap()
        XCTAssertTrue(app.buttons["pasteInvitation"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testInvitationFailureRecoveryAndRelaunch() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_PAIRING_FIXTURE"] else {
            throw XCTSkip("Start tests/fixtures/mobile-pairing.ts on an isolated simulator first.")
        }
        let initial = try await read(fixture + "/state")
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
        app.finishDevicePairing()
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
        XCTAssertEqual(state["connections"] as? Int, (initial["connections"] as? Int ?? 0) + 1)
        XCTAssertGreaterThan(state["unavailableResponses"] as? Int ?? 0, initial["unavailableResponses"] as? Int ?? 0)
        capture("05-recovered", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Подключение проверено."].waitForExistence(timeout: 10))
        capture("06-relaunch", app)

        app.buttons["Настройки"].tap()
        let addDevice = app.buttons["addDevice"]
        XCTAssertTrue(addDevice.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Управлять облаком"].exists)
        addDevice.tap()
        XCTAssertTrue(app.secureTextFields["connectionInvitation"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Получить ссылку подключения")).firstMatch.exists)
        XCTAssertEqual(app.links.count, 0)
        capture("06-settings-help", app)
        app.buttons["Отмена"].tap()
        app.buttons["Готово"].tap()

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
        // Capture the screen so landscape attachments retain the full display bounds.
        let attachment=XCTAttachment(screenshot:XCUIScreen.main.screenshot());attachment.name=name;attachment.lifetime = .keepAlways;add(attachment)
    }
}
