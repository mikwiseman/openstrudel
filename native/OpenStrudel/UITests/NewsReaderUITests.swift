import XCTest

final class NewsReaderUITests: XCTestCase {
    /// An isolated Home with a News employee and its stories: edition, a story with sources, a question kept with it, back to the same place.
    @MainActor
    func testReadEditionStoryAndDiscussion() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let invitation = env["OPENSTRUDEL_DEVICE_INVITATION"], let profileID = env["OPENSTRUDEL_DEVICE_PROFILE"] else {
            throw XCTSkip("Requires the isolated News fixture.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "ru", "-AppleLanguages", "(ru)"]
        if let size = env["OPENSTRUDEL_TEXT_SIZE"] { app.launchArguments += ["-UIPreferredContentSizeCategoryName", size] }
        app.launch(); app.open(try XCTUnwrap(URL(string: invitation)))
        let confirm = app.buttons["confirmMacPairing"]
        if confirm.waitForExistence(timeout: 15) { confirm.tap(); app.finishDevicePairing() }
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 3) { consent.tap() }
        let chats = app.buttons["openChats"]
        XCTAssertTrue(chats.waitForExistence(timeout: 20), app.debugDescription); chats.tap()
        let employee = app.buttons["employee-" + profileID]
        for _ in 0..<10 where !employee.isHittable { app.swipeUp() }
        employee.tap()

        XCTAssertTrue(app.buttons["Утренний выпуск"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["30 октября."].exists || app.otherElements["30 октября."].exists || app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Amazon")).firstMatch.exists, app.debugDescription)
        capture("news-edition", app)

        let story = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Thrive Holdings")).firstMatch
        for _ in 0..<8 where !story.isHittable { app.swipeUp() }
        XCTAssertTrue(story.isHittable, app.debugDescription)
        let place = story.frame.minY
        capture("news-edition-scrolled", app)
        story.tap()

        let back = app.buttons["К выпуску"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), app.debugDescription)
        capture("news-story", app)
        app.buttons["Источники · 3"].tap()
        XCTAssertTrue(app.links.containing(NSPredicate(format: "label CONTAINS %@", "ADT")).firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        capture("news-story-sources", app)

        let field = app.textFields["Спросить News об этой истории"]
        for _ in 0..<6 where !field.isHittable { app.swipeUp() }
        field.tap(); field.typeText("Что это меняет для нас?")
        app.buttons["Отправить"].firstMatch.tap()
        let answer = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "проверено только то")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 30), app.debugDescription)
        capture("news-story-discussion", app)

        for _ in 0..<10 where !back.isHittable { app.swipeDown() }
        back.tap()
        XCTAssertTrue(story.waitForExistence(timeout: 5), app.debugDescription)
        // Back lands where the reader left the edition.
        XCTAssertTrue(story.isHittable, app.debugDescription)
        XCTAssertEqual(story.frame.minY, place, accuracy: 4, app.debugDescription)
        capture("news-edition-returned", app)

        app.buttons["Радар"].tap()
        XCTAssertTrue(app.staticTexts["Важное по мере появления"].waitForExistence(timeout: 5), app.debugDescription)
        capture("news-radar", app)
        app.buttons["Чат"].tap()
        XCTAssertTrue(app.staticTexts["Что это меняет для нас?"].waitForExistence(timeout: 5), app.debugDescription)
        capture("news-chat", app)
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
