import XCTest

/// Runs against tests/fixtures/release-scenarios.ts on a disposable simulator.
final class ReleaseScenariosUITests: XCTestCase {
    @MainActor func testVisibilityPersistsAndOfflineDeviceCanBeRemoved() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_RELEASE_FIXTURE"] else { throw XCTSkip("Start the isolated fixture.") }
        let app = XCUIApplication()
        app.launch()
        let invite = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap(); app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        let initial = try await read(fixture + "/state")
        let editorID = try XCTUnwrap(initial["editor"] as? String)
        let profiles = try XCTUnwrap(initial["profiles"] as? [[String: Any]])
        let editorName = try XCTUnwrap(profiles.first { $0["id"] as? String == editorID }?["name"] as? String)
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 15)); app.buttons["openChats"].tap()
        let editor = app.buttons["employee-" + editorID]
        XCTAssertTrue(editor.waitForExistence(timeout: 10)); editor.press(forDuration: 1)
        let hide = app.buttons["Скрыть у меня"]
        XCTAssertTrue(hide.waitForExistence(timeout: 5)); hide.tap()
        XCTAssertTrue(editor.waitForNonExistence(timeout: 10))
        let hidden = app.buttons["hiddenEmployees"]
        XCTAssertTrue(hidden.waitForExistence(timeout: 5))
        capture("hidden-employee", app)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 15)); app.buttons["openChats"].tap()
        XCTAssertFalse(editor.exists)
        XCTAssertTrue(hidden.waitForExistence(timeout: 5)); hidden.tap()
        let show = app.buttons["Показать «" + editorName + "»"]
        XCTAssertTrue(show.waitForExistence(timeout: 5)); show.tap()
        try done(app)
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertFalse(hidden.exists)
        app.buttons["teamSettings"].tap()
        XCTAssertTrue(app.buttons["signOutThisDevice"].waitForExistence(timeout: 10))
        // Each device sheet hangs on one row: duplicates closed the sheet and Settings with it.
        app.openFirstDeviceDetails()
        // The details' rows share the group's identifier, so the row is found by its title.
        let rename = app.buttons["Переименовать…"]
        try reveal(rename, in: app); rename.tap()
        XCTAssertTrue(app.textFields["renameName"].waitForExistence(timeout: 5))
        app.buttons["Отмена"].tap()
        XCTAssertTrue(rename.waitForExistence(timeout: 5))
        _ = try await read(fixture + "/offline?value=1")
        let leave = app.buttons["signOutThisDevice"].firstMatch
        try reveal(leave, in: app); leave.tap()
        let remove = app.buttons["confirmDeviceSignOut"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        capture("remove-offline-device", app)
        app.buttons["Отмена"].tap()
        XCTAssertTrue(leave.waitForExistence(timeout: 5)); leave.tap()
        XCTAssertTrue(remove.waitForExistence(timeout: 5)); remove.tap()
        XCTAssertTrue(app.buttons["pasteInvitation"].waitForExistence(timeout: 20))
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["pasteInvitation"].waitForExistence(timeout: 10))
        _ = try await read(fixture + "/offline?value=0")
        let after = try await read(fixture + "/state")
        XCTAssertEqual((after["profiles"] as? [[String: Any]])?.count, profiles.count)
        XCTAssertEqual((after["telegram"] as? [[String: Any]])?.count, (initial["telegram"] as? [[String: Any]])?.count)
        capture("offline-device-removed-server-preserved", app)
    }

    @MainActor func testQueueEditingOrderingAndCancellation() async throws {
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
        let queue = try await read(fixture + "/queue-fixture")
        // The queue is the one chat's own: its rows edit and reorder right here.
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 15))
        let first = try XCTUnwrap(queue["first"] as? String), second = try XCTUnwrap(queue["second"] as? String)
        let firstRow = app.buttons["editQueuedMessage-" + first]
        let secondRow = app.buttons["editQueuedMessage-" + second]
        XCTAssertTrue(firstRow.waitForExistence(timeout: 15))
        XCTAssertTrue(secondRow.exists)
        if ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"]?.contains("Accessibility") == true {
            let input = app.descendants(matching: .any).matching(identifier: "messageComposer").firstMatch
            XCTAssertGreaterThan(input.frame.width, app.windows.firstMatch.frame.width * 0.7,
                                 "Large text needs a full-width field above the controls.")
        }
        firstRow.tap()
        let text = app.textViews["queuedMessageText"]
        XCTAssertTrue(text.waitForExistence(timeout: 5)); text.tap()
        text.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "Первый черновик".count) + "Исправленный черновик")
        app.buttons["Сохранить"].tap()
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10))
        var state = try await read(fixture + "/queue-state")
        var messages = try XCTUnwrap(state["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.first?["text"] as? String, "Исправленный черновик")
        let promote = app.buttons.matching(identifier: "В начало очереди").allElementsBoundByIndex.first(where: \.isEnabled)
        try XCTUnwrap(promote).tap()
        let reordered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in secondRow.frame.minY < firstRow.frame.minY }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [reordered], timeout: 10), .completed)
        capture("queue-edited-and-reordered", app)
        var findings: [String] = []
        try app.performAccessibilityAudit(for: [.hitRegion, .sufficientElementDescription]) { issue in
            findings.append((issue.element?.label ?? "") + ": " + issue.detailedDescription)
            return true
        }
        XCTAssertTrue(findings.isEmpty, findings.joined(separator: "\n"))
        app.buttons.matching(identifier: "Убрать сообщение из очереди").firstMatch.tap()
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: secondRow)
        XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 10), .completed)
        state = try await read(fixture + "/queue-state"); messages = try XCTUnwrap(state["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.map { $0["id"] as? String }, [first])
        _ = try await read(fixture + "/release-queue")
        let drained = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: firstRow)
        XCTAssertEqual(XCTWaiter.wait(for: [drained], timeout: 15), .completed)
        XCTAssertTrue(app.staticTexts["Принято: Исправленный черновик"].waitForExistence(timeout: 10))
        capture("queue-delivered-once", app)
    }

    @MainActor func testTelegramGroups() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_RELEASE_FIXTURE"] else { throw XCTSkip("Start the isolated fixture.") }
        let app = XCUIApplication()
        // The flow reads the Russian interface; a fresh simulator opens in English.
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"] {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        XCUIDevice.shared.orientation = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_LANDSCAPE"] == "1" ? .landscapeLeft : .portrait
        app.launch()
        let invite = try await read(fixture + "/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap(); app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 15)); app.buttons["openChats"].tap()
        let state = try await read(fixture + "/state")
        let editor = app.buttons["employee-" + (try XCTUnwrap(state["editor"] as? String))]
        XCTAssertTrue(editor.waitForExistence(timeout: 10)); editor.tap()
        let details = app.buttons["Настройки сотрудника"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: details)], timeout: 10), .completed)
        details.tap()
        XCTAssertTrue(app.textFields["Имя сотрудника"].waitForExistence(timeout: 10))
        let telegram = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Telegram")).firstMatch
        try reveal(telegram, in: app); telegram.tap()
        XCTAssertTrue(app.buttons["addTelegramGroup"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Связать мой Telegram"].exists)
        XCTAssertFalse(app.buttons["chooseTelegramGroup--100"].exists)
        // The owner chooses who answers the private chat; the main assistant keeps its history.
        let privateChat = { (state: [String: Any]) in (state["telegram"] as? [[String: Any]])?.first { $0["chatId"] as? String == "42" } }
        let direct = try XCTUnwrap(privateChat(state)?["conversationId"] as? String)
        let responder = app.buttons["telegramResponder-42"]
        try reveal(responder, in: app)
        waitUntil(responder, shows: "Общий помощник")
        try choose("Редактор", in: responder, app)
        waitUntil(responder, shows: "Редактор", saving: true)
        try await waitForState(fixture) { privateChat($0)?["profileId"] as? String == state["editor"] as? String }
        waitUntil(responder, shows: "Редактор")
        capture("telegram-private-employee", app)
        try choose("Общий помощник", in: responder, app)
        waitUntil(responder, shows: "Общий помощник", saving: true)
        let restored = try await waitForState(fixture) { privateChat($0)?["profileId"] as? String == nil }
        XCTAssertEqual(privateChat(restored)?["enabled"] as? Bool, true)
        XCTAssertEqual(privateChat(restored)?["conversationId"] as? String, direct)
        waitUntil(responder, shows: "Общий помощник")
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
        // This Home serves one feed per employee: no separate conversations, groups only in search.
        app.buttons["openChats"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["openConversations"].exists)
        let group = app.buttons["telegramConversation--100"]
        XCTAssertFalse(group.exists)
        capture("chats-without-conversations", app)
        // The private chat and the imported archive live in the main feed, captioned and without a reply action.
        app.buttons["OpenStrudel"].firstMatch.tap()
        let privateMessage = app.staticTexts["Пример личной переписки"]
        XCTAssertTrue(privateMessage.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Telegram · Личный чат"].exists)
        XCTAssertTrue(app.staticTexts["Сохранённая заметка"].exists)
        XCTAssertTrue(app.staticTexts["Архив · Старые заметки"].exists)
        // A reply sent before delivery was tracked claims no delivery state at all.
        XCTAssertFalse(app.staticTexts["Не отправлено в Telegram"].exists)
        XCTAssertFalse(app.staticTexts["Отправляем в Telegram…"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["conversationSources"].exists)
        XCTAssertFalse(app.staticTexts["telegramReplyDestination"].exists)
        capture("main-feed-history", app)
        // With no Reply to offer, a long press selects the archived text and its menu is the system one.
        app.staticTexts["Сохранённая заметка"].press(forDuration: 1)
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Скопировать")).firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Ответить в Telegram")).firstMatch.exists, app.debugDescription)
        capture("archive-keeps-selection", app)
        app.staticTexts["Архив · Старые заметки"].tap()
        // A group found by name opens the feed of the employee who works there.
        app.buttons["openChats"].tap()
        let search = app.searchFields["Найти чат"]
        XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Рабочая")
        XCTAssertTrue(group.waitForExistence(timeout: 10))
        capture("group-search-result", app)
        group.tap()
        XCTAssertTrue(privateMessage.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons["openEmployeeDetails"].value as? String, "OpenStrudel")
        XCTAssertFalse(app.descendants(matching: .any)["conversationSources"].exists)
        XCTAssertFalse(app.staticTexts["telegramReplyDestination"].exists)
        capture("group-opens-employee-feed", app)
        // After a relaunch the same feed opens; no separate group screen comes back.
        app.terminate(); app.launch()
        XCTAssertTrue(privateMessage.waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Архив · Старые заметки"].exists)
        XCTAssertFalse(app.staticTexts["telegramReplyDestination"].exists)
        app.buttons["openChats"].tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["openConversations"].exists)
        capture("feed-after-relaunch", app)
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
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 20), app.debugDescription)
        capture("empty-conversation", app)

        app.buttons["Настройки"].tap()
        // Settings open on every device's default model; the device list is its own section.
        XCTAssertTrue(app.buttons["modelChoice"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["settingsSection"].tap(); app.buttons["Устройства"].tap()
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
        let pair = app.buttons["shareDeviceAccess"].firstMatch
        try reveal(pair, in: app); pair.tap()
        app.buttons["Моему устройству"].tap()
        XCTAssertTrue(app.staticTexts["Продолжите на другом устройстве"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Новая ссылка"].exists)
        capture("owner-qr-invitation", app)
        app.buttons["closeMobileInvitation"].tap()
        // Explicit sign-in, cancellation and expired-account recovery are
        // exercised by AccountRecoveryUITests, including the settings route.
        try done(app)

        app.buttons["openChats"].tap()
        let editor = app.buttons["employee-" + (try XCTUnwrap(initial["editor"] as? String))]
        try reveal(editor, in: app)
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
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

    @MainActor private func choose(_ option: String, in picker: XCUIElement, _ app: XCUIApplication) throws {
        picker.tap()
        // The menu's option sits above the sheet; rows behind it can share the name.
        let item = app.buttons.matching(NSPredicate(format: "label == %@", option))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in item.allElementsBoundByIndex.contains(where: \.isHittable) }, object: nil)], timeout: 5), .completed, app.debugDescription)
        try XCTUnwrap(item.allElementsBoundByIndex.last(where: \.isHittable)).tap()
    }

    /// The owner sees the chat's responder, and the picker takes the next choice only after the Home answers.
    /// While the Home saves (the fixture takes 5 s), the picker already shows the owner's choice.
    @MainActor private func waitUntil(_ picker: XCUIElement, shows option: String, saving: Bool = false) {
        let shown = NSPredicate(format: "enabled == %@ AND label BEGINSWITH %@ AND (label CONTAINS %@ OR value CONTAINS %@)", NSNumber(value: !saving), "Личный чат", option, option)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: shown, object: picker)], timeout: saving ? 2 : 10), .completed, picker.debugDescription)
    }

    @MainActor @discardableResult private func waitForState(_ fixture: String, until condition: ([String: Any]) -> Bool) async throws -> [String: Any] {
        for _ in 0..<20 {
            let state = try await read(fixture + "/state")
            if condition(state) { return state }
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTFail("The fixture state did not change.")
        throw NSError(domain: "ReleaseUI", code: 2)
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
            if element.exists && element.frame.midY < scroller.frame.midY { scroller.swipeDown() }
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
