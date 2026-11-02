import XCTest

/// Runs against tests/fixtures/one-chat.ts on a disposable simulator: one chat with one composer, readers behind it,
/// business clients beside it, and context travelling back to the chat.
final class OneChatUITests: XCTestCase {
    private var control = ""

    @MainActor
    func testOneChatReadersAndClients() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_ONE_CHAT_FIXTURE"] else { throw XCTSkip("Start tests/fixtures/one-chat.ts and pass its control URL.") }
        control = fixture
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        app.launch()
        let invite = try await read("/invite")
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        if confirm.waitForExistence(timeout: 15) { confirm.tap(); app.finishDevicePairing() }
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }

        // 1. The chat is the first place: history already there, the composer ready, exactly two tabs.
        let composer = app.textFields["Сообщение"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Три встречи и один акт на подпись."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Чат"].exists && app.tabBars.buttons["Клиенты"].exists, app.debugDescription)
        XCTAssertEqual(app.tabBars.buttons.count, 2)
        XCTAssertFalse(app.buttons["newEmployee"].exists)
        capture("chat", app)

        // 2. Two requests, two services, one conversation.
        composer.tap(); composer.typeText("Что в календаре на завтра?"); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.staticTexts["Календарь: завтра в 11:00 встреча с Acme."].waitForExistence(timeout: 30), app.debugDescription)
        composer.tap(); composer.typeText("А что в почте от Acme?"); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.staticTexts["Почта: от Acme пришёл подписанный акт."].waitForExistence(timeout: 30), app.debugDescription)
        let state = try await read("/")
        let turns = try XCTUnwrap(state["turns"] as? [[String: Any]])
        XCTAssertEqual(turns.compactMap { $0["service"] as? String }, ["calendar", "mail"])
        XCTAssertEqual(Set(turns.compactMap { $0["conversationId"] as? String }).count, 1)
        XCTAssertEqual(turns.first?["conversationId"] as? String, state["main"] as? String)
        capture("two-services", app)

        // 3. A draft and the readers: the employee, its edition, the group. None has a composer; the draft waits unchanged.
        composer.tap(); composer.typeText("Черновик, который должен выжить")
        app.buttons["openChats"].tap()
        let editorID = try XCTUnwrap(state["editor"] as? String)
        let feed = app.buttons["feed-" + editorID]
        XCTAssertTrue(feed.waitForExistence(timeout: 10), app.debugDescription)
        feed.tap()
        XCTAssertTrue(app.buttons["newsMode-edition"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        XCTAssertFalse(app.buttons["Отправить"].exists)
        XCTAssertFalse(app.textFields["Спросить News об этой истории"].exists)
        capture("reader-edition", app)
        let lead = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Mistral")).firstMatch
        XCTAssertTrue(lead.waitForExistence(timeout: 10)); lead.tap()
        let discussStory = app.buttons["discussStory"]
        XCTAssertTrue(discussStory.waitForExistence(timeout: 10), app.debugDescription)
        capture("reader-story", app)
        discussStory.tap()
        // Back on the chat, the story is attached to the untouched draft.
        XCTAssertTrue(app.otherElements["draftContext"].waitForExistence(timeout: 10) || app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Новость · Mistral")).firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(app.textFields["Сообщение"].value as? String, "Черновик, который должен выжить")
        capture("chat-story-context", app)
        app.buttons["removeDraftContext"].tap()

        app.buttons["openChats"].tap()
        let employee = app.buttons["employee-" + editorID]
        XCTAssertTrue(employee.waitForExistence(timeout: 10)); employee.tap()
        XCTAssertTrue(app.buttons["newsMode-chat"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["newsMode-chat"].tap()
        let history = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Черновик готов")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        XCTAssertFalse(app.buttons["Отправить"].exists)
        capture("reader-employee", app)
        history.press(forDuration: 1.2)
        let discuss = app.buttons["Обсудить в чате"]
        XCTAssertTrue(discuss.waitForExistence(timeout: 5), app.debugDescription); discuss.tap()
        XCTAssertTrue(app.textFields["Сообщение"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.textFields["Сообщение"].value as? String, "Черновик, который должен выжить")
        XCTAssertTrue(app.buttons["removeDraftContext"].waitForExistence(timeout: 5))
        app.buttons["removeDraftContext"].tap()

        app.buttons["openChats"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10)); search.tap(); search.typeText("Рабочая")
        let group = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "telegramConversation-")).firstMatch
        XCTAssertTrue(group.waitForExistence(timeout: 10), app.debugDescription); group.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "когда будет готов акт")).firstMatch.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "telegramReply-")).firstMatch.exists)
        XCTAssertFalse(app.textFields["telegramReplyText"].exists)
        capture("reader-group", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertEqual(app.textFields["Сообщение"].waitForExistence(timeout: 10) ? app.textFields["Сообщение"].value as? String : nil, "Черновик, который должен выжить")

        // 4. Clients: the real list from the connector, a client, its files, and Discuss back into the same draft.
        app.tabBars.buttons["Клиенты"].tap()
        let acme = app.buttons["client-c-acme"]
        XCTAssertTrue(acme.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.buttons["client-c-north"].exists)
        XCTAssertFalse(app.buttons["client-c-old"].exists, "archived clients stay folded")
        capture("clients", app)
        acme.tap()
        XCTAssertTrue(app.staticTexts["Acme"].waitForExistence(timeout: 10))
        let file = app.descendants(matching: .any)["clientFile-f-contract"]
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any)["clientFile-f-logo"].exists)
        capture("client-detail", app)
        app.buttons["discussClient"].tap()
        XCTAssertTrue(app.textFields["Сообщение"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["removeDraftContext"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["Сообщение"].value as? String, "Черновик, который должен выжить")
        capture("chat-client-context", app)
        // The draft and its client survive a relaunch, then go as one request with the verified client on it.
        app.terminate(); app.launch()
        XCTAssertTrue(app.textFields["Сообщение"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(app.textFields["Сообщение"].value as? String, "Черновик, который должен выжить")
        XCTAssertTrue(app.buttons["removeDraftContext"].waitForExistence(timeout: 10))
        app.textFields["Сообщение"].tap(); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.staticTexts["Про это: Черновик, который должен выжить"].waitForExistence(timeout: 30), app.debugDescription)
        let contextLine = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Клиент · Acme")).firstMatch
        XCTAssertTrue(contextLine.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["removeDraftContext"].exists)
        let after = try await read("/")
        let last = try XCTUnwrap((after["turns"] as? [[String: Any]])?.last)
        XCTAssertEqual(last["context"] as? Bool, true)
        XCTAssertEqual(last["conversationId"] as? String, after["main"] as? String)
        XCTAssertEqual(((after["companyCalls"] as? [[String: Any]]) ?? []).filter { $0["authorized"] as? Bool == false }.count, 0)
        capture("chat-client-sent", app)

        // 5. The states a refusal has: each its own screen, never an empty list.
        for (mode, code) in [("empty", "empty"), ("unauthorized", "service_auth"), ("forbidden", "service_denied"), ("ok", "ready")] {
            _ = try await read("/company?mode=" + mode)
            app.tabBars.buttons["Клиенты"].tap()
            if app.navigationBars.buttons.element(boundBy: 0).exists { app.navigationBars.buttons.element(boundBy: 0).tap() }
            app.buttons["refreshClients"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["clientsState-" + code].waitForExistence(timeout: 20), "mode \(mode): " + app.debugDescription)
            capture("clients-" + code, app)
            app.tabBars.buttons["Чат"].tap()
        }
    }

    @MainActor private func read(_ path: String) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: control + path)))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
