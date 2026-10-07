import XCTest

final class iPhoneSmokeTests: XCTestCase {
    @MainActor
    func testPublicReviewServerWithRealCodex() async throws {
        continueAfterFailure = false
        let invitation: URL
        if let value = ProcessInfo.processInfo.environment["OPENSTRUDEL_REVIEW_INVITATION"],
           let url = URL(string: value) {
            // A short-lived invitation can be injected directly for a physical
            // device, without exposing a fixture server on the local network.
            invitation = url
        } else if let endpoint = ProcessInfo.processInfo.environment["OPENSTRUDEL_REVIEW_FIXTURE"],
                  let url = URL(string: endpoint) {
            let (data, response) = try await URLSession.shared.data(from: url)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            invitation = try XCTUnwrap(URL(string: XCTUnwrap(payload["url"] as? String)))
        } else {
            throw XCTSkip("Provide a private invitation or the local fixture endpoint for the isolated release server.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryL"]
        app.launch()
        app.open(invitation)
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15))
        confirm.tap()
        app.finishDevicePairing()
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 30))
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 30), app.debugDescription)
        let input = app.textFields["Сообщение"]
        XCTAssertTrue(input.waitForExistence(timeout: 10), app.debugDescription)
        let suffix = UUID().uuidString.prefix(6)
        let replies = ["Связь работает · \(suffix)", "Сообщение принято · \(suffix)", "История сохранена · \(suffix)"]
        for reply in replies {
            input.tap()
            input.typeText("Ответь ровно: \(reply)")
            app.buttons["Отправить"].tap()
            XCTAssertEqual(input.value as? String, "", "Composer must clear immediately after sending")
        }
        for reply in replies {
            XCTAssertTrue(app.staticTexts[reply].waitForExistence(timeout: 120), app.debugDescription)
        }
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)
        capture("release-server-three-real-replies", app)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertTrue(app.staticTexts[replies[2]].waitForExistence(timeout: 10), app.debugDescription)
        capture("release-server-relaunch", app)
    }

    @MainActor
    func testImageConversationOpensAtLatestMessage() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["Чаты"].tap()
        let editor = app.buttons["Редактор"]
        for _ in 0..<10 {
            if editor.exists && editor.isHittable { break }
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(editor.exists && editor.isHittable, app.debugDescription)
        editor.tap()
        XCTAssertTrue(app.buttons["Готово"].waitForNonExistence(timeout: 10), app.debugDescription)
        let image = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Открыть изображение:")).matching(NSPredicate(format: "label CONTAINS %@", "-strudel-photo.png")).firstMatch
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: image)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 15), .completed, app.debugDescription)
        capture("latest-image-after-open", app)
    }

    @MainActor
    func testEmployeeTelegramScreen() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["Чаты"].tap()
        let employee = app.buttons["Wai News"]
        XCTAssertTrue(employee.waitForExistence(timeout: 10), app.debugDescription)
        employee.tap()
        XCTAssertTrue(app.buttons["Готово"].waitForNonExistence(timeout: 10), app.debugDescription)
        let settings = app.buttons["Настройки сотрудника"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: settings)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed, app.debugDescription)
        settings.tap()
        XCTAssertTrue(app.textViews["Описание сотрудника"].waitForExistence(timeout: 10), app.debugDescription)
        let telegram = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Telegram")).firstMatch
        XCTAssertTrue(telegram.waitForExistence(timeout: 10), app.debugDescription)
        telegram.tap()
        XCTAssertTrue(app.staticTexts["Личный чат"].waitForExistence(timeout: 10), app.debugDescription)
        let explanation = app.staticTexts["В группе — отдельная переписка. Личная история туда не передаётся. Пока бот отвечает только тому, кто его подключил."]
        XCTAssertTrue(explanation.exists && explanation.isHittable, app.debugDescription)
        capture("telegram-employee-screen", app)
    }

    @MainActor
    func testEmployeeRowIsTappableAcrossItsWidth() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 30), app.debugDescription)
        app.buttons["Чаты"].tap()
        let employee = app.buttons["Джим Керри"]
        for _ in 0..<12 {
            if employee.exists && employee.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(employee.exists && employee.isHittable, app.debugDescription)
        capture("employee-row-before", app)
        // The center is blank space for a short name. It must still open the chat.
        employee.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.5)).tap()
        XCTAssertTrue(app.buttons["Готово"].waitForNonExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Джим Керри"].exists, app.debugDescription)
        capture("employee-row-opened", app)
    }

    @MainActor
    func testRealMacConnectionAndChats() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        addUIInterruptionMonitor(withDescription: "Local network") { alert in
            for label in ["Allow", "Разрешить", "OK", "ОК"] where alert.buttons[label].exists {
                alert.buttons[label].tap(); return true
            }
            return false
        }
        if let raw = ProcessInfo.processInfo.environment["OPENSTRUDEL_PAIRING_URL"], let url = URL(string: raw) {
            // Re-pairing must also recover from an expired or revoked connection.
            let previousConnectionError = app.alerts["OpenStrudel"].buttons["Понятно"]
            if previousConnectionError.waitForExistence(timeout: 2) { previousConnectionError.tap() }
            app.open(url)
            let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
            let openLink = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["Open", "Открыть"]))
            if openLink.firstMatch.waitForExistence(timeout: 2), springboard.alerts.debugDescription.contains("OpenStrudel") {
                openLink.firstMatch.tap()
            }
            let connect = app.buttons["confirmMacPairing"]
            XCTAssertTrue(connect.waitForExistence(timeout: 10), app.debugDescription)
            capture("01-pairing", app)
            connect.tap()
            // Dismiss the system's first local-network prompt if present.
            let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["Allow", "Разрешить", "OK", "ОК"]))
            if allow.firstMatch.waitForExistence(timeout: 3) { allow.firstMatch.tap() }
            app.finishDevicePairing()
            XCTAssertTrue(connect.waitForNonExistence(timeout: 25), app.debugDescription)
            XCTAssertFalse(app.alerts["OpenStrudel"].exists, app.debugDescription)
        }
        XCTAssertFalse(app.alerts["OpenStrudel"].exists, app.debugDescription)
        if app.buttons["acceptAIDataSharing"].waitForExistence(timeout: 5) { app.buttons["acceptAIDataSharing"].tap() }
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 30), app.debugDescription)
        capture("02-connected", app)
        app.buttons["Чаты"].tap()
        XCTAssertTrue(app.buttons["Wai News"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.buttons["Ouuuuu Baby Baby"].exists)
        capture("03-employees", app)
        app.buttons["Wai News"].tap()
        XCTAssertTrue(app.buttons["Настройки сотрудника"].waitForExistence(timeout: 10))
        capture("04-news-history", app)
        app.buttons["Настройки сотрудника"].tap()
        XCTAssertTrue(app.textViews["Описание сотрудника"].waitForExistence(timeout: 10))
        capture("05-bot-settings", app)
        app.buttons["Готово"].tap()
        app.buttons["Чаты"].tap()
        app.buttons["OpenStrudel"].tap()
        let input = app.textFields["Сообщение"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        let reply = "iPhone подключён: \(UUID().uuidString.prefix(8))."
        input.typeText("Ответь ровно: \(reply)")
        app.buttons["Отправить"].tap()
        XCTAssertTrue(app.staticTexts[reply].waitForExistence(timeout: 90), app.debugDescription)
        capture("06-real-codex-reply", app)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts[reply].waitForExistence(timeout: 10))
        capture("07-relaunch", app)
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
