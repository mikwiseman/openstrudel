# Release 32: the entire employee row opens the chat

On Mac, clicking the blank part of an employee row previously focused its button without opening the chat. The plain button's label now fills the row and defines its own rectangular hit area. The main assistant uses the same component.

On iPhone and iPad, the employee and conversation lists now use the standard List button behavior. It includes the row's outer insets in its hit area. Labels retain their primary text color, fill the width and have a minimum 44-point height. No additional tap gestures or event handlers are used.

## Acceptance

- Reproduced the dead right-hand area in the installed Mac app. Computer Use confirmed that the patched app opens employees from the left and right edges, top and bottom padding, and the avatar/text gap. The main assistant also opens from its right edge. Right-clicking blank space still opens the employee context menu.
- Coordinate UI tests passed on iPhone 16e and iPad mini with iOS 26.5. Six points per row alternate between two employees and verify the resulting conversation header.
- The same test passed on iPhone 16e with maximum accessibility text and dark appearance, including rows reached by scrolling.
- Desktop web at 1280 × 720 and mobile web at 390 × 844 passed coordinate checks for avatars, padding and blank space. Their existing full-width HTML buttons already behave correctly; no web change is needed.
- All 127 native unit tests in 17 suites passed. The Release Mac app and iOS simulator app built successfully.

The UI fixture uses synthetic employees and a mock provider. No real messages are sent, and no user employees are created or deleted. Private logs and screenshots are under `.data/sidebar-row-hit-area/`.

To repeat the mobile check, run `node --import tsx tests/fixtures/agent-characters.ts /tmp/row-fixture.json`, read its controller URL, and set `TEST_RUNNER_OPENSTRUDEL_ROW_FIXTURE` to that URL when running `EmployeeRowHitAreaUITests` through `scripts/native-build.py`. The test uses loopback for the fixture's pinned TLS invitation. Set `TEST_RUNNER_OPENSTRUDEL_QA_CONTENT_SIZE=UICTContentSizeCategoryAccessibilityXXXL` for maximum text size.

## Delivery

Build 32 was published on 9 October 2026 from source commit `2852d9ac16b19005f958722a3f771c20e28329d9`.

- The signed Mac app and DMG passed notarization, stapling and Gatekeeper checks. Apple submission IDs: app `f6c18816-1872-4797-83b0-aa6ab327729b`, DMG `a03e09b5-d579-4e1e-9bb5-0081c4e290ec`.
- The public DMG, stable download alias, checksums and signed Sparkle feed were published with a timestamped rollback backup. Downloaded public artifacts matched their expected hashes. DMG SHA-256: `78365f2a219a1d9d569ecef7dd7e32a43f7706baa33b9ab61bb987c698762b7b`.
- An isolated copy of build 31 discovered build 32, downloaded it, installed it and relaunched through Sparkle. Its About dialog confirmed `1.0 (32)`.
- The Mac mini installation was backed up and atomically updated. Computer Use verified blank-space row clicks in the installed build and confirmed build 32 in About. The public update check reports it is current.
- All five existing employees and Telegram bindings were preserved. Home and Telegram remained healthy, and the Home process did not restart. The managed local rollback snapshot was marked healthy. This release does not change the Home runtime or its published archive.
- iOS build 32 passed App Store Connect processing and is available to the existing internal TestFlight group (`VALID`, `IN_BETA_TESTING`). Build ID: `c19cf728-605a-4595-b890-b1b52ea427df`. The existing public App Store submission remains in review.

Build archives, dSYM, notarization receipts, deployment receipts and update acceptance evidence are retained under `.data/sidebar-row-hit-area/shipping/`. The temporary test processes, simulators and public QA update feed were removed after validation.
