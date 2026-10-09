import XCTest

/// Run against tests/fixtures/agent-characters.ts on the simulator's host.
@MainActor final class EmployeeRowHitAreaUITests: XCTestCase {
    func testEmployeeOpensFromRowEdgesAndEmptySpace() async throws {
        guard let fixture = ProcessInfo.processInfo.environment["OPENSTRUDEL_ROW_FIXTURE"] else {
            throw XCTSkip("Requires the isolated employee-row fixture.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        if let size = ProcessInfo.processInfo.environment["OPENSTRUDEL_QA_CONTENT_SIZE"] {
            app.launchArguments = ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launch()
        let invitation = try await read(fixture + "/invite")
        var link = try XCTUnwrap(URLComponents(string: XCTUnwrap(invitation["url"] as? String)))
        // The fixture runs beside the simulator; avoid relying on mDNS.
        link.queryItems = link.queryItems?.map {
            $0.name == "host" ? URLQueryItem(name: "host", value: "127.0.0.1") : $0
        }
        app.open(try XCTUnwrap(link.url))
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); confirm.tap()
        app.finishDevicePairing()
        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 3) { consent.tap() }

        let state = try await read(fixture + "/state")
        let profiles = try XCTUnwrap(state["profiles"] as? [[String: Any]])
        let points = [CGVector(dx: 0.98, dy: 0.5), CGVector(dx: 0.02, dy: 0.5),
                      CGVector(dx: 0.5, dy: 0.04), CGVector(dx: 0.5, dy: 0.96),
                      CGVector(dx: 0.15, dy: 0.5), CGVector(dx: 0.75, dy: 0.5)]
        for (index, point) in points.enumerated() {
            let name = index.isMultiple(of: 2) ? "Редактор" : "Исследователь"
            let profile = try XCTUnwrap(profiles.first { $0["name"] as? String == name })
            let identifier = "employee-" + (try XCTUnwrap(profile["id"] as? String))
            let chats = app.buttons["Чаты"]
            XCTAssertTrue(chats.waitForExistence(timeout: 10)); chats.tap()
            let employee = app.buttons[identifier]
            let cell = app.cells.containing(.button, identifier: identifier).firstMatch
            let list = app.collectionViews.firstMatch
            // A partially visible cell can be hittable while its right edge is
            // below the screen. Bring the whole row into view before tapping.
            for _ in 0..<12 {
                if !cell.exists { list.swipeUp(); continue }
                let bottom = min(list.frame.maxY, app.frame.maxY - 34)
                let top = max(list.frame.minY, 120)
                if cell.frame.maxY > bottom { list.swipeUp() }
                else if cell.frame.minY < top { list.swipeDown() }
                else { break }
            }
            guard employee.isHittable else { XCTFail("Could not reveal \(name)"); return }
            if index == 0 {
                let row = XCTAttachment(screenshot: app.screenshot())
                row.name = "employee-row-hit-target"; row.lifetime = .keepAlways; add(row)
            }
            cell.coordinate(withNormalizedOffset: point).tap()
            let details = app.buttons["openEmployeeDetails"]
            guard details.waitForExistence(timeout: 5) else { XCTFail("Row did not open at \(point)"); return }
            XCTAssertEqual(details.value as? String, name)
        }
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "employee-row-opened-from-empty-space"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func read(_ url: String) async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(from: XCTUnwrap(URL(string: url)))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
