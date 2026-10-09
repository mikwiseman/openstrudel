import XCTest

/// Paired clients of two independent runtimes, neither with owner permissions.
@MainActor final class RemoteEmployeeCreationUITests: XCTestCase {
    @MainActor func testCreateOnEitherConnectedDeviceAndKeepDraftWhenSwitching() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_CREATION_FIXTURE"] else { throw XCTSkip("Start the remote-employee-creation fixture.") }
        let app = XCUIApplication()
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"] {
            app.launchArguments = ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()
        for host in ["laptop", "mini"] {
            let invite = try await read(fixture + "/invite?host=" + host)
            app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
            let confirm = app.buttons["confirmMacPairing"]
            XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap(); app.finishDevicePairing()
            let consent = app.buttons["acceptAIDataSharing"]
            if consent.waitForExistence(timeout: 3) { consent.tap() }
        }
        let chats = app.buttons["Чаты"]
        XCTAssertTrue(chats.waitForExistence(timeout: 15)); chats.tap()
        app.buttons["newEmployee"].tap()
        capture("choose-creation-device", app)
        app.buttons["Mac mini · Проверка"].firstMatch.tap()
        let destination = app.buttons["employeeCreationDevice"]
        XCTAssertTrue(destination.waitForExistence(timeout: 10))
        XCTAssertEqual(destination.value as? String, "Mac mini · Проверка")
        let composer = app.textFields["messageComposer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10)); composer.tap()
        composer.typeText("Редактор: пиши понятно.")
        // No submission yet. Switching destinations must carry the same prompt.
        destination.tap(); app.buttons["MacBook · Проверка"].firstMatch.tap()
        XCTAssertTrue(destination.waitForExistence(timeout: 10))
        XCTAssertEqual(destination.value as? String, "MacBook · Проверка")
        XCTAssertEqual(composer.value as? String, "Редактор: пиши понятно.")
        destination.tap(); app.buttons["Mac mini · Проверка"].firstMatch.tap()
        XCTAssertEqual(composer.value as? String, "Редактор: пиши понятно.")
        capture("draft-on-remote-device", app)
        app.buttons["Отправить"].tap()
        try await expectEmployees(fixture, counts: [0, 1])
        let reply = app.staticTexts["Готов помогать на «Mac mini · Проверка»."].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 20), app.debugDescription)
        let state = try await read(fixture + "/state")
        let hosts = try XCTUnwrap(state["hosts"] as? [[String: Any]])
        let profile = try XCTUnwrap((hosts[1]["profiles"] as? [[String: Any]])?.first)
        let id = try XCTUnwrap(profile["id"] as? String)
        app.terminate(); app.launch()
        XCTAssertTrue(chats.waitForExistence(timeout: 15)); chats.tap()
        let employee = app.buttons["employee-" + id]
        // Large Dynamic Type can put the second device below the fold.
        if !employee.waitForExistence(timeout: 3) {
            for _ in 0..<5 where !employee.exists { app.collectionViews.firstMatch.swipeUp() }
        }
        XCTAssertTrue(employee.exists, app.debugDescription)
        app.buttons["newEmployee"].tap(); app.buttons["MacBook · Проверка"].firstMatch.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 10)); composer.tap(); composer.typeText("Планировщик: помогай с делами.")
        app.buttons["Отправить"].tap()
        try await expectEmployees(fixture, counts: [1, 1])
        XCTAssertTrue(app.staticTexts["Готов помогать на «MacBook · Проверка»."].firstMatch.waitForExistence(timeout: 20))
        _ = try await read(fixture + "/offline?host=mini&value=1")
        // Catalogue refresh is conditional and bounded to five seconds.
        chats.tap(); app.buttons["newEmployee"].tap()
        let offline = app.buttons["Mac mini · Проверка · недоступно"]
        XCTAssertTrue(offline.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertFalse(offline.isEnabled)
        capture("offline-destination-disabled", app)
        _ = try await read(fixture + "/offline?host=mini&value=0")
    }

    private func read(_ url: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: url)))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func expectEmployees(_ fixture: String, counts: [Int]) async throws {
        for _ in 0..<40 {
            let state = try await read(fixture + "/state")
            let hosts = try XCTUnwrap(state["hosts"] as? [[String: Any]])
            if hosts.map({ ($0["profiles"] as? [Any])?.count ?? -1 }) == counts { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTFail("Creation did not reach exactly the chosen host")
    }

    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
}
