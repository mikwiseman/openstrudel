import XCTest

final class MobilePairingUITests: XCTestCase {
    @MainActor
    func testEmployeeTimelineWithIsolatedHome() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let invitation = env["OPENSTRUDEL_DEVICE_INVITATION"], let profileID = env["OPENSTRUDEL_DEVICE_PROFILE"] else {
            throw XCTSkip("Requires the isolated Telegram timeline fixture.")
        }
        let app = XCUIApplication()
        // The feed's lines are checked in Russian; a fresh simulator opens in English.
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        app.launch(); app.open(try XCTUnwrap(URL(string: invitation)))
        XCTAssertTrue(app.buttons["confirmMacPairing"].waitForExistence(timeout: 15)); app.buttons["confirmMacPairing"].tap(); app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 3) { consent.tap() }
        let chats = app.buttons["openChats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 20), app.debugDescription); chats.tap()
        let employee = app.buttons["employee-" + profileID]
        for _ in 0..<10 where !employee.isHittable { app.swipeUp() }
        XCTAssertTrue(employee.isHittable, app.debugDescription); employee.tap()
        // A private chat's request names the person once: no «Telegram · <first name>», no separate author line.
        XCTAssertTrue(app.staticTexts["Mik Wiseman · Telegram"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.staticTexts["Telegram · Mik"].exists, app.debugDescription)
        XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Mik Wiseman")).count, 1, app.debugDescription)
        let request = app.staticTexts["Собери решения встречи и следующий шаг."]
        XCTAssertTrue(request.waitForExistence(timeout: 10), app.debugDescription)
        // A request under the floating header counts as hittable, but a press there lands on the header.
        for _ in 0..<8 where !request.isHittable { app.swipeDown() }
        // One source line per request, no inline Reply, and the delivered reply below stays silent.
        XCTAssertTrue(app.staticTexts["Решили подготовить общий документ. Следующий шаг — согласовать ответственных."].exists, app.debugDescription)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "telegramReply-")).firstMatch.exists, app.debugDescription)
        XCTAssertFalse(app.staticTexts["Отправляем в Telegram…"].exists, app.debugDescription)
        // The author lives in the group's line, a link named after the group, never on a line of its own.
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Гриша")).firstMatch.exists, app.debugDescription)
        XCTAssertTrue(telegramLink("Открыть в Telegram: WAI Core Team · тест", app).exists, app.debugDescription)
        // Only a reply Telegram did not confirm speaks, with its one way on.
        XCTAssertTrue(app.staticTexts["Доставка не подтверждена. Проверьте Telegram перед новой отправкой."].exists, app.debugDescription)
        XCTAssertTrue(telegramLink("Открыть в Telegram", app).exists, app.debugDescription)
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Посторонняя беседа")).firstMatch.exists)
        capture("phone-unified-telegram-feed", app)
        // The reader has no reply of its own: the group stays read-only here, and the app request goes from the one chat.
        XCTAssertFalse(app.textFields["telegramReplyText"].exists, app.debugDescription)
        XCTAssertFalse(app.buttons["sendTelegramReply"].exists, app.debugDescription)
        XCTAssertFalse(app.textFields["messageComposer"].exists, app.debugDescription)
        capture("phone-telegram-reader", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let composer = app.textFields["messageComposer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10)); composer.tap(); composer.typeText("Private app request from iPhone")
        app.buttons["sendMessage"].tap()
        capture("phone-telegram-and-private-app-message", app)
        app.terminate(); app.launch()
        XCTAssertTrue(chats.waitForExistence(timeout: 20), app.debugDescription)
        capture("phone-timeline-after-relaunch", app)
    }

    @MainActor
    func testSharedGrantEmployeeFromLiveInvitation() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let profileID = env["OPENSTRUDEL_GRANT_PROFILE"] else {
            throw XCTSkip("Requires the owner-requested grant server invitation.")
        }
        let app = XCUIApplication(); app.launch()
        if let invitation = env["OPENSTRUDEL_GRANT_INVITATION"] {
            app.open(try XCTUnwrap(URL(string: invitation)))
            XCTAssertTrue(app.buttons["confirmMacPairing"].waitForExistence(timeout: 15)); app.buttons["confirmMacPairing"].tap(); app.finishDevicePairing()
        }
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 3) { consent.tap() }
        let chats = app.buttons["openChats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 20), app.debugDescription)
        if app.buttons["openEmployeeDetails"].value as? String != "Грант WaiWai" {
            chats.tap()
            let employee = app.buttons["employee-" + profileID]
            for _ in 0..<12 where !employee.isHittable { app.swipeUp() }
            XCTAssertTrue(employee.isHittable, app.debugDescription)
            XCTAssertTrue(employee.label.contains("Грант WaiWai")); employee.tap()
        }
        XCTAssertTrue(app.textFields["messageComposer"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Все 853 записи")).firstMatch.waitForExistence(timeout: 20), app.debugDescription)
        capture("phone-grant-shared-history", app)
        app.terminate(); app.launch()
        XCTAssertTrue(chats.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(app.buttons["openEmployeeDetails"].value as? String, "Грант WaiWai", app.debugDescription)
        capture("phone-grant-after-relaunch", app)
    }

    @MainActor
    func testDeviceManagementWithIsolatedHome() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let invitation = env["OPENSTRUDEL_DEVICE_INVITATION"],
              let profileID = env["OPENSTRUDEL_DEVICE_PROFILE"] else {
            throw XCTSkip("Requires the isolated primary-home fixture; never rename a real device.")
        }
        // primary-home.ts: the iPhone connects to «Главное», which lists the employee of its second Mac.
        let deviceName = "Главное"
        let app = XCUIApplication()
        app.launch()
        app.open(try XCTUnwrap(URL(string: invitation)))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
        confirm.tap()
        app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 3) { consent.tap() }
        let chats = app.buttons["openChats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 20), app.debugDescription)
        chats.tap()
        let header = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "deviceHeader-", deviceName)).firstMatch
        if ["Свёрнуто", "Collapsed"].contains(header.value as? String ?? "") { header.tap() }
        let employee = app.buttons["employee-" + profileID]
        for _ in 0..<8 where !employee.isHittable { app.swipeUp() }
        XCTAssertTrue(employee.isHittable, app.debugDescription)
        capture("phone-connected-fixture", app)
        employee.press(forDuration: 1)
        let rename = app.buttons.matching(NSPredicate(format: "label IN %@", ["Переименовать…", "Rename…"])).firstMatch
        XCTAssertTrue(rename.waitForExistence(timeout: 5), app.debugDescription)
        rename.tap()
        let input = app.textFields["renameName"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (input.value as? String ?? "").count) + "Редактор · iPhone")
        app.buttons["saveName"].tap()
        XCTAssertTrue(input.waitForNonExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(employee.label, "Редактор · iPhone")
        XCTAssertTrue(header.isHittable, app.debugDescription)
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label IN %@", "deviceMenu-", ["Действия: " + deviceName, "Actions: " + deviceName])).firstMatch.tap()
        XCTAssertTrue(rename.waitForExistence(timeout: 5)); rename.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (input.value as? String ?? "").count) + "Команда · iPhone")
        app.buttons["saveName"].tap()
        XCTAssertTrue(input.waitForNonExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Команда · iPhone"].firstMatch.waitForExistence(timeout: 5))
        capture("phone-shared-names", app)
        let renamedHeader = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label == %@", "deviceHeader-", "Команда · iPhone")).firstMatch
        renamedHeader.tap()
        XCTAssertTrue(employee.waitForNonExistence(timeout: 5))
        renamedHeader.tap()
        XCTAssertTrue(employee.waitForExistence(timeout: 5))
        let add = app.buttons["addMenu"]
        XCTAssertTrue(add.exists, "Chats must offer both a new employee and another device")
        add.tap()
        app.buttons["connectDevice"].tap()
        XCTAssertTrue(app.buttons["scanAdditionalInvitation"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["connectionInvitation"].exists)
        capture("phone-add-another-device", app)
    }

    @MainActor
    func testConnectionFormAlsoOffersQRScanning() throws {
        let app = XCUIApplication()
        #if targetEnvironment(simulator)
        // Launch-domain overrides leave existing test connections on disk intact.
        app.launchArguments = ["-openstrudel.signedOut", "YES", "-openstrudel.deviceConnections", "()", "-openstrudel.selectedDevice", "current", "-openstrudel.language", "ru"]
        #endif
        app.launch()
        let paste = app.buttons["pasteInvitation"]
        guard paste.waitForExistence(timeout: 10) else { throw XCTSkip("Run on an isolated, unpaired simulator.") }
        paste.tap()
        let scan = app.buttons["scanAdditionalInvitation"]
        XCTAssertTrue(scan.waitForExistence(timeout: 5))
        XCTAssertTrue(scan.isHittable)
        XCTAssertTrue(app.secureTextFields["connectionInvitation"].exists)
        #if targetEnvironment(simulator)
        scan.tap()
        XCTAssertTrue(app.staticTexts["invitationError"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.secureTextFields["connectionInvitation"].exists)
        #endif
        capture("connection-qr-and-link", app)
        let native = "openstrudel://connect?host=preview.example&port=7789&key=" + String(repeating: "a", count: 64) + "&pin=" + String(repeating: "b", count: 64) + "&name=Preview"
        let shared = "https://waiwai.is/openstrudel/connect.html#" + native.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        let field = app.secureTextFields["connectionInvitation"]
        field.tap(); field.typeText(shared)
        app.buttons["continueConnection"].tap()
        XCTAssertTrue(app.buttons["confirmMacPairing"].waitForExistence(timeout: 10), app.debugDescription)
        capture("camera-link-destination-review", app)
        // Parsing a link must never redeem it before the user confirms.
        app.buttons["cancelMacPairing"].tap()
    }

    @MainActor
    func testInvalidLinkFeedbackIsVisibleAfterKeyboardContinue() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let paste = app.buttons["pasteInvitation"]
        XCTAssertTrue(paste.waitForExistence(timeout: 15))
        paste.tap()
        let input = app.secureTextFields["connectionInvitation"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("not-a-connection-link\n")
        let error = app.staticTexts["invitationError"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        capture("invalid-link-keyboard-continue", app)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5),
                      "Continue must reveal its result instead of leaving it behind the keyboard")
        XCTAssertTrue(error.isHittable, app.debugDescription)
    }

    @MainActor
    func testCompanionOnboardingExplainsInvitationsWithoutCheckout() throws {
        let app = XCUIApplication()
        app.launch()
        let help = app.buttons["invitationHelp"]
        XCTAssertTrue(help.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Ваши помощники"].exists)
        XCTAssertFalse(app.buttons["setupCloud"].exists)
        XCTAssertFalse(app.buttons["cloudSignIn"].exists)
        XCTAssertFalse(app.buttons["cloudConfirmCost"].exists)
        XCTAssertFalse(app.links["Управлять облаком"].exists)
        for _ in 0..<4 where !help.isHittable { app.swipeUp() }
        help.tap()
        XCTAssertTrue(app.staticTexts["Начните на своём Mac"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Регистрация в OpenStrudel не нужна. Ссылку для своего iPhone или iPad вы создаёте сами."].exists)
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
        // Layout rounding can report 49.99… for a 50-pt capsule.
        XCTAssertGreaterThanOrEqual(qr.frame.height, 49.5)
        XCTAssertGreaterThanOrEqual(invitation.frame.height, 49.5)
        XCTAssertEqual(qr.frame.width, invitation.frame.width, accuracy: 1)
        invitation.tap()
        let input = app.secureTextFields["connectionInvitation"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        let next = app.buttons["continueConnection"]
        XCTAssertGreaterThanOrEqual(next.frame.height, 50)
        // iPad presents this form in a sheet narrower than the app window.
        XCTAssertGreaterThanOrEqual(next.frame.width, input.frame.width * 0.9)
        capture("11-invitation-actions", app)
        // A secure field is only as tall as its 21-pt line; the 44-pt row around it must focus it too.
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        input.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: 0, dy: -20)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "The link field needs a 44-pt target")
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
        // The keyboard's return key is also «Продолжить».
        app.buttons["continueConnection"].tap()
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
        // The sheet's Paste control: typing follows the simulator's last keyboard, and a Russian one drops Latin letters.
        UIPasteboard.general.string = valid.absoluteString
        app.buttons["Вставить"].tap()
        app.buttons["continueConnection"].tap()
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), app.debugDescription)
        // The system's “pasted from” banner covers the confirm button for a moment.
        let pasted = XCUIApplication(bundleIdentifier: "com.apple.springboard").descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "Tests-Runner")).firstMatch
        XCTAssertTrue(pasted.waitForNonExistence(timeout: 10))
        capture("04-confirm", app)
        confirm.tap()
        app.finishDevicePairing()
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 20), app.debugDescription)
        // Initial load can fail after the one-use invitation has been consumed.
        // The saved connection must recover without a second redemption.
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 20) {
            XCTAssertFalse(app.buttons["openChats"].exists)
            capture("05-ai-data-consent", app)
            consent.tap()
        }
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 35), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Подключение проверено."].waitForExistence(timeout: 10))
        let state = try await read(fixture + "/state")
        XCTAssertEqual(state["connections"] as? Int, (initial["connections"] as? Int ?? 0) + 1)
        XCTAssertGreaterThan(state["unavailableResponses"] as? Int ?? 0, initial["unavailableResponses"] as? Int ?? 0)
        capture("05-recovered", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Подключение проверено."].waitForExistence(timeout: 10))
        capture("06-relaunch", app)

        app.buttons["Настройки"].tap()
        let addDevice = app.buttons["addDevice"]
        XCTAssertTrue(addDevice.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Управлять облаком"].exists)
        addDevice.tap()
        XCTAssertTrue(app.secureTextFields["connectionInvitation"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Поделиться доступом")).firstMatch.exists)
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
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 20))
        _ = try await read(fixture + "/revoke")
        XCTAssertTrue(app.staticTexts["Подключитесь снова."].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)
        capture("07-revoked", app)
    }

    @MainActor
    func testWelcomeWithLargeText() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        #if targetEnvironment(simulator)
        app.launchArguments += ["-openstrudel.signedOut", "YES", "-openstrudel.deviceConnections", "()", "-openstrudel.selectedDevice", "current", "-openstrudel.language", "ru"]
        #endif
        app.launch()
        let button = app.buttons["pasteInvitation"]
        XCTAssertTrue(button.waitForExistence(timeout: 15))
        for _ in 0..<4 where !button.isHittable { app.swipeUp() }
        XCTAssertTrue(button.isHittable, app.debugDescription)
        capture("08-accessibility-welcome", app)
        button.tap()
        XCTAssertTrue(app.buttons["scanAdditionalInvitation"].waitForExistence(timeout: 5))
        let input = app.secureTextFields["connectionInvitation"]
        for _ in 0..<4 where !input.isHittable { app.swipeUp() }
        XCTAssertTrue(input.isHittable, app.debugDescription)
        capture("09-accessibility-invitation", app)
        let next = app.buttons["continueConnection"]
        for _ in 0..<6 where !next.isHittable { app.swipeUp() }
        XCTAssertTrue(next.isHittable, app.debugDescription)
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
    /// A SwiftUI Link: iOS reports it as a link or, on newer systems, as a button with the same label.
    @MainActor private func telegramLink(_ label: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND (elementType == %d OR elementType == %d)", label,
            XCUIElement.ElementType.link.rawValue, XCUIElement.ElementType.button.rawValue)).firstMatch
    }

    @MainActor private func capture(_ name:String,_ app:XCUIApplication) {
        // Capture the screen so landscape attachments retain the full display bounds.
        let attachment=XCTAttachment(screenshot:XCUIScreen.main.screenshot());attachment.name=name;attachment.lifetime = .keepAlways;add(attachment)
    }
}
