import XCTest

/// Runs against tests/fixtures/news.ts on a disposable simulator. The desk's paper is one press from the home: its
/// front page, a story with its figures and chapters, a post for the owner's channel written on the Home, the drafts,
/// the week, the search and an earlier issue. Every company, product and story is invented.
final class NewspaperUITests: XCTestCase {
    private var control = ""
    private let environment = ProcessInfo.processInfo.environment

    @MainActor
    func testThePaperFromTheHomeToAPost() async throws {
        continueAfterFailure = false
        guard let fixture = environment["OPENSTRUDEL_NEWS_FIXTURE"] else { throw XCTSkip("Start tests/fixtures/news.ts and pass its control URL.") }
        control = fixture
        let app = launch()
        try await pair(app, "/invite")
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 8) { consent.tap() }
        let state = try await read("/")
        let lead = try XCTUnwrap(state["lead"] as? String)

        // 1. The paper is the first thing on the home: one tile with the day's lead, one press from today's news.
        let tile = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tile-desk:")).firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 40), app.debugDescription)
        XCTAssertTrue(tile.label.hasPrefix("News"), tile.label)
        try await expect(tile, says: lead)
        capture("01-home", app)
        tile.tap()

        // 2. The front page: the day, one line about the desk, three ways further, the lead.
        let front = app.scrollViews["newsToday"]
        XCTAssertTrue(front.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.descendants(matching: .any)["newsStatus"].waitForExistence(timeout: 10), app.debugDescription)
        for way in ["week", "posts", "search"] { XCTAssertTrue(app.buttons["newsWay-" + way].exists, way) }
        let leadTile = app.buttons["newsLead"]
        XCTAssertTrue(leadTile.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(leadTile.label.contains(lead), leadTile.label)
        // How tall the page's head and its first way further are: the numbers a larger text size must change.
        if let folder = environment["OPENSTRUDEL_SHOTS"], let handle = FileHandle(forWritingAtPath: folder + "/look.txt") {
            let head = app.descendants(matching: .any)["newsStatus"].frame, way = app.buttons["newsWay-week"].frame
            handle.seekToEndOfFile()
            handle.write(Data("mastheadHeight=\(Int(head.height)) wayHeight=\(Int(way.height)) wayWidth=\(Int(way.width))\n".utf8))
            try? handle.close()
        }
        capture("02-front", app)
        // The top stories, the day's analysis as an ink tile, the sections and the earlier issues, in that order.
        XCTAssertTrue(app.staticTexts["Главное"].waitForExistence(timeout: 5), app.debugDescription)
        let analysis = app.buttons["newsAnalysis-klen-3-laptop"]
        bring(analysis, into: front)
        capture("03-front-top-and-analysis", app)
        let issue = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "newsDay-")).firstMatch
        bring(issue, into: front)
        XCTAssertTrue(app.staticTexts["Выпуски"].exists, app.debugDescription)
        capture("04-front-sections-and-issues", app)

        // 3. An earlier issue is a paper of its own. Its lead has no picture, and is set in words: the headline alone
        // in one issue, the figure its story stands on in the next.
        issue.tap()
        XCTAssertTrue(app.scrollViews["newsDay"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(leadTile.waitForExistence(timeout: 10), app.debugDescription)
        capture("05-issue", app)
        back(app)
        XCTAssertTrue(front.waitForExistence(timeout: 10), app.debugDescription)
        let second = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "newsDay-")).element(boundBy: 1)
        XCTAssertTrue(second.waitForExistence(timeout: 5) && second.isHittable, app.debugDescription)
        second.tap()
        XCTAssertTrue(app.scrollViews["newsDay"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(leadTile.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(leadTile.label.contains("≈ $700"), leadTile.label)
        capture("05-issue-figure", app)
        back(app)
        XCTAssertTrue(front.waitForExistence(timeout: 10), app.debugDescription)
        for _ in 0..<6 where !leadTile.isHittable { front.swipeDown() }

        // 4. The story: its picture, its figures, what it says, and two ways on.
        leadTile.tap()
        let story = app.scrollViews["newsStory"]
        XCTAssertTrue(story.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.images["newsPicture"].waitForExistence(timeout: 15), app.debugDescription)
        capture("06-story", app)
        let numbers = app.descendants(matching: .any)["storyNumbers"]
        bring(numbers, into: story)
        story.swipeUp(velocity: .slow)
        capture("07-story-figures", app)
        let topic = app.buttons["storyTopic-Клён"]
        bring(topic, into: story)
        capture("08-story-evidence-and-chapters", app)
        XCTAssertTrue(app.buttons["discussStory"].exists && app.buttons["makePost"].exists, app.debugDescription)

        // 5. A post: the desk writes it on the Home, the owner edits it, asks for a change, takes a LinkedIn version and copies it.
        _ = try await read("/post?delay=5000")
        let writing = app.descendants(matching: .any)["postWriting"]
        // A system notice over the app can take a press with it; the button is found and pressed again.
        for _ in 0..<3 where !writing.exists { app.buttons["makePost"].firstMatch.tap(); _ = writing.waitForExistence(timeout: 5) }
        XCTAssertTrue(writing.exists, app.debugDescription)
        capture("09-post-writing", app)
        let text = app.textViews["postText"]
        XCTAssertTrue(text.waitForExistence(timeout: 30), app.debugDescription)
        // The draft reads the way the post will look: its title and its link carry no marks.
        let shown = text.value as? String ?? ""
        XCTAssertTrue(shown.contains("Клён 3") && shown.contains("Запись в блоге"), shown)
        XCTAssertFalse(shown.contains("**") || shown.contains("](") || shown.contains("https://"), shown)
        XCTAssertTrue(app.descendants(matching: .any)["postNote"].exists, "what the channel already said stands under the draft")
        capture("10-post", app)
        _ = try await read("/post?delay=1500")
        let instruction = app.textFields["postInstruction"]
        bring(instruction, into: app.scrollViews.firstMatch)
        // At a large text size the draft is taller than the screen: the field must come clear of the bar of actions to be typed into.
        let bar = app.buttons["postCopy"]
        for _ in 0..<8 where instruction.frame.maxY > bar.frame.minY - 8 { app.scrollViews.firstMatch.swipeUp(velocity: .slow) }
        XCTAssertLessThan(instruction.frame.maxY, bar.frame.minY, "«Что изменить?» stays under the bar of actions: field \(instruction.frame), bar \(bar.frame)")
        instruction.tap(); instruction.typeText("Короче")
        app.buttons["postRevise"].tap()
        let shorter = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Коротко"), object: text)
        let revised = await XCTWaiter().fulfillment(of: [shorter], timeout: 30)
        XCTAssertEqual(revised, .completed, text.value as? String ?? "")
        capture("11-post-revised", app)
        // The owner types into the draft. What the Home then keeps is still Markdown: the title bold, the link a link.
        // A press under the last line puts the cursor at the end of the draft. At a large text size that line is under
        // the bar of actions, so the draft is scrolled clear of it first.
        for _ in 0..<8 where text.frame.maxY > bar.frame.minY - 8 { app.scrollViews.firstMatch.swipeUp(velocity: .slow) }
        text.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.96)).tap(); text.typeText("ПРАВКА")
        let channels = app.buttons["LinkedIn"].firstMatch
        for _ in 0..<4 where !channels.isHittable { app.scrollViews.firstMatch.swipeDown() }
        channels.tap()
        var kept = ""
        for _ in 0..<20 {
            let saved = (try await read("/")["posts"] as? [[String: Any]] ?? []).first { $0["channel"] as? String == "telegram" }
            kept = saved?["text"] as? String ?? ""
            if kept.contains("ПРАВКА") { break }
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTAssertTrue(kept.contains("ПРАВКА"), kept)
        XCTAssertTrue(kept.hasPrefix("**«Клён 3» открыт, и младшая версия важнее старшей**"), kept)
        XCTAssertTrue(kept.contains("](https://severnymost.example/klen-3)"), kept)
        let linkedIn = app.buttons["postLinkedIn"]
        XCTAssertTrue(linkedIn.waitForExistence(timeout: 10), app.debugDescription)
        linkedIn.tap()
        let professional = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "Открытые модели"), object: text)
        let written = await XCTWaiter().fulfillment(of: [professional], timeout: 30)
        XCTAssertEqual(written, .completed, app.debugDescription)
        capture("12-post-linkedin", app)
        // «Скопировано» shows for a moment only, so it is not what is checked: the copied draft says so in «Посты» below.
        app.buttons["postCopy"].tap()
        app.buttons["postDone"].tap()
        XCTAssertTrue(story.waitForExistence(timeout: 10), app.debugDescription)
        back(app)

        // 6. The drafts stay on the Home: both are in «Посты», and one opens again as it was left.
        XCTAssertTrue(front.waitForExistence(timeout: 10), app.debugDescription)
        let posts = app.buttons["newsWay-posts"]
        for _ in 0..<6 where !posts.isHittable { front.swipeDown() }
        try await expectLabel(posts, says: "2")
        posts.tap()
        XCTAssertTrue(app.scrollViews["newsPosts"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "post-")).count, 2, app.debugDescription)
        // The LinkedIn draft was copied: the Home keeps that, and its row says so for as long as the draft lives.
        let used = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@ AND label CONTAINS %@", "post-", "LinkedIn", "взят в работу")).firstMatch
        XCTAssertTrue(used.waitForExistence(timeout: 15), app.debugDescription)
        capture("13-posts", app)
        back(app)

        // 7. The week: what moved, whom it was about, and everything about one name.
        app.buttons["newsWay-week"].tap()
        let week = app.scrollViews["newsWeek"]
        XCTAssertTrue(week.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Что движется"].waitForExistence(timeout: 5), app.debugDescription)
        capture("14-week", app)
        let name = app.buttons["weekTopic-клён"]
        bring(name, into: week)
        capture("15-week-names", app)
        name.tap()
        XCTAssertTrue(app.scrollViews["newsTopic"].waitForExistence(timeout: 10), app.debugDescription)
        capture("16-topic", app)
        back(app); back(app)

        // 8. The search finds a story by a word.
        XCTAssertTrue(front.waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["newsWay-search"].tap()
        let field = app.textFields["newsSearchField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
        field.typeText("Гранит")
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "назвал цену ускорителя")).firstMatch.waitForExistence(timeout: 10), app.debugDescription)
        capture("17-search", app)
    }

    /// A walk of whatever desk a Home serves, for looking at real stories and drafts: it only opens the pages and keeps
    /// their screenshots. The one thing it checks is that a draft shows no Markdown marks. Pass the control URL of a
    /// Home that answers `/invite`; nothing about its stories is written here.
    @MainActor
    func testAWalkOfAnyDesk() async throws {
        continueAfterFailure = false
        guard let home = environment["OPENSTRUDEL_NEWS_WALK"] else { throw XCTSkip("Pass the control URL of a Home whose desk to walk.") }
        control = home
        let app = launch()
        try await pair(app, "/invite")
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 8) { consent.tap() }
        let tile = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "tile-desk:")).firstMatch
        XCTAssertTrue(tile.waitForExistence(timeout: 40), app.debugDescription)
        capture("01-home", app)
        tile.tap()
        let front = app.scrollViews["newsToday"]
        XCTAssertTrue(front.waitForExistence(timeout: 15), app.debugDescription)
        let leadTile = app.buttons["newsLead"]
        XCTAssertTrue(leadTile.waitForExistence(timeout: 10), app.debugDescription)
        // A picture named by the lead has a moment to arrive.
        try await Task.sleep(for: .seconds(4))
        capture("02-front", app)
        for index in 3...6 { front.swipeUp(velocity: .slow); capture(String(format: "%02d-front", index), app) }
        for _ in 0..<12 where !leadTile.isHittable { front.swipeDown() }
        leadTile.tap()
        let story = app.scrollViews["newsStory"]
        XCTAssertTrue(story.waitForExistence(timeout: 10), app.debugDescription)
        capture("07-story", app)
        story.swipeUp(velocity: .slow); capture("08-story", app)
        story.swipeUp(velocity: .slow); capture("09-story", app)
        back(app)
        XCTAssertTrue(front.waitForExistence(timeout: 10), app.debugDescription)
        let posts = app.buttons["newsWay-posts"]
        for _ in 0..<6 where !posts.isHittable { front.swipeDown() }
        posts.tap()
        XCTAssertTrue(app.scrollViews["newsPosts"].waitForExistence(timeout: 10), app.debugDescription)
        capture("10-posts", app)
        let draft = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "post-")).firstMatch
        if draft.waitForExistence(timeout: 5) {
            draft.tap()
            let text = app.textViews["postText"]
            XCTAssertTrue(text.waitForExistence(timeout: 30), app.debugDescription)
            let shown = text.value as? String ?? ""
            XCTAssertFalse(shown.contains("**") || shown.contains("]("), "a draft shows its Markdown marks")
            capture("11-post", app)
            app.scrollViews.firstMatch.swipeUp(velocity: .slow); capture("12-post", app)
            app.buttons["postDone"].tap()
        }
        back(app)
        XCTAssertTrue(front.waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["newsWay-week"].tap()
        let week = app.scrollViews["newsWeek"]
        XCTAssertTrue(week.waitForExistence(timeout: 10), app.debugDescription)
        capture("13-week", app)
        week.swipeUp(velocity: .slow); capture("14-week", app)
        back(app)
        XCTAssertTrue(front.waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["newsWay-search"].tap()
        let field = app.textFields["newsSearchField"]
        XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
        field.typeText(environment["OPENSTRUDEL_NEWS_WALK_WORD"] ?? "AI")
        try await Task.sleep(for: .seconds(2))
        capture("15-search", app)
    }

    // MARK: Helpers

    @MainActor private func launch() -> XCUIApplication {
        XCUIDevice.shared.appearance = environment["OPENSTRUDEL_APPEARANCE"] == "dark" ? .dark : .light
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = environment["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        // What this run was asked to look like, kept beside its screenshots: a folder named dark must have been run dark.
        if let folder = environment["OPENSTRUDEL_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
            let asked = "appearance=\(environment["OPENSTRUDEL_APPEARANCE"] ?? "unset") textSize=\(environment["OPENSTRUDEL_TEXT_SIZE"] ?? "unset") device=\(XCUIDevice.shared.appearance == .dark ? "dark" : "light") arguments=\(app.launchArguments.joined(separator: " "))\n"
            try? asked.write(toFile: folder + "/look.txt", atomically: true, encoding: .utf8)
        }
        app.launch()
        return app
    }

    /// Scrolls a page until the element can be pressed.
    @MainActor private func bring(_ element: XCUIElement, into page: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        for _ in 0..<14 where !(element.exists && element.isHittable) { page.swipeUp(velocity: .slow) }
        XCTAssertTrue(element.exists && element.isHittable, app(page).debugDescription, file: file, line: line)
    }
    @MainActor private func app(_ element: XCUIElement) -> XCUIApplication { XCUIApplication() }

    @MainActor private func back(_ app: XCUIApplication) {
        let button = app.navigationBars.buttons.element(boundBy: 0)
        XCTAssertTrue(button.waitForExistence(timeout: 10), app.debugDescription)
        button.tap()
    }

    @MainActor private func expect(_ element: XCUIElement, says text: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let said = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", text), object: element)
        let result = await XCTWaiter().fulfillment(of: [said], timeout: 20)
        XCTAssertEqual(result, .completed, "\(element.label): \(element.value as? String ?? "")", file: file, line: line)
    }

    @MainActor private func expectLabel(_ element: XCUIElement, says text: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let said = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", text), object: element)
        let result = await XCTWaiter().fulfillment(of: [said], timeout: 15)
        XCTAssertEqual(result, .completed, element.label, file: file, line: line)
    }

    @MainActor private func pair(_ app: XCUIApplication, _ path: String) async throws {
        let invite = try await read(path)
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
        confirm.tap(); app.finishDevicePairing()
    }

    @MainActor private func read(_ path: String) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(from: try XCTUnwrap(URL(string: control + path)))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// A screenshot kept with the test, and beside the others when a folder is named for them.
    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let shot = XCTAttachment(screenshot: screenshot); shot.name = name; shot.lifetime = .keepAlways; add(shot)
        guard let folder = environment["OPENSTRUDEL_SHOTS"] else { return }
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent(name + (environment["OPENSTRUDEL_SHOT_SUFFIX"] ?? "") + ".png"))
    }
}
