import XCTest

/// Runs against tests/fixtures/release-scenarios.ts on a disposable simulator.
final class ReleaseScenariosUITests: XCTestCase {
    @MainActor func testTelegramGroups() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_RELEASE_FIXTURE"] else { throw XCTSkip("Start the isolated fixture.") }
        let app = XCUIApplication()
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"] {
            app.launchArguments = ["-UIPreferredContentSizeCategoryName", size]
        }
        XCUIDevice.shared.orientation = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_LANDSCAPE"] == "1" ? .landscapeLeft : .portrait
        app.launch()
        let invite = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap(); app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 15)); app.buttons["Чаты"].tap()
        XCTAssertTrue(app.buttons["Редактор"].waitForExistence(timeout: 10)); app.buttons["Редактор"].tap()
        app.buttons["Настройки сотрудника"].tap()
        let telegram = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Telegram")).firstMatch
        try reveal(telegram, in: app); telegram.tap()
        XCTAssertTrue(app.buttons["addTelegramGroup"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Связать мой Telegram"].exists)
        XCTAssertFalse(app.buttons["chooseTelegramGroup--100"].exists)
        let toggle = app.buttons["toggleTelegramGroup--100"]
        try reveal(toggle, in: app)
        capture("telegram-auto-connected", app)
        let before = try await read(fixture + "/state")["telegram"] as? [[String: Any]]
        let conversation = before?.first { $0["chatId"] as? String == "-100" }?["conversationId"] as? String
        XCTAssertNotNil(conversation)
        toggle.tap()
        XCTAssertTrue(app.staticTexts["На паузе · переписка сохранена"].waitForExistence(timeout: 10))
        toggle.tap()
        XCTAssertTrue(app.staticTexts["Помощник сам подбирает сотрудника по задаче"].waitForExistence(timeout: 10))
        let after = try await read(fixture + "/state")["telegram"] as? [[String: Any]]
        XCTAssertEqual(conversation, after?.first { $0["chatId"] as? String == "-100" }?["conversationId"] as? String)
        _ = try await read(fixture + "/telegram-private?value=0")
        try await Task.sleep(for: .seconds(6))
        XCTAssertFalse(app.buttons["addTelegramGroup"].exists)
        XCTAssertTrue(app.buttons["openPersonalTelegram"].exists)
        XCTAssertTrue(toggle.exists)
        capture("telegram-existing-without-private", app)
        _ = try await read(fixture + "/telegram-private?value=1")
        try backToEmployee(app)
        XCTAssertTrue(app.textFields["Имя сотрудника"].waitForExistence(timeout: 5))
        app.buttons["saveEmployeeChanges"].tap()
        app.buttons["Чаты"].tap()
        let group = app.buttons["telegramConversation--100"]
        XCTAssertTrue(group.waitForExistence(timeout: 10)); group.tap()
        XCTAssertTrue(app.buttons["Telegram · Рабочая группа"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["chooseConversation"].exists)
        XCTAssertTrue(app.staticTexts["telegramReplyDestination"].exists)
        capture("telegram-in-chat-list", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Telegram · Рабочая группа"].waitForExistence(timeout: 15))
        app.buttons["Telegram · Рабочая группа"].tap()
        app.buttons["telegramGroupServices"].tap()
        XCTAssertTrue(app.staticTexts["Подключения для этой группы."].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Личный чат"].exists)
        capture("telegram-group-services", app)
    }

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
        app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 8) { capture("consent", app); consent.tap() }
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 20), app.debugDescription)
        capture("empty-conversation", app)

        app.buttons["Настройки"].tap()
        XCTAssertTrue(app.buttons["addDevice"].waitForExistence(timeout: 10))
        capture("settings-account-telegram", app)
        // Approval mode belongs to this device, not an individual chat.
        app.buttons["settingsSection"].tap()
        app.buttons["Приложение"].tap()
        XCTAssertTrue(app.buttons["approvalMode-ask"].waitForExistence(timeout: 10))
        capture("approval-modes", app)
        app.buttons["approvalMode-auto"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: app.buttons["approvalMode-auto"])], timeout: 10), .completed)
        app.buttons["approvalMode-approve_all"].tap()
        XCTAssertTrue(app.buttons["Включить для этого устройства"].waitForExistence(timeout: 5))
        let approvalAlert = app.alerts["Выполнять без подтверждений?"]
        XCTAssertTrue(approvalAlert.waitForExistence(timeout: 5))
        approvalAlert.buttons["Отмена"].tap()
        XCTAssertTrue(app.buttons["Включить для этого устройства"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(approvalAlert.waitForNonExistence(timeout: 5))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: app.buttons["approvalMode-auto"])], timeout: 10), .completed)
        app.buttons["approvalMode-ask"].tap()
        app.buttons["settingsSection"].tap()
        app.buttons["Устройства"].tap()
        app.openFirstDeviceDetails()
        let pair = app.buttons["Получить ссылку подключения"].firstMatch
        try reveal(pair, in: app); pair.tap()
        XCTAssertTrue(app.staticTexts["Продолжите на другом устройстве"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Новая ссылка"].exists)
        capture("owner-qr-invitation", app)
        app.buttons["closeMobileInvitation"].tap()
        // Explicit sign-in, cancellation and expired-account recovery are
        // exercised by AccountRecoveryUITests, including the settings route.
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
        app.buttons["Настройки сотрудника"].tap()
        XCTAssertTrue(app.textViews["Описание сотрудника"].waitForExistence(timeout: 10))
        capture("employee-settings", app)
        let editableName = app.textFields["Имя сотрудника"]
        editableName.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        editableName.typeText(" Не сохранять")
        app.buttons["cancelEmployeeChanges"].tap()
        XCTAssertTrue(app.buttons["Продолжить редактирование"].waitForExistence(timeout: 5))
        app.buttons["Продолжить редактирование"].tap()
        XCTAssertTrue((editableName.value as? String)?.contains("Не сохранять") == true)
        app.buttons["cancelEmployeeChanges"].tap()
        app.buttons["Не сохранять"].tap()
        XCTAssertTrue(app.buttons["Настройки сотрудника"].waitForExistence(timeout: 10))
        app.buttons["Настройки сотрудника"].tap()
        XCTAssertTrue(editableName.waitForExistence(timeout: 10))
        XCTAssertEqual(editableName.value as? String, "Редактор")
        try reveal(app.buttons["Сервисы и навыки"], in: app)
        app.buttons["Сервисы и навыки"].tap()
        XCTAssertTrue(app.buttons["addEmployeeExtension"].waitForExistence(timeout: 10))
        app.buttons["addEmployeeExtension"].tap()
        XCTAssertTrue(app.staticTexts["Документы"].waitForExistence(timeout: 10), app.debugDescription)
        capture("services", app)
        let connectService = app.buttons["connect-service-qa-documents"]
        if connectService.exists {
            connectService.tap()
            XCTAssertTrue(XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").wait(for: .runningForeground, timeout: 10))
            capture("service-browser", app)
            // Foreground does not mean the OAuth callback page has loaded yet.
            // Wait for the synthetic provider, as a person would before returning.
            var connected = false
            for _ in 0..<30 {
                connected = try await read(fixture + "/state")["serviceConnected"] as? Bool == true
                if connected { break }
                try await Task.sleep(for: .seconds(1))
            }
            XCTAssertTrue(connected, "The browser must complete the test provider callback.")
            app.activate()
        }
        XCTAssertTrue(app.staticTexts["Подключён"].waitForExistence(timeout: 10), app.debugDescription)
        capture("service-connected", app)
        try backToEmployee(app)
        let telegram = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Telegram")).firstMatch
        try reveal(telegram, in: app); telegram.tap()
        XCTAssertTrue(app.buttons["addTelegramGroup"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Связать мой Telegram"].exists)
        XCTAssertTrue(app.buttons["toggleTelegramGroup--100"].waitForExistence(timeout: 5))
        capture("employee-telegram", app)
        try backToEmployee(app)
        let name = app.textFields["Имя сотрудника"]
        try reveal(name, in: app)
        name.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
        name.typeText(" QA")
        app.buttons["saveEmployeeChanges"].tap()
        XCTAssertTrue(app.staticTexts["Редактор QA"].waitForExistence(timeout: 10))

        let input = app.descendants(matching: .any).matching(identifier: "messageComposer").firstMatch
        input.tap(); input.typeText("Первая строка\nВторая строка")
        XCTAssertEqual(input.value as? String, "Первая строка\nВторая строка", "The iOS Return key must preserve a multiline draft.")
        app.buttons["Отправить"].tap()
        // Markdown soft line breaks render as spaces; the draft assertion above
        // verifies that Return retained the original newline before submission.
        XCTAssertTrue(app.staticTexts["Принято: Первая строка Вторая строка"].waitForExistence(timeout: 20))
        let messageCount = Int(ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_MESSAGE_COUNT"] ?? "3") ?? 3
        let queuedTexts = (1...max(3, min(messageCount, 30))).map { "Сообщение \($0)" }
        for text in queuedTexts {
            input.tap(); input.typeText(text); app.buttons["Отправить"].tap()
            XCTAssertEqual(input.value as? String, "")
        }
        XCTAssertTrue(app.staticTexts["Принято: \(queuedTexts.last!)"].waitForExistence(timeout: 30), app.debugDescription)
        capture("queued-messages", app)
        input.tap(); input.typeText("Проверка выбора"); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.buttons["Утром"].waitForExistence(timeout: 20))
        capture("request-input", app)
        app.buttons["Утром"].tap()
        XCTAssertTrue(app.staticTexts["Выбрано: Утром"].waitForExistence(timeout: 20))
        // Pending -> approval -> thinking -> answer used to trigger a layout
        // loop. Repeat with alternating decisions and a changing input height.
        for index in 1...6 {
            input.tap()
            input.typeText("Проверка подтверждения \(index). " + String(repeating: "Безопасная проверка раскладки. ", count: index))
            app.buttons["Отправить"].tap()
            let decision = app.buttons[index.isMultiple(of: 2) ? "Отказать" : "Разрешить"]
            XCTAssertTrue(decision.waitForExistence(timeout: 20))
            decision.tap()
            XCTAssertTrue(decision.waitForNonExistence(timeout: 10))
            let answer = index.isMultiple(of: 2) ? "Действие не выполнено." : "Проверка выполнена."
            XCTAssertTrue(app.staticTexts[answer].firstMatch.waitForExistence(timeout: 20))
            XCTAssertTrue(input.isHittable)
        }
        capture("repeated-approvals", app)
        input.tap(); input.typeText("Проверка свободного места"); app.buttons["Отправить"].tap()
        let storageError = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "На устройстве сотрудника закончилось место.")).firstMatch
        XCTAssertTrue(storageError.waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "ENOSPC:")).firstMatch.exists)
        capture("readable-storage-error", app)
        input.tap(); input.typeText("После освобождения места"); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.staticTexts["Принято: После освобождения места"].waitForExistence(timeout: 20))
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Принято: После освобождения места"].waitForExistence(timeout: 20))

        _ = try await read(fixture + "/offline?value=1")
        app.terminate(); app.launch()
        let offlineNotice = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "не на связи")).firstMatch
        XCTAssertTrue(offlineNotice.waitForExistence(timeout: 15))
        capture("offline", app)
        _ = try await read(fixture + "/offline?value=0")
        XCTAssertTrue(offlineNotice.waitForNonExistence(timeout: 25))
        input.tap(); input.typeText("После восстановления связи"); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.staticTexts["Принято: После восстановления связи"].waitForExistence(timeout: 20))
        capture("reconnected", app)
        let state = try await read(fixture + "/state")
        XCTAssertEqual(state["loginStarts"] as? Int, (initial["loginStarts"] as? Int ?? 0))
        XCTAssertEqual(state["loginCanceled"] as? Int, (initial["loginCanceled"] as? Int ?? 0))
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

    @MainActor private func backToEmployee(_ app: XCUIApplication) throws {
        let back = app.navigationBars.buttons["Сотрудник"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), app.debugDescription)
        back.tap()
    }

    @MainActor private func done(_ app: XCUIApplication) throws {
        // Nested sheets can leave the presenting sheet in the AX hierarchy.
        let button = try XCTUnwrap(app.buttons.matching(identifier: "Готово")
            .allElementsBoundByIndex.last(where: \.isHittable))
        button.tap()
    }
}
