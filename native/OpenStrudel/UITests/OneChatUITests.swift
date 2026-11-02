import XCTest

/// Runs against two instances of tests/fixtures/one-chat.ts on a disposable simulator: one chat with one composer,
/// readers behind it, business clients beside it, and navigation isolated to the selected Home.
final class OneChatUITests: XCTestCase {
    private var control = ""

    @MainActor
    func testOneChatReadersAndClients() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_ONE_CHAT_FIXTURE"] else { throw XCTSkip("Start the first isolated one-chat fixture and pass its control URL.") }
        let secondFixture = try XCTUnwrap(ProcessInfo.processInfo.environment["OPENSTRUDEL_ONE_CHAT_SECOND_FIXTURE"], "Start a second isolated one-chat fixture; the Home-switch regression must run.")
        XCTAssertNotEqual(fixture, secondFixture, "Home switching requires two independent fixtures")
        let firstHome = "Первый тестовый Home", secondHome = "Второй тестовый Home"
        control = fixture
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        app.launch()
        try await pair(app, fixture: fixture, name: firstHome)
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }

        // 1. The chat is the first place: history already there, the composer ready, exactly two tabs.
        let composer = app.textFields["Сообщение"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Три встречи и один акт на подпись."].waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertTrue(app.tabBars.buttons["Чат"].exists && app.tabBars.buttons["Клиенты"].exists, app.debugDescription)
        XCTAssertEqual(app.tabBars.buttons.count, 2)
        XCTAssertFalse(app.buttons["newEmployee"].exists)
        let send = app.buttons["sendMessage"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(send.isEnabled, "The fresh fixture must start with an empty composer")
        XCTAssertFalse(app.buttons["removeDraftContext"].exists)
        // An empty TextField can expose its custom prompt as its accessibility value.
        let emptyComposerValue = try XCTUnwrap(composer.value as? String)
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
        XCTAssertEqual(state["messageRequests"] as? Int, 2)
        XCTAssertEqual((state["sentMessages"] as? [[String: Any]])?.count, 2)
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
        XCTAssertTrue(app.descendants(matching: .any)["reader"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["readerTitle"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(app.buttons["readerTitle"].value as? String, "Редактор")
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
        try await assertNoSend(since: state)

        // 4. Clients: the real list from the connector, a client, its files, and Discuss back into the same draft.
        app.tabBars.buttons["Клиенты"].tap()
        let acme = app.buttons["client-c-acme"]
        XCTAssertTrue(acme.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.buttons["client-c-north"].exists)
        XCTAssertFalse(app.buttons["client-c-old"].exists, "archived clients stay folded")
        capture("clients", app)
        try tapWhitespace(in: acme, app: app)
        XCTAssertTrue(app.descendants(matching: .any)["clientDetail"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.navigationBars["Acme"].exists, app.debugDescription)
        let file = app.descendants(matching: .any)["clientFile-f-contract"]
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any)["clientFile-f-logo"].exists)
        capture("client-detail", app)
        // Back must clear selection: the very same row opens again without another selection or relaunch.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(acme.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.descendants(matching: .any)["clientDetail"].exists)
        acme.tap()
        XCTAssertTrue(app.navigationBars["Acme"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription)
        capture("client-back-same-row", app)
        // Switching tabs retains the client's destination, not just its highlighted row.
        app.tabBars.buttons["Чат"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Черновик, который должен выжить")
        app.tabBars.buttons["Клиенты"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["clientDetail"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription)
        // A highlighted list row is not navigation. Back and a different row must
        // open that client's detail, without retaining the first client's files.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let north = app.buttons["client-c-north"]
        XCTAssertTrue(north.waitForExistence(timeout: 10), app.debugDescription)
        north.tap()
        XCTAssertTrue(app.descendants(matching: .any)["clientDetail"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.navigationBars["North Wind"].exists, app.debugDescription)
        XCTAssertTrue(app.staticTexts["У клиента пока нет файлов."].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(file.exists, "the second client must not show Acme's files")
        app.buttons["discussClient"].tap()
        assertClientDraft("North Wind", in: app)
        try await assertNoSend(since: state)
        capture("chat-north-context", app)
        // A new Discuss replaces the attached client with the current one and preserves the words.
        app.tabBars.buttons["Клиенты"].tap()
        XCTAssertTrue(acme.waitForExistence(timeout: 10), app.debugDescription)
        acme.tap()
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["discussClient"].tap()
        XCTAssertTrue(app.textFields["Сообщение"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["removeDraftContext"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["Сообщение"].value as? String, "Черновик, который должен выжить")
        assertClientDraft("Acme", in: app)
        try await assertNoSend(since: state)
        capture("chat-client-context", app)
        // Discuss intentionally returns Clients to its list. The same client must
        // open again after that tab transition, without selecting a different row first.
        app.buttons["removeDraftContext"].tap()
        app.tabBars.buttons["Клиенты"].tap()
        XCTAssertTrue(acme.waitForExistence(timeout: 10), app.debugDescription)
        acme.tap()
        XCTAssertTrue(app.descendants(matching: .any)["clientDetail"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["discussClient"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Черновик, который должен выжить")
        XCTAssertTrue(app.buttons["removeDraftContext"].waitForExistence(timeout: 5), app.debugDescription)
        assertClientDraft("Acme", in: app)
        try await assertNoSend(since: state)
        capture("chat-client-context-reopened", app)
        // The draft and its client survive a relaunch, then go as one request with the verified client on it.
        app.terminate(); app.launch()
        XCTAssertTrue(app.textFields["Сообщение"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(app.textFields["Сообщение"].value as? String, "Черновик, который должен выжить")
        XCTAssertTrue(app.buttons["removeDraftContext"].waitForExistence(timeout: 10))
        assertClientDraft("Acme", in: app)
        try await assertNoSend(since: state)
        app.textFields["Сообщение"].tap(); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.staticTexts["Про это: Черновик, который должен выжить"].waitForExistence(timeout: 30), app.debugDescription)
        let contextLine = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Клиент · Acme")).firstMatch
        XCTAssertTrue(contextLine.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["removeDraftContext"].exists)
        let after = try await read("/")
        let sentTurns = try XCTUnwrap(after["turns"] as? [[String: Any]])
        XCTAssertEqual(sentTurns.count, 3, "Discuss must not send; the explicit Send adds exactly one turn")
        XCTAssertEqual(after["messageRequests"] as? Int, 3)
        let last = try XCTUnwrap(sentTurns.last)
        XCTAssertEqual(last["context"] as? Bool, true)
        XCTAssertEqual(last["conversationId"] as? String, after["main"] as? String)
        let sentMessages = try XCTUnwrap(after["sentMessages"] as? [[String: Any]])
        XCTAssertEqual(sentMessages.count, 3)
        let sent = try XCTUnwrap(sentMessages.last)
        XCTAssertEqual(sent["text"] as? String, "Черновик, который должен выжить")
        XCTAssertEqual(sent["conversationId"] as? String, after["main"] as? String)
        let acceptedContext = try XCTUnwrap(sent["context"] as? [String: Any])
        XCTAssertEqual(acceptedContext["type"] as? String, "client")
        XCTAssertEqual(acceptedContext["clientId"] as? String, "c-acme")
        XCTAssertEqual(acceptedContext["slug"] as? String, "acme")
        XCTAssertEqual(acceptedContext["name"] as? String, "Acme")
        let source = try XCTUnwrap(acceptedContext["source"] as? [String: Any])
        XCTAssertEqual(source["connector"] as? String, "company")
        XCTAssertEqual(source["endpoint"] as? String, after["companyURL"] as? String)
        XCTAssertNotNil((source["fingerprint"] as? String)?.range(of: "^[a-f0-9]{16}$", options: .regularExpression))
        XCTAssertEqual(((after["companyCalls"] as? [[String: Any]]) ?? []).filter { $0["authorized"] as? Bool == false }.count, 0)
        capture("chat-client-sent", app)

        // 5. The states a refusal has: each its own screen, never an empty list.
        // The chat's scrolling minimised the tab bar; a relaunch brings a full one back.
        app.terminate(); app.launch()
        for (mode, code) in [("empty", "empty"), ("unauthorized", "service_auth"), ("forbidden", "service_denied"), ("ok", "ready")] {
            _ = try await read("/company?mode=" + mode)
            let clientsTab = app.tabBars.buttons["Клиенты"]
            XCTAssertTrue(clientsTab.waitForExistence(timeout: 30), app.debugDescription); clientsTab.tap()
            if !app.buttons["refreshClients"].waitForExistence(timeout: 3), clientsTab.isSelected, app.navigationBars.buttons.element(boundBy: 0).exists { app.navigationBars.buttons.element(boundBy: 0).tap() }
            XCTAssertTrue(app.buttons["refreshClients"].waitForExistence(timeout: 10), app.debugDescription)
            app.buttons["refreshClients"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["clientsState-" + code].waitForExistence(timeout: 20), "mode \(mode): " + app.debugDescription)
            capture("clients-" + code, app)
            app.tabBars.buttons["Чат"].tap()
        }

        // 6. An actual Home change clears the old client's destination, including while Clients is visible.
        // The draft has been sent and its context cleared; switching while a draft exists is correctly refused.
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, emptyComposerValue, "Send must restore the initial empty composer")
        XCTAssertTrue(send.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(send.isEnabled, "No draft may remain before changing Homes")
        XCTAssertFalse(app.buttons["removeDraftContext"].exists)
        let second = try await read("/company?mode=empty", from: secondFixture)
        XCTAssertNotEqual(second["main"] as? String, after["main"] as? String)
        app.tabBars.buttons["Клиенты"].tap()
        XCTAssertTrue(acme.waitForExistence(timeout: 10), app.debugDescription); acme.tap()
        XCTAssertTrue(file.waitForExistence(timeout: 15), app.debugDescription)
        try await pair(app, fixture: secondFixture, name: secondHome)
        app.tabBars.buttons["Клиенты"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["clientsState-empty"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertFalse(app.descendants(matching: .any)["clientDetail"].exists)
        XCTAssertFalse(file.exists)
        XCTAssertFalse(acme.exists)
        capture("clients-after-home-switch", app)

        // Switching back through the normal Home picker returns to the list, not an old detail.
        app.tabBars.buttons["Чат"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 15), app.debugDescription)
        app.buttons["Настройки"].tap()
        let primaryHome = app.descendants(matching: .any)["primaryHome"]
        XCTAssertTrue(primaryHome.waitForExistence(timeout: 10), app.debugDescription)
        primaryHome.tap()
        let firstHomeOption = app.buttons[firstHome]
        XCTAssertTrue(firstHomeOption.waitForExistence(timeout: 5), app.debugDescription); firstHomeOption.tap()
        app.buttons["Готово"].tap()
        app.tabBars.buttons["Клиенты"].tap()
        XCTAssertTrue(acme.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.buttons["refreshClients"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["clientDetail"].exists)
        capture("clients-after-home-return", app)
        try await assertNoSend(since: after)
        let secondAfter = try await read("/", from: secondFixture)
        XCTAssertEqual((secondAfter["turns"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(secondAfter["messageRequests"] as? Int, 0)
        XCTAssertEqual((secondAfter["sentMessages"] as? [[String: Any]])?.count, 0)
    }

    @MainActor private func pair(_ app: XCUIApplication, fixture: String, name: String) async throws {
        let invite = try await read("/invite", from: fixture)
        var url = try XCTUnwrap(URLComponents(string: XCTUnwrap(invite["url"] as? String)))
        url.queryItems = (url.queryItems ?? []).filter { $0.name != "name" } + [URLQueryItem(name: "name", value: name)]
        app.open(try XCTUnwrap(url.url))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
        confirm.tap(); app.finishDevicePairing()
    }

    @MainActor private func tapWhitespace(in row: XCUIElement, app: XCUIApplication) throws {
        let cell = app.cells.containing(.button, identifier: row.identifier).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 10), app.debugDescription)
        let point = CGPoint(x: cell.frame.maxX - 48, y: cell.frame.minY + cell.frame.height / 4)
        XCTAssertGreaterThan(point.x, row.frame.minX)
        XCTAssertFalse(cell.staticTexts.allElementsBoundByIndex.contains { $0.frame.contains(point) }, "The regression must tap whitespace, not a text label")
        cell.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: point.x - cell.frame.minX, dy: point.y - cell.frame.minY)).tap()
    }

    @MainActor private func assertClientDraft(_ name: String, in app: XCUIApplication) {
        let composer = app.textFields["Сообщение"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Черновик, который должен выжить")
        let chip = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "draftContext", "Клиент · " + name)).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["removeDraftContext"].exists)
    }

    @MainActor private func assertNoSend(since baseline: [String: Any]) async throws {
        let current = try await read("/")
        XCTAssertEqual((current["turns"] as? [[String: Any]])?.count, (baseline["turns"] as? [[String: Any]])?.count, "Navigation and Discuss must not run a turn")
        XCTAssertEqual(current["messageRequests"] as? Int, baseline["messageRequests"] as? Int, "Navigation and Discuss must not call Send")
        XCTAssertEqual((current["sentMessages"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, (baseline["sentMessages"] as? [[String: Any]])?.compactMap { $0["id"] as? String }, "Navigation must not enqueue a message")
    }

    @MainActor private func read(_ path: String, from fixture: String? = nil) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: (fixture ?? control) + path)))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
