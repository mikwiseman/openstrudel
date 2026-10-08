import XCTest

/// Runs against the isolated real-Codex fixture, never the user's Home.
final class ExtensionsUITests: XCTestCase {
    @MainActor func testMCPInstallReturnsAndSurvivesReopen() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_EXTENSIONS_FIXTURE"],
              let mcp = ProcessInfo.processInfo.environment["OPENSTRUDEL_EXTENSIONS_MCP"] else {
            throw XCTSkip("Start tests/fixtures/extensions.ts.")
        }
        let app = XCUIApplication()
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"] {
            app.launchArguments = ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: fixture + "/invite")))
        let invite = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String:Any])
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        XCTAssertTrue(app.buttons["confirmMacPairing"].waitForExistence(timeout: 15))
        app.buttons["confirmMacPairing"].tap(); app.finishDevicePairing()
        if app.buttons["acceptAIDataSharing"].waitForExistence(timeout: 5) { app.buttons["acceptAIDataSharing"].tap() }
        if app.buttons["Чаты"].waitForExistence(timeout: 10) { app.buttons["Чаты"].tap() }
        XCTAssertTrue(app.buttons["Редактор теста"].waitForExistence(timeout: 15))
        app.buttons["Редактор теста"].tap()
        try openServices(app)
        XCTAssertTrue(app.buttons["addEmployeeExtension"].waitForExistence(timeout: 15))
        app.buttons["addEmployeeExtension"].tap()
        XCTAssertTrue(app.buttons["addMCPService"].waitForExistence(timeout: 10))
        app.buttons["addMCPService"].tap()
        let address = app.textFields["mcpAddress"]
        guard address.waitForExistence(timeout: 10) else {
            XCTFail(app.debugDescription)
            throw NSError(domain: "ExtensionsUI", code: 1)
        }
        address.tap(); address.typeText("http://public.example/mcp")
        hideKeyboard(app)
        try reveal(app.buttons["Добавить сервис"], in: app)
        app.buttons["Добавить сервис"].tap()
        let failure = app.staticTexts.matching(NSPredicate(format:"label CONTAINS[c] %@", "https")).firstMatch
        try reveal(failure, in: app)
        try reveal(address, in: app, upwards: false)
        address.tap()
        let old = address.value as? String ?? ""
        address.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + mcp)
        hideKeyboard(app)
        try reveal(app.buttons["Добавить сервис"], in: app)
        app.buttons["Добавить сервис"].tap()
        XCTAssertTrue(app.buttons["addEmployeeExtension"].waitForExistence(timeout: 30), app.debugDescription)
        try reveal(app.staticTexts["Подключён"].firstMatch, in: app)
        capture("mcp-installed",app)
        // This return path used to recurse in SwiftUI and crash on macOS.
        app.navigationBars.buttons["Сотрудник"].tap()
        try reveal(app.buttons["Сервисы и навыки"], in: app)
        app.buttons["Сервисы и навыки"].tap()
        try reveal(app.staticTexts["Подключён"].firstMatch, in: app)
        capture("mcp-reopened",app)
    }

    @MainActor private func hideKeyboard(_ app: XCUIApplication) {
        let hide = app.buttons["Скрыть клавиатуру"]
        if hide.exists && hide.isHittable { hide.tap() }
    }
    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication, upwards: Bool = true) throws {
        for _ in 0..<8 {
            if element.exists && element.isHittable { return }
            let form = app.collectionViews.firstMatch
            if upwards { form.swipeUp() } else { form.swipeDown() }
        }
        guard element.exists && element.isHittable else {
            XCTFail("Control is unreachable after scrolling: \(element)\n\(app.debugDescription)")
            throw NSError(domain: "ExtensionsUI", code: 2)
        }
    }

    @MainActor private func openServices(_ app: XCUIApplication) throws {
        XCTAssertTrue(app.buttons["Настройки сотрудника"].waitForExistence(timeout: 10))
        app.buttons["Настройки сотрудника"].tap()
        let button=app.buttons["Сервисы и навыки"]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
    }
    @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
        let shot=XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name="extensions-"+name;shot.lifetime = .keepAlways;add(shot)
    }
}
