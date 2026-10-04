import XCTest

final class LiveCloudPairingUITests: XCTestCase {
    @MainActor
    func testSavedConnectionLoadsAfterServerReboot() throws {
        guard ProcessInfo.processInfo.environment["OPENSTRUDEL_LIVE_CLOUD_RECONNECT"] == "1" else {
            throw XCTSkip("Opt in after rebooting the isolated Home paired by the live invitation test.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["signInOpenAI"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["setupCloud"].exists)
        XCTAssertFalse(app.buttons["confirmMacPairing"].exists)
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)
        let restored = XCTAttachment(screenshot: app.screenshot())
        restored.name = "live-cloud-after-server-reboot"
        restored.lifetime = .keepAlways
        add(restored)
    }

    @MainActor
    func testFreshCloudInvitationPersistsAfterRelaunch() throws {
        guard let value = ProcessInfo.processInfo.environment["OPENSTRUDEL_LIVE_CLOUD_INVITATION"],
              let invitation = URL(string: value) else {
            throw XCTSkip("Provide a fresh invitation from an isolated live Home without an OpenAI account.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        app.open(invitation)
        let confirm = app.buttons["confirmMacPairing"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15))
        confirm.tap()
        XCTAssertTrue(confirm.waitForNonExistence(timeout: 30))
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)

        let consent = app.buttons["acceptAIDataSharing"]
        if consent.waitForExistence(timeout: 5) { consent.tap() }
        // This fresh Home is deliberately empty. Reaching its account setup
        // proves that native pairing and the authenticated account read worked.
        XCTAssertTrue(app.buttons["signInOpenAI"].waitForExistence(timeout: 20))
        let connected = XCTAttachment(screenshot: app.screenshot())
        connected.name = "live-cloud-paired"
        connected.lifetime = .keepAlways
        add(connected)

        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["signInOpenAI"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["setupCloud"].exists)
        XCTAssertFalse(app.alerts["OpenStrudel"].exists)
        let restored = XCTAttachment(screenshot: app.screenshot())
        restored.name = "live-cloud-connection-restored"
        restored.lifetime = .keepAlways
        add(restored)
    }
}
