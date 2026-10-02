import XCTest

/// Runs against tests/fixtures/release-scenarios.ts on a disposable simulator.
final class ReleaseScenariosUITests: XCTestCase {
    @MainActor func testSettingsEmployeesMessagesAndRecovery() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_RELEASE_FIXTURE"] else {
            throw XCTSkip("Start the isolated release-scenarios fixture.")
        }
        let initial = try await read(fixture + "/state")
        let app = XCUIApplication()
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"] {
            app.launchArguments = ["-UIPreferredContentSizeCategoryName", size]
        }
        if ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_LANDSCAPE"] == "1" {
            XCUIDevice.shared.orientation = .landscapeLeft
        } else {
            XCUIDevice.shared.orientation = .portrait
        }
        app.launch()
        let invite = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 8) { capture("consent", app); consent.tap() }
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 20), app.debugDescription)
        capture("empty-conversation", app)

        app.buttons["Настройки"].tap()
        XCTAssertTrue(app.staticTexts["preview@example.com"].waitForExistence(timeout: 10))
        capture("settings-account-telegram", app)
        let pair = app.buttons["Подключить устройство"]
        try reveal(pair, in: app); pair.tap()
        XCTAssertTrue(app.staticTexts["Продолжите на другом устройстве"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Новое приглашение"].exists)
        capture("owner-qr-invitation", app)
        app.buttons["closeMobileInvitation"].tap()
        let switchAccount = app.buttons["Сменить аккаунт"]
        try reveal(switchAccount, in: app); switchAccount.tap()
        _ = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").wait(for: .runningForeground, timeout: 10)
        app.activate()
        XCTAssertTrue(app.staticTexts["TEST-56789"].waitForExistence(timeout: 10))
        capture("account-change", app)
        app.buttons["Отменить"].tap()
        XCTAssertTrue(switchAccount.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["preview@example.com"].exists)
        try done(app)

        app.buttons["Чаты"].tap()
        let editor = app.buttons["Редактор"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        try reveal(editor, in: app)
        capture("employee-list", app)
        // A row must work in the blank area as well as on its text.
        editor.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)).tap()
        XCTAssertTrue(app.staticTexts["Черновик готов"].waitForExistence(timeout: 10))
        capture("formatted-conversation", app)
        app.buttons["Настройки бота"].tap()
        XCTAssertTrue(app.textViews["Описание сотрудника"].waitForExistence(timeout: 10))
        capture("employee-settings", app)
        try reveal(app.buttons["Сервисы"], in: app)
        app.buttons["Сервисы"].tap()
        XCTAssertTrue(app.staticTexts["Документы"].waitForExistence(timeout: 10), app.debugDescription)
        capture("services", app)
        app.buttons["Подключить"].tap()
        _ = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").wait(for: .runningForeground, timeout: 10)
        app.activate(); app.buttons["Обновить"].tap()
        XCTAssertTrue(app.images["Подключено"].waitForExistence(timeout: 10), app.debugDescription)
        capture("service-connected", app)
        app.buttons["Закрыть"].tap()
        let telegram = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Telegram")).firstMatch
        try reveal(telegram, in: app); telegram.tap()
        XCTAssertTrue(app.staticTexts["Личный чат"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Рабочая группа"].exists)
        capture("employee-telegram", app)
        app.buttons["Связать"].firstMatch.tap()
        XCTAssertTrue(app.buttons["Чат связан"].firstMatch.waitForExistence(timeout: 10))
        try done(app)
        let name = app.textFields["Имя сотрудника"]
        try reveal(name, in: app)
        name.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        name.typeText(" QA")
        try done(app)
        XCTAssertTrue(app.staticTexts["Редактор QA"].waitForExistence(timeout: 10))

        let input = app.textFields["Сообщение"]
        for text in ["Первое сообщение", "Второе сообщение", "Третье сообщение"] {
            input.tap(); input.typeText(text); app.buttons["Отправить"].tap()
            XCTAssertEqual(input.value as? String, "Сообщение")
        }
        XCTAssertTrue(app.staticTexts["Принято: Третье сообщение"].waitForExistence(timeout: 30), app.debugDescription)
        capture("queued-messages", app)
        input.tap(); input.typeText("Проверка выбора"); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.buttons["Утром"].waitForExistence(timeout: 20))
        capture("request-input", app)
        app.buttons["Утром"].tap()
        XCTAssertTrue(app.staticTexts["Выбрано: Утром"].waitForExistence(timeout: 20))
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Выбрано: Утром"].waitForExistence(timeout: 20))

        _ = try await read(fixture + "/offline?value=1")
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Скоро на связи."].waitForExistence(timeout: 15))
        capture("offline", app)
        _ = try await read(fixture + "/offline?value=0")
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 25))
        capture("reconnected", app)
        let state = try await read(fixture + "/state")
        XCTAssertEqual(state["loginStarts"] as? Int, (initial["loginStarts"] as? Int ?? 0) + 1)
        XCTAssertEqual(state["loginCanceled"] as? Int, (initial["loginCanceled"] as? Int ?? 0) + 1)
        XCTAssertEqual(state["serviceConnected"] as? Bool, true)
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)
    }

    @MainActor private func read(_ value: String) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: value)))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        // The screen capture retains the correct canvas after iPad rotation.
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "release-" + name; attachment.lifetime = .keepAlways; add(attachment)
    }

    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication) throws {
        let scrollable = app.scrollViews.allElementsBoundByIndex
            + app.collectionViews.allElementsBoundByIndex + app.tables.allElementsBoundByIndex
        let scroller = scrollable.last(where: \.isHittable) ?? app
        for _ in 0..<16 where !element.isHittable {
            if element.frame.midY < scroller.frame.midY { scroller.swipeDown() }
            else { scroller.swipeUp() }
        }
        guard element.isHittable else {
            capture("unreachable-control", app)
            XCTFail(app.debugDescription)
            throw NSError(domain: "ReleaseUI", code: 1)
        }
    }

    @MainActor private func done(_ app: XCUIApplication) throws {
        // Nested sheets can leave the presenting sheet in the AX hierarchy.
        let button = try XCTUnwrap(app.buttons.matching(identifier: "Готово")
            .allElementsBoundByIndex.last(where: \.isHittable))
        button.tap()
    }
}
