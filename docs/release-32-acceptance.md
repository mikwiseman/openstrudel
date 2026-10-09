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
