import XCTest

@MainActor final class ModelSettingsUITests: XCTestCase {
    func testConversationModelPersistsAndLeavesEmployeeDefaultUnchanged() async throws {
        try await conversationChoice(largeText: false)
    }

    func testConversationModelAtLargestTextSize() async throws {
        try await conversationChoice(largeText: true)
    }

    private func conversationChoice(largeText: Bool) async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_MODEL_FIXTURE"] else { throw XCTSkip("Start model-settings.ts.") }
        _ = try await read(fixture + "/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        let invite = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap(); app.finishDevicePairing()
        if app.buttons["acceptAIDataSharing"].waitForExistence(timeout: 4) { app.buttons["acceptAIDataSharing"].tap() }
        let chats = app.buttons["openChats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 15)); chats.tap()
        let before = try await read(fixture + "/state")
        let employee = try XCTUnwrap(before["profile"] as? [String:Any])
        let row = app.buttons["employee-" + (try XCTUnwrap(employee["id"] as? String))]
        reveal(row, in: app); row.tap()
        let control = app.buttons["conversationModel"]
        XCTAssertTrue(control.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(control.isHittable)
        control.tap()
        let model = app.buttons["modelChoice"], speed = app.buttons["modelSpeed"]
        XCTAssertTrue(model.waitForExistence(timeout: 15)); model.tap(); app.buttons["GPT-6 Sol"].tap()
        reveal(speed, in: app); speed.tap(); app.buttons["Ultra Fast"].tap()
        let reasoning = app.buttons["modelReasoning"]
        reveal(reasoning, in: app); reasoning.tap(); app.buttons["Высокое"].tap()
        let save = app.buttons["saveModelSelection"]
        reveal(save, in: app); save.tap()
        XCTAssertTrue(app.staticTexts["Сохранено. Применится со следующего поручения."].waitForExistence(timeout: 10))
        capture(largeText ? "chat-model-largest-text" : "chat-model-saved", app)
        let after = try await read(fixture + "/state")
        let selected = try XCTUnwrap((after["conversation"] as? [String:Any])?["modelSelection"] as? [String:Any])
        XCTAssertEqual(selected["model"] as? String, "gpt-6-sol")
        XCTAssertEqual(selected["serviceTier"] as? String, "ultra")
        XCTAssertEqual(selected["reasoningEffort"] as? String, "high")
        XCTAssertTrue(NSDictionary(dictionary: employee).isEqual(to: try XCTUnwrap(after["profile"] as? [String:Any])))
        XCTAssertTrue(NSDictionary(dictionary: try XCTUnwrap(before["defaults"] as? [String:Any])).isEqual(to: try XCTUnwrap(after["defaults"] as? [String:Any])))
        app.navigationBars["Модель и скорость"].buttons["Готово"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(control.waitForExistence(timeout: 15))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "GPT-6 Sol"), object: control)], timeout: 10), .completed)
        capture(largeText ? "chat-composer-largest-text" : "chat-composer-reopened", app)
        control.tap(); XCTAssertTrue(model.waitForExistence(timeout: 15))
        model.tap(); app.buttons["GPT-6 Luna"].tap()
        XCTAssertFalse(speed.exists)
        XCTAssertFalse(app.buttons["modelReasoning"].exists)
        // Closing an uncommitted choice must keep the saved model.
        app.navigationBars["Модель и скорость"].buttons["Готово"].tap()
        let cancelled = try await read(fixture + "/state")
        XCTAssertEqual(((cancelled["conversation"] as? [String:Any])?["modelSelection"] as? [String:Any])?["model"] as? String, "gpt-6-sol")
        control.tap(); XCTAssertTrue(model.waitForExistence(timeout: 15)); model.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Как у сотрудника ·")).firstMatch.tap()
        reveal(save, in: app); save.tap()
        XCTAssertTrue(app.staticTexts["Сохранено. Применится со следующего поручения."].waitForExistence(timeout: 10))
        let restored = try await read(fixture + "/state")
        XCTAssertNil((restored["conversation"] as? [String:Any])?["modelSelection"])
        app.navigationBars["Модель и скорость"].buttons["Готово"].tap()
    }

    func testDeviceDefaultsEmployeeOverrideAndInheritance() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_MODEL_FIXTURE"] else { throw XCTSkip("Start model-settings.ts.") }
        _ = try await read(fixture + "/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        app.launch()
        let invite = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap(); app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 4) { consent.tap() }
        let chats = app.buttons["openChats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 15)); chats.tap()
        app.buttons["teamSettings"].tap()
        app.buttons["settingsSection"].tap(); app.buttons["Модели"].tap()
        let model = app.buttons["modelChoice"], speed = app.buttons["modelSpeed"]
        XCTAssertTrue(model.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Рекомендует OpenAI"].exists, app.debugDescription)
        capture("automatic-account-model", app)
        let reserve = app.buttons["addModelFallback"]
        reveal(reserve, in: app); reserve.tap()
        app.buttons["Claude Opus 5.5 · Anthropic"].tap()
        reveal(model, in: app)
        model.tap(); app.buttons["GPT-6 Astra"].tap()
        speed.tap()
        XCTAssertFalse(app.buttons["Ultra Fast"].exists)
        app.buttons["Fast"].tap()
        app.buttons["saveModelSelection"].tap()
        XCTAssertTrue(app.staticTexts["Сохранено. Применится со следующего поручения."].waitForExistence(timeout: 10))
        capture("device-model-and-fast", app)
        app.navigationBars["Настройки"].buttons["Готово"].tap()
        XCTAssertTrue(model.waitForNonExistence(timeout: 10), app.debugDescription)
        let state = try await read(fixture + "/state")
        let fallbacks = try XCTUnwrap(state["fallbacks"] as? [[String:Any]])
        XCTAssertEqual(fallbacks.map { $0["model"] as? String }, ["claude-opus-5-5"])
        let profile = try XCTUnwrap(state["profile"] as? [String:Any])
        app.buttons["employee-" + (try XCTUnwrap(profile["id"] as? String))].tap()
        let details = app.buttons["openEmployeeDetails"]
        XCTAssertTrue(details.waitForExistence(timeout: 10))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Редактор"), object: details)], timeout: 10), .completed, app.debugDescription)
        details.tap()
        reveal(model, in: app)
        XCTAssertTrue(model.exists, app.debugDescription)
        XCTAssertFalse(speed.isEnabled, app.debugDescription)
        model.tap(); app.buttons["GPT-6 Sol"].tap()
        speed.tap(); app.buttons["Ultra Fast"].tap()
        app.buttons["saveModelSelection"].tap()
        XCTAssertTrue(app.staticTexts["Сохранено. Применится со следующего поручения."].waitForExistence(timeout: 10))
        capture("employee-model-override", app)
        var updated = try await read(fixture + "/state")
        XCTAssertEqual((updated["profile"] as? [String:Any])?["serviceTier"] as? String, "ultra")
        model.tap(); app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Как на устройстве · GPT-6 Astra")).firstMatch.tap()
        app.buttons["saveModelSelection"].tap()
        XCTAssertTrue(app.staticTexts["Сохранено. Применится со следующего поручения."].waitForExistence(timeout: 10))
        XCTAssertFalse(speed.isEnabled)
        updated = try await read(fixture + "/state")
        XCTAssertTrue((updated["profile"] as? [String:Any])?["model"] is NSNull)
        capture("employee-inherits-device", app)
    }
    /// Choosing a ChatGPT model adds the speed and reasoning rows; adding rows must not reload and undo the choice.
    func testChoosingChatGPTAfterAnAPIKeyModelKeepsTheChoice() async throws {
        let (app, fixture) = try await pairedApplication()
        _ = try await read(fixture + "/claude")
        app.buttons["teamSettings"].tap()
        app.buttons["settingsSection"].tap(); app.buttons["Модели"].tap()
        let model = app.buttons["modelChoice"]
        XCTAssertTrue(model.waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["modelSpeed"].exists, app.debugDescription)
        model.tap(); app.buttons["GPT-6 Sol"].tap()
        XCTAssertTrue(app.buttons["modelSpeed"].waitForExistence(timeout: 10), app.debugDescription)
        // Give a reload the time it would need to land.
        _ = app.staticTexts["never-appears"].waitForExistence(timeout: 3)
        XCTAssertTrue(model.label.contains("GPT-6 Sol"), app.debugDescription)
        let save = app.buttons["saveModelSelection"]
        reveal(save, in: app); save.tap()
        XCTAssertTrue(app.staticTexts["Сохранено. Применится со следующего поручения."].waitForExistence(timeout: 10))
        let state = try await read(fixture + "/state")
        XCTAssertEqual((state["defaults"] as? [String:Any])?["model"] as? String, "gpt-6-sol")
        capture("device-model-from-api-key", app)
    }

    /// Choosing ElevenLabs shows its key field; adding those rows must not reload and switch back.
    func testChoosingElevenLabsKeepsTheChoiceAndTheTypedKey() async throws {
        let (app, _) = try await pairedApplication()
        app.buttons["teamSettings"].tap()
        app.buttons["settingsSection"].tap(); app.buttons["Приложение"].tap()
        let provider = app.buttons["speechProvider"]
        reveal(provider, in: app)
        XCTAssertTrue(provider.waitForExistence(timeout: 15), app.debugDescription)
        provider.tap(); app.buttons["ElevenLabs"].tap()
        let key = app.secureTextFields["speechAPIKey"]
        XCTAssertTrue(key.waitForExistence(timeout: 10), app.debugDescription)
        reveal(key, in: app); key.tap(); key.typeText("fixture-key")
        _ = app.staticTexts["never-appears"].waitForExistence(timeout: 3)
        XCTAssertTrue(key.exists, app.debugDescription)
        XCTAssertTrue(provider.label.contains("ElevenLabs"), app.debugDescription)
        XCTAssertTrue(app.buttons["saveSpeechSettings"].exists, app.debugDescription)
        capture("speech-elevenlabs-kept", app)
    }

    /// A device's controls share one Form row; one tap must run only the tapped control.
    func testOneTapInADeviceRowRunsOnlyThatControl() async throws {
        let (app, fixture) = try await pairedApplication()
        _ = try await read(fixture + "/invite")
        app.buttons["teamSettings"].tap()
        app.buttons["settingsSection"].tap(); app.buttons["Устройства"].tap()
        let device = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "deviceDetails")).firstMatch
        XCTAssertTrue(device.waitForExistence(timeout: 15), app.debugDescription)
        device.tap()
        let waiting = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "cancelInvitation-"))
        let reconnect = app.buttons["reconnectDevice"]
        XCTAssertTrue(reconnect.waitForExistence(timeout: 10), app.debugDescription)
        reveal(waiting.firstMatch, in: app)
        XCTAssertTrue(waiting.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        let invitations = waiting.count
        reveal(reconnect, in: app); reconnect.tap()
        _ = app.staticTexts["never-appears"].waitForExistence(timeout: 3)
        XCTAssertEqual(waiting.count, invitations, app.debugDescription)
        XCTAssertFalse(app.buttons["confirmDeviceSignOut"].exists, app.debugDescription)
        XCTAssertTrue(reconnect.isHittable, app.debugDescription)
        capture("device-row-single-tap", app)
    }

    private func pairedApplication() async throws -> (XCUIApplication, String) {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_MODEL_FIXTURE"] else { throw XCTSkip("Start model-settings.ts.") }
        _ = try await read(fixture + "/reset")
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        app.launch()
        let invite = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap(); app.finishDevicePairing()
        if app.buttons["acceptAIDataSharing"].waitForExistence(timeout: 4) { app.buttons["acceptAIDataSharing"].tap() }
        let chats = app.buttons["openChats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 15)); chats.tap()
        return (app, fixture)
    }

    private func read(_ url: String) async throws -> [String:Any] {
        let (data,_) = try await URLSession.shared.data(from: XCTUnwrap(URL(string:url)))
        return try XCTUnwrap(JSONSerialization.jsonObject(with:data) as? [String:Any])
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<8 where !element.isHittable {
            let scroller = app.scrollViews.allElementsBoundByIndex.last(where: \.isHittable) ?? app
            scroller.swipeUp()
        }
    }
    private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
