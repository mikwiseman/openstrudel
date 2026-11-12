import XCTest

/// Runs against tests/fixtures/one-chat.ts on a disposable simulator: the home, one chat with one composer behind its
/// capsule, readers behind the chat, what waits and the recent results behind the home's lead, Progress a step from
/// Statistics, and no second composer anywhere.
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

        // 1. Home is the first place, without tabs; its capsule opens the chat: history already there, the composer
        // ready, nothing to send yet and no Clients.
        // Nothing waits on this Home, so the home leads with its calm sentence, which opens the recent results.
        let homeComposer = app.buttons["homeComposer"], calm = app.buttons["needsCalm"]
        XCTAssertTrue(homeComposer.waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertEqual(app.tabBars.count, 0)
        XCTAssertFalse(app.textFields["Сообщение"].exists, "The home's capsule opens the composer; it is not a second one")
        homeComposer.tap()
        let composer = app.textFields["Сообщение"]
        XCTAssertTrue(composer.waitForExistence(timeout: 30), app.debugDescription)
        // A fresh simulator explains its keyboard once.
        let tip = app.buttons["Continue"]
        if tip.waitForExistence(timeout: 3) { tip.tap() }
        XCTAssertTrue(app.staticTexts["Три встречи и один акт на подпись."].waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertFalse(app.buttons["newEmployee"].exists)
        XCTAssertFalse(app.buttons["sendMessage"].exists, "The fresh fixture must start with an empty composer, which has nothing to send")
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
        openHistory(app)
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
        openHistory(app)
        XCTAssertTrue(feed.waitForExistence(timeout: 10), app.debugDescription); feed.tap()
        XCTAssertTrue(discussStory.waitForExistence(timeout: 10), app.debugDescription)
        capture("reader-story-kept", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.scrollViews["newsToday"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(discussStory.exists)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertEqual(app.textFields["Сообщение"].waitForExistence(timeout: 10) ? app.textFields["Сообщение"].value as? String : nil, "Черновик, который должен выжить")

        openHistory(app)
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
        // The message's own menu, not the toolbar's button for the latest message.
        let discuss = app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Обсудить в чате", "discussLatest")).firstMatch
        XCTAssertTrue(discuss.waitForExistence(timeout: 5), app.debugDescription); discuss.tap()
        XCTAssertTrue(app.textFields["Сообщение"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.textFields["Сообщение"].value as? String, "Черновик, который должен выжить")
        XCTAssertTrue(app.buttons["removeDraftContext"].waitForExistence(timeout: 5))
        app.buttons["removeDraftContext"].tap()

        openHistory(app)
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

        // The results and Progress open from the home; neither takes ownership of the main draft or sends a message.
        back(app)
        XCTAssertTrue(calm.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(calm.label.contains("Ничего не ждёт вас") && calm.label.contains("Сегодня готово: 1"), calm.debugDescription)
        calm.tap()
        XCTAssertTrue(app.descendants(matching: .any)["insightsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        // A desk is read from the team list now; this page keeps to what waits and the results.
        XCTAssertFalse(app.buttons["newsEntry-" + editorID].exists)
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
        // The chat grew out of the result; the way back passes it and the page it came from.
        back(app); back(app); back(app)
        openProgress(app)
        XCTAssertTrue(app.descendants(matching: .any)["progressRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.buttons["openClients"].exists, "Clients left the app")
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        back(app); back(app)
        XCTAssertTrue(homeComposer.waitForExistence(timeout: 10), app.debugDescription); homeComposer.tap()
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
        openHistory(app)
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
        XCTAssertTrue(app.descendants(matching: .any)["homeRoot"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(calm.waitForExistence(timeout: 30), app.debugDescription); calm.tap()
        XCTAssertTrue(insight.waitForExistence(timeout: 20), app.debugDescription); insight.tap()
        XCTAssertTrue(app.descendants(matching: .any)["insightDetail"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.textFields["Сообщение"].exists)
        capture("large-text-insight", app)
        back(app); back(app)
        openProgress(app)
        XCTAssertTrue(app.descendants(matching: .any)["progressCharacter"].waitForExistence(timeout: 15), app.debugDescription)
        capture("large-text-progress", app)
        back(app); back(app)
        XCTAssertTrue(app.buttons["openChats"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["openChats"].tap()
        // At this size the desk's row with its latest headline fills the first screen of the list.
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        for _ in 0..<4 { if employee.exists && employee.isHittable { break }; app.swipeUp() }
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
        let toEmployee = app.navigationBars.buttons["Сотрудник"]
        XCTAssertTrue(toEmployee.waitForExistence(timeout: 5), app.debugDescription); toEmployee.tap()
        XCTAssertTrue(app.buttons["saveEmployeeChanges"].waitForExistence(timeout: 5), app.debugDescription)
        app.buttons["saveEmployeeChanges"].tap()
        // Back on the home, what only the owner may read leaves it: the calm sentence says nothing of the day's results
        // and opens nothing.
        back(app)
        XCTAssertTrue(app.descendants(matching: .any)["homeRoot"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(calm.waitForNonExistence(timeout: 20), app.debugDescription)
        let line = app.descendants(matching: .any)["needsCalmLine"]
        XCTAssertTrue(line.waitForExistence(timeout: 10) && !line.label.contains("Сегодня готово"), app.debugDescription)
        XCTAssertFalse(insight.exists)
        capture("home-owner-access-removed", app)
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

    /// The other conversations are behind the chat's "…" button.
    @MainActor private func openHistory(_ app: XCUIApplication) {
        let more = app.buttons["chatMore"]
        XCTAssertTrue(more.waitForExistence(timeout: 10), app.debugDescription); more.tap()
        let history = app.buttons["chatHistory"]
        XCTAssertTrue(history.waitForExistence(timeout: 5), app.debugDescription); history.tap()
    }

    @MainActor private func back(_ app: XCUIApplication) {
        let button = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(button.waitForExistence(timeout: 10), app.debugDescription)
        button.tap()
    }

    /// Progress is a step from Statistics, which opens from the foot of the home.
    @MainActor private func openProgress(_ app: XCUIApplication) {
        let statistics = app.buttons["homeStatistics"], progress = app.buttons["openProgress"], home = app.descendants(matching: .any)["homeRoot"]
        XCTAssertTrue(statistics.waitForExistence(timeout: 20), app.debugDescription)
        for _ in 0..<8 where !statistics.isHittable { home.swipeUp() }
        statistics.tap()
        XCTAssertTrue(app.descendants(matching: .any)["statisticsRoot"].waitForExistence(timeout: 10), app.debugDescription)
        for _ in 0..<8 where !progress.exists || !progress.isHittable { app.swipeUp() }
        XCTAssertTrue(progress.waitForExistence(timeout: 15), app.debugDescription); progress.tap()
    }

    /// A screenshot kept with the test, and beside the others when a folder is named for them.
    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let shot = XCTAttachment(screenshot: screenshot); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        guard let folder = ProcessInfo.processInfo.environment["OPENSTRUDEL_SHOTS"] else { return }
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("one-chat-" + name + ".png"))
    }
}
