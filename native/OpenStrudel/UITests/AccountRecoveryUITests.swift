import XCTest

final class AccountRecoveryUITests: XCTestCase {
    @MainActor func testLargeTypeRecoveryKeepsChatAndSignInReachable() async throws {
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_ACCOUNT_FIXTURE"] else {
            throw XCTSkip("Start the isolated account-recovery fixture.")
        }
        _ = try await read(fixture + "/seed")
        _ = try await read(fixture + "/mode?value=connected")
        let app = XCUIApplication()
        // The flow reads the Russian interface; a fresh simulator opens in English.
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let invitation = try await read(fixture + "/invite?owner=1")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invitation["url"] as? String))))
        let pair = app.buttons["confirmMacPairing"]
        XCTAssertTrue(pair.waitForExistence(timeout: 15)); pair.tap()
        openConnectedDevice(app)
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 3) { consent.tap() }
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 15))
        _ = try await read(fixture + "/mode?value=expired")
        // The home says it first, with its search still in reach; the chat keeps its composer beside the notice.
        let recover = app.buttons["recoverOpenAIAccount"]
        XCTAssertTrue(recover.waitForExistence(timeout: 20))
        XCTAssertTrue(recover.isHittable)
        XCTAssertTrue(app.buttons["openChats"].isHittable)
        app.openChat()
        XCTAssertTrue(recover.waitForExistence(timeout: 10))
        XCTAssertTrue(recover.isHittable)
        XCTAssertTrue(app.textFields.firstMatch.isHittable)
        capture("largest-type-recovery-controls", app)
        recover.tap()
        // Each actions button names its account, so VoiceOver can tell them apart.
        let actions = app.buttons["accountActions-default"]
        XCTAssertTrue(actions.waitForExistence(timeout: 15))
        XCTAssertEqual(actions.label, "Действия: ChatGPT")
        let signIn = app.buttons["signInOpenAI"]
        for _ in 0..<12 where !signIn.isHittable { scrollPresentedContent(app) }
        XCTAssertTrue(signIn.isHittable)
        capture("largest-type-sign-in", app)
        signIn.tap(); app.activate()
        // The code replaces Sign in, so it is on screen where the person tapped.
        let code = app.staticTexts["openAIDeviceCode"]
        XCTAssertTrue(code.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(code.isHittable, app.debugDescription)
        capture("largest-type-device-code", app)
        let cancel = app.buttons["cancelOpenAILogin"]
        for _ in 0..<12 where !cancel.isHittable { scrollPresentedContent(app) }
        XCTAssertTrue(cancel.isHittable); cancel.tap()
        // Sign in returns where the code was, above the rows scrolled to.
        XCTAssertTrue(cancel.waitForNonExistence(timeout: 15))
        for _ in 0..<12 where !signIn.exists { scrollPresentedContent(app, back: true) }
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
    }

    @MainActor func testSharedHomeAccountLossRecoveryAndDraft() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_ACCOUNT_FIXTURE"] else {
            throw XCTSkip("Start the isolated account-recovery fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        let invitation = try await read(fixture + "/invite?owner=1")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invitation["url"] as? String))))
        let pair = app.buttons["confirmMacPairing"]
        XCTAssertTrue(pair.waitForExistence(timeout: 15)); pair.tap()
        openConnectedDevice(app)
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
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["openAIRecoveryNotice"].waitForNonExistence(timeout: 20))
        app.openChat()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Эта история остаётся")).firstMatch.waitForExistence(timeout: 15))
        let composer = app.textFields.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5)); composer.tap()
        composer.typeText("Черновик должен сохраниться")
        _ = try await read(fixture + "/mode?value=expired")
        let recover = app.buttons["recoverOpenAIAccount"]
        XCTAssertTrue(recover.waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Эта история остаётся")).firstMatch.exists)
        XCTAssertEqual(composer.value as? String, "Черновик должен сохраниться")
        XCTAssertTrue(app.buttons["Отправить"].waitForExistence(timeout: 5))
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
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 15))
        app.openChat()
        XCTAssertEqual(app.textFields.firstMatch.value as? String, "Черновик должен сохраниться")
        app.goHome()

        let clientInvitation = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(clientInvitation["url"] as? String))))
        XCTAssertTrue(pair.waitForExistence(timeout: 15)); pair.tap()
        openConnectedDevice(app)
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 15))
        _ = try await read(fixture + "/mode?value=expired")
        XCTAssertTrue(app.staticTexts["openAIRecoveryNotice"].waitForExistence(timeout: 20))
        XCTAssertFalse(recover.exists)
        XCTAssertFalse(signIn.exists)
        capture("connected-device-waits-for-home-owner", app)
        _ = try await read(fixture + "/mode?value=connected")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 15))
        XCTAssertFalse(signIn.exists)
        let finalState = try await read(fixture + "/state")
        XCTAssertEqual(finalState["loginStarts"] as? Int, 2)
    }

    @MainActor private func openConnectedDevice(_ app: XCUIApplication) {
        let open = app.buttons["openDeviceEmployees"]
        let appeared = open.waitForExistence(timeout: 25)
        if !appeared { print(app.debugDescription) }
        XCTAssertTrue(appeared); open.tap()
    }

    @MainActor private func read(_ value: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: value)))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    /// A screenshot kept with the test, and beside the others when a folder is named for them.
    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let shot = XCTAttachment(screenshot: screenshot); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        guard let folder = ProcessInfo.processInfo.environment["OPENSTRUDEL_SHOTS"] else { return }
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("account-" + name + ".png"))
    }

    @MainActor private func scrollPresentedContent(_ app: XCUIApplication, back: Bool = false) {
        // iPad sheets leave the underlying conversation in the AX hierarchy.
        let scroller = app.scrollViews.allElementsBoundByIndex.last(where: \.isHittable) ?? app
        if back { scroller.swipeDown() } else { scroller.swipeUp() }
    }
}

@MainActor extension XCUIApplication {
    func openFirstDeviceDetails() {
        let details = buttons["deviceDetails"].firstMatch
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        details.tap()
    }

    func finishDevicePairing() {
        let open = buttons["openDeviceEmployees"]
        XCTAssertTrue(open.waitForExistence(timeout: 25), debugDescription)
        open.tap()
    }

    /// The home is the first screen; its capsule opens the one chat with the keyboard up.
    func openChat() {
        let capsule = buttons["homeComposer"]
        XCTAssertTrue(capsule.waitForExistence(timeout: 30), debugDescription)
        capsule.tap()
        XCTAssertTrue(buttons["openEmployeeDetails"].waitForExistence(timeout: 15), debugDescription)
        // A fresh simulator explains its keyboard once.
        let tip = buttons["Continue"]
        if tip.waitForExistence(timeout: 2) { tip.tap() }
    }

    /// The other conversations: the home's search button, or the chat's "…" menu.
    func openConversations() {
        let search = buttons["openChats"]
        if search.exists && search.isHittable { search.tap(); return }
        let more = buttons["chatMore"]
        XCTAssertTrue(more.waitForExistence(timeout: 10), debugDescription); more.tap()
        let history = buttons["chatHistory"]
        XCTAssertTrue(history.waitForExistence(timeout: 5), debugDescription); history.tap()
    }

    /// Back from the open pages to the home.
    func goHome() {
        for _ in 0..<6 where !buttons["homeComposer"].exists {
            let back = navigationBars.buttons.element(boundBy: 0)
            guard back.waitForExistence(timeout: 5) else { break }
            back.tap()
        }
        XCTAssertTrue(buttons["homeComposer"].waitForExistence(timeout: 10), debugDescription)
    }

    /// A tile of the home's shelf, brought into sight and pressed. The shelf scrolls sideways.
    func openTile(_ identifier: String) {
        let tile = buttons[identifier], tiles = buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tile-"))
        XCTAssertTrue(tile.waitForExistence(timeout: 30), debugDescription)
        for _ in 0..<4 where !tile.isHittable { tiles.firstMatch.swipeLeft() }
        for _ in 0..<4 where !tile.isHittable { tiles.element(boundBy: min(2, tiles.count - 1)).swipeRight() }
        tile.tap()
    }
}
