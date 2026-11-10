import XCTest

/// Runs against tests/fixtures/one-chat.ts on a disposable simulator: one chat with one composer, readers behind it,
/// Insights, Progress and Statistics beside it, and no second composer anywhere.
final class OneChatUITests: XCTestCase {
    private var control = ""

    @MainActor
    func testOneChatAndItsReaders() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_ONE_CHAT_FIXTURE"] else { throw XCTSkip("Start the first isolated one-chat fixture and pass its control URL.") }
        let firstHome = "Первый тестовый Home"
        control = fixture
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        app.launch()
        try await pair(app, fixture: fixture, name: firstHome)
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }

        // 1. The chat is the first place: history already there, the composer ready, exactly four tabs and no Clients.
        let composer = app.textFields["Сообщение"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Три встречи и один акт на подпись."].waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertTrue(app.tabBars.buttons["Чат"].exists && app.tabBars.buttons["Инсайты"].exists && app.tabBars.buttons["Прогресс"].exists && app.tabBars.buttons["Статистика"].exists, app.debugDescription)
        XCTAssertEqual(app.tabBars.buttons.count, 4)
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

        // 3. A draft and the readers: the employee's News, its history, the group. None has a composer; the draft waits unchanged.
        composer.tap(); composer.typeText("Черновик, который должен выжить")
        app.buttons["openChats"].tap()
        let editorID = try XCTUnwrap(state["editor"] as? String)
        let feed = app.buttons["feed-" + editorID]
        XCTAssertTrue(feed.waitForExistence(timeout: 10), app.debugDescription)
        feed.tap()
        // One page for the day: no tabs, a status line, the edition.
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any)["newsStatus"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["newsMode-chat"].exists)
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
        // Back in the feed, the story the reader left to discuss is still open; the way back leads to the day.
        app.buttons["openChats"].tap()
        XCTAssertTrue(feed.waitForExistence(timeout: 10), app.debugDescription); feed.tap()
        XCTAssertTrue(discussStory.waitForExistence(timeout: 10), app.debugDescription)
        capture("reader-story-kept", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(discussStory.exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertEqual(app.textFields["Сообщение"].waitForExistence(timeout: 10) ? app.textFields["Сообщение"].value as? String : nil, "Черновик, который должен выжить")

        app.buttons["openChats"].tap()
        let employee = app.buttons["employee-" + editorID]
        XCTAssertTrue(employee.waitForExistence(timeout: 10)); employee.tap()
        XCTAssertTrue(app.descendants(matching: .any)["reader"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["readerTitle"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(app.buttons["readerTitle"].value as? String, "Редактор")
        // The employee's history keeps the conversation; its stories are read in the feed.
        XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Mistral")).firstMatch.exists)
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

        // Insights and Progress are readers; neither takes ownership of the main draft or sends a message.
        app.tabBars.buttons["Инсайты"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["insightsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        // The feed leads what there is to read, with its lead story.
        XCTAssertTrue(app.buttons["newsEntry-" + editorID].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue((app.buttons["newsEntry-" + editorID].label).contains("Mistral"), app.debugDescription)
        let activity = try XCTUnwrap(state["activity"] as? [String: Any])
        let insight = app.buttons["insight-" + (try XCTUnwrap(activity["id"] as? String))]
        XCTAssertTrue(insight.waitForExistence(timeout: 15), app.debugDescription); insight.tap()
        XCTAssertTrue(app.staticTexts["Проверены два материала. Решение по публикации остаётся за вами."].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        XCTAssertTrue(app.buttons["insightSource"].exists)
        app.buttons["discussInsight"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Черновик, который должен выжить")
        let insightChip = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND label == %@", "draftContext", "Из переписки · Утренний обзор")).firstMatch
        XCTAssertTrue(insightChip.waitForExistence(timeout: 10), app.debugDescription)
        try await assertNoSend(since: state)
        capture("insight-discuss-draft", app)
        app.buttons["removeDraftContext"].tap()
        app.tabBars.buttons["Прогресс"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["progressRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["openClients"].exists, "Clients left the app")
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        app.tabBars.buttons["Чат"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(composer.value as? String, "Черновик, который должен выжить")
        try await assertNoSend(since: state)

        // 4. The draft that survived every reader goes as one request; nothing else was sent on the way.
        composer.tap(); app.buttons["Отправить"].tap()
        XCTAssertTrue(app.staticTexts["Принято: Черновик, который должен выжить"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertEqual(composer.value as? String, emptyComposerValue, "Send must restore the initial empty composer")
        let after = try await read("/")
        XCTAssertEqual((after["turns"] as? [[String: Any]])?.count, 3)
        XCTAssertEqual(after["messageRequests"] as? Int, 3)
        capture("chat-draft-sent", app)

        // Owner setup uses the employee's actual device and existing project APIs. It never starts a turn.
        app.tabBars.buttons["Чат"].tap()
        app.buttons["openChats"].tap()
        XCTAssertTrue(employee.waitForExistence(timeout: 10), app.debugDescription); employee.tap()
        XCTAssertTrue(app.buttons["readerTitle"].waitForExistence(timeout: 10), app.debugDescription); app.buttons["readerTitle"].tap()
        let projectEntry = app.buttons["employeeProject"]
        for _ in 0..<5 { if projectEntry.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(projectEntry.waitForExistence(timeout: 10), app.debugDescription); projectEntry.tap()
        let addProject = app.buttons["addProject"]
        XCTAssertTrue(addProject.waitForExistence(timeout: 10), app.debugDescription); addProject.tap()
        let projectName = app.textFields["projectName"], projectPath = app.textFields["projectPath"]
        XCTAssertTrue(projectName.waitForExistence(timeout: 10), app.debugDescription)
        projectName.tap(); projectName.typeText("UI Source")
        projectPath.tap(); projectPath.typeText(try XCTUnwrap(state["projectPath"] as? String))
        app.buttons["hideProjectKeyboard"].tap()
        let register = app.buttons["registerEmployeeProject"]
        XCTAssertTrue(register.isEnabled, app.debugDescription); register.tap()
        XCTAssertTrue(app.staticTexts["projectSaved"].waitForExistence(timeout: 15), app.debugDescription)
        let projectState = try await read("/")
        let registry = try XCTUnwrap(projectState["projects"] as? [String: Any])
        let registered = try XCTUnwrap((registry["projects"] as? [[String: Any]])?.first)
        XCTAssertEqual(registered["path"] as? String, state["projectPath"] as? String)
        XCTAssertEqual(registered["name"] as? String, "UI Source")
        XCTAssertEqual((registry["bindings"] as? [String: String])?[editorID], registered["id"] as? String)
        try await assertNoSend(since: after)
        capture("employee-project-connected", app)

        // Accessibility text uses the same native hierarchy and source data, without another test harness.
        app.terminate()
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launch()
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        app.tabBars.buttons["Инсайты"].tap()
        XCTAssertTrue(insight.waitForExistence(timeout: 20), app.debugDescription); insight.tap()
        XCTAssertTrue(app.descendants(matching: .any)["insightDetail"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        capture("large-text-insight", app)
        app.tabBars.buttons["Прогресс"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["progressCharacter"].waitForExistence(timeout: 15), app.debugDescription)
        capture("large-text-progress", app)
        app.tabBars.buttons["Чат"].tap()
        app.buttons["openChats"].tap()
        XCTAssertTrue(employee.waitForExistence(timeout: 10), app.debugDescription); employee.tap()
        XCTAssertTrue(app.buttons["readerTitle"].waitForExistence(timeout: 10)); app.buttons["readerTitle"].tap()
        for _ in 0..<5 { if projectEntry.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(projectEntry.exists, app.debugDescription); projectEntry.tap()
        let projectChoice = app.descendants(matching: .any)["employeeProjectChoice"]
        for _ in 0..<3 { if projectChoice.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(projectChoice.waitForExistence(timeout: 10), app.debugDescription)
        capture("large-text-project", app)

        // A real paired colleague connection may read the chat, but must lose cached owner activity and project paths.
        _ = try await read("/owner?value=0")
        XCTAssertTrue(app.descendants(matching: .any)["projectSettingsError"].waitForExistence(timeout: 25), app.debugDescription)
        XCTAssertFalse(app.staticTexts[try XCTUnwrap(state["projectPath"] as? String)].exists)
        XCTAssertFalse(app.buttons["registerEmployeeProject"].exists)
        capture("project-owner-access-removed", app)
        // On the iPhone the sheet's Done sits on its first page.
        let back = app.navigationBars.buttons["Сотрудник"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), app.debugDescription); back.tap()
        XCTAssertTrue(app.buttons["saveEmployeeChanges"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["saveEmployeeChanges"].tap()
        app.tabBars.buttons["Инсайты"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["activityState-ownerOnly"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(insight.exists)
        XCTAssertFalse(app.buttons["discussInsight"].exists)
        capture("insights-owner-access-removed", app)
        let denied = try await read("/")
        let reads = try XCTUnwrap(denied["privateReads"] as? [[String: Any]])
        XCTAssertTrue(reads.contains { $0["path"] as? String == "/v1/activity" && $0["status"] as? Int == 403 })
        XCTAssertEqual((denied["projects"] as? [String: Any])?["revision"] as? Int, registry["revision"] as? Int)
        try await assertNoSend(since: after)
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
