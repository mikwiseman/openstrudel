import XCTest

/// Gate hit regions and accessible names; save the full Apple audit for visual review.
/// Contrast and Dynamic Type also need screenshot checks: iOS audits include content
/// outside scroll viewports and capped system navigation/search controls.
final class DesignAccessibilityUITests: XCTestCase {
    @MainActor func testMainScreens() async throws {
        continueAfterFailure = false
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_DESIGN_FIXTURE"] else {
            throw XCTSkip("Requires a fresh isolated release-scenarios fixture.")
        }
        var issues: [String] = []
        let app = XCUIApplication()
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"] {
            app.launchArguments = ["-UIPreferredContentSizeCategoryName", size]
        }
        XCUIDevice.shared.orientation = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_LANDSCAPE"] == "1" ? .landscapeLeft : .portrait
        app.launch()
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: fixture + "/invite")))
        let invite = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        app.open(try XCTUnwrap(URL(string: XCTUnwrap(invite["url"] as? String))))
        let pair = app.buttons["confirmMacPairing"]
        XCTAssertTrue(pair.waitForExistence(timeout: 15)); pair.tap()
        app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { reveal(consent, app); audit("consent", app, &issues); consent.tap() }
        XCTAssertTrue(app.buttons["Чаты"].waitForExistence(timeout: 15))
        audit("conversation", app, &issues)
        app.buttons["Настройки"].tap()
        XCTAssertTrue(app.buttons["addDevice"].waitForExistence(timeout: 10))
        audit("settings", app, &issues)
        app.openFirstDeviceDetails()
        let connect = app.buttons["Получить ссылку подключения"].firstMatch
        reveal(connect, app)
        try assertFitsHorizontally(connect, in: app)
        audit("settings-bottom", app, &issues)
        connect.tap()
        XCTAssertTrue(app.buttons["closeMobileInvitation"].waitForExistence(timeout: 10))
        audit("invitation", app, &issues)
        app.buttons["closeMobileInvitation"].tap()
        app.buttons["Готово"].tap()
        app.buttons["Чаты"].tap()
        let editor = app.buttons["Редактор"]
        reveal(editor, app)
        audit("employee-list", app, &issues)
        let search = app.searchFields["Найти сотрудника"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("OpenStrudel")
        XCTAssertTrue(app.buttons["OpenStrudel"].waitForExistence(timeout: 5))
        XCTAssertFalse(editor.exists)
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "OpenStrudel".count) + "Несуществующий сотрудник")
        let clear = app.buttons["Очистить поиск"]
        XCTAssertTrue(clear.waitForExistence(timeout: 5)); clear.tap()
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        let settings = app.buttons["Настройки сотрудника"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10)); settings.tap()
        XCTAssertTrue(app.textFields["Имя сотрудника"].waitForExistence(timeout: 10))
        audit("employee-editor", app, &issues)
        let services = app.buttons["Сервисы и навыки"]
        reveal(services, app); services.tap()
        let addService = app.buttons["addEmployeeExtension"]
        XCTAssertTrue(addService.waitForExistence(timeout: 10))
        reveal(addService, app)
        audit("services", app, &issues)
        addService.tap()
        XCTAssertTrue(app.staticTexts["Документы"].waitForExistence(timeout: 10))
        let connectService = app.buttons["connect-service-qa-documents"]
        XCTAssertTrue(connectService.waitForExistence(timeout: 5))
        reveal(connectService, app)
        try assertFitsHorizontally(connectService, in: app)
        audit("service-catalog", app, &issues)
        let report = XCTAttachment(string: issues.isEmpty ? "No findings on the audited native screens." : issues.joined(separator: "\n\n"))
        report.name = "native-accessibility-findings"; report.lifetime = .keepAlways; add(report)
        if ProcessInfo.processInfo.environment["OPENSTRUDEL_AUDIT_REPORT_ONLY"] != "1" {
            XCTAssertTrue(issues.isEmpty, issues.joined(separator: "\n\n"))
        }
    }

    @MainActor private func audit(_ screen: String, _ app: XCUIApplication, _ issues: inout [String]) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "audit-" + screen; screenshot.lifetime = .keepAlways; add(screenshot)
        var findings: [String] = []
        do {
            let reportOnly = ProcessInfo.processInfo.environment["OPENSTRUDEL_AUDIT_REPORT_ONLY"] == "1"
            let types: XCUIAccessibilityAuditType = reportOnly ? .all : [.hitRegion, .sufficientElementDescription]
            try app.performAccessibilityAudit(for: types) { issue in
                let location = issue.element.map { "frame=\($0.frame), hittable=\($0.isHittable), type=\($0.elementType.rawValue)" } ?? "no element"
                findings.append(screen + ": " + issue.compactDescription + " — " + (issue.element?.label ?? "") + "\n" + location + "\n" + issue.detailedDescription)
                return true // Collect every finding, then fail once with the full report.
            }
        } catch { findings.append(screen + ": audit could not finish: " + error.localizedDescription) }
        issues.append(contentsOf: findings)
    }

    @MainActor private func reveal(_ element: XCUIElement, _ app: XCUIApplication) {
        for _ in 0..<12 where !element.isHittable {
            let view = app.scrollViews.allElementsBoundByIndex.last(where: \.isHittable) ?? app
            view.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
    }

    @MainActor private func assertFitsHorizontally(_ element: XCUIElement, in app: XCUIApplication) throws {
        let visible = app.windows.firstMatch.frame
        let frame = element.frame
        guard frame.minX >= visible.minX - 1, frame.maxX <= visible.maxX + 1 else {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "horizontal-overflow"; screenshot.lifetime = .keepAlways; add(screenshot)
            throw NSError(domain: "LayoutAcceptance", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "\(element.label) overflows the screen: \(frame) outside \(visible)"])
        }
    }
}
