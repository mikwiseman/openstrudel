import XCTest

@MainActor final class AppleReviewUITests: XCTestCase {
    func testPrivateReviewPageConnectsAndAnswers() async throws {
        try await connectAndAnswer(pastingPage: false)
    }

    func testPastedConnectionPageConnectsAndAnswers() async throws {
        try await connectAndAnswer(pastingPage: true)
    }

    private func connectAndAnswer(pastingPage: Bool) async throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        let page: URL
        if let privatePage = environment["OPENSTRUDEL_REVIEW_PAGE"] {
            // A physical device cannot reach the Mac's loopback fixture.
            page = try XCTUnwrap(URL(string: privatePage))
        } else {
            guard let fixture = environment["OPENSTRUDEL_REVIEW_PAGE_FIXTURE"],
                  let endpoint = URL(string: fixture) else { throw XCTSkip("Provide the private review page fixture.") }
            let (data, response) = try await URLSession.shared.data(from: endpoint)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            page = try XCTUnwrap(URL(string: XCTUnwrap(payload["url"] as? String)))
        }
        let app = XCUIApplication()
        app.launchArguments = ["-openstrudel.language", "en", "-AppleLanguages", "(en)"]
        app.launch()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        // Start from a new document, as a reviewer opening the link for the first time.
        // Safari otherwise reuses an old tab, even across test-runner relaunches.
        safari.open(try XCTUnwrap(URL(string: "about:blank")))
        if pastingPage {
            app.activate()
            let paste = app.buttons["pasteInvitation"]
            XCTAssertTrue(paste.waitForExistence(timeout: 15), app.debugDescription)
            paste.tap()
            let input = app.secureTextFields["connectionInvitation"]
            XCTAssertTrue(input.waitForExistence(timeout: 5))
            input.tap(); input.typeText(page.absoluteString)
            let openPage = app.buttons["continueConnection"]
            XCTAssertEqual(openPage.label, "Open page")
            capture("review-pasted-page-ready", app)
            openPage.tap()
        } else {
            safari.open(page)
        }
        let open = safari.links.matching(NSPredicate(format: "label IN %@", ["Open OpenStrudel", "Открыть OpenStrudel"])).firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 30), safari.debugDescription)
        // A clean iOS 26 simulator shows Safari's toolbar tutorial. Its overlay
        // consumes the first page tap, even when the link itself is visible.
        if safari.staticTexts["View Bookmarks, Share Menu, and Open Tabs"].exists {
            let closeTip = safari.buttons.matching(NSPredicate(format: "label IN %@", ["Close", "Закрыть"])).firstMatch
            XCTAssertTrue(closeTip.exists, safari.debugDescription)
            closeTip.tap()
        }
        capture("review-private-connection-page", safari)
        open.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let confirmation = safari.buttons.matching(NSPredicate(format: "label IN %@", ["Open", "Открыть"])).firstMatch
        if confirmation.waitForExistence(timeout: 5) { confirmation.tap() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let systemOpen = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["Open", "Открыть"])).firstMatch
        if systemOpen.waitForExistence(timeout: 2) { systemOpen.tap() }
        let connect = app.buttons["confirmMacPairing"]
        XCTAssertTrue(connect.waitForExistence(timeout: 20), app.debugDescription + safari.debugDescription)
        connect.tap()
        app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        app.openChat()
        let input = app.textFields["messageComposer"]
        XCTAssertTrue(input.waitForExistence(timeout: 30), app.debugDescription)
        let expected = "Review ready " + UUID().uuidString.prefix(6)
        input.tap()
        input.typeText("Reply exactly: " + expected)
        // The send button appears with the first words.
        let send = app.buttons["sendMessage"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true AND hittable == true"), object: send)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed, app.debugDescription)
        capture("review-composer-ready", app)
        send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.staticTexts["Reply exactly: " + expected].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts[expected].waitForExistence(timeout: 120), app.debugDescription)
        capture("review-page-real-reply", app)
        app.terminate(); app.launch()
        app.openChat()
        XCTAssertTrue(app.staticTexts[expected].waitForExistence(timeout: 20), app.debugDescription)
        capture("review-page-relaunch", app)
    }

    private func capture(_ name: String, _ app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
