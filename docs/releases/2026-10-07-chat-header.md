# Mac 1.0 (18): Telegram chat selection

An employee with a linked Telegram group could render its composited avatar at the source image size inside the Mac's native menu. The avatar now remains in the SwiftUI header, outside the menu label. The selected private or group conversation is a separate, visible menu below the employee's name.

Loading an older page now waits for the lazy transcript to update before restoring the previous first message. It also checks that the user has not switched conversations while the request was in flight.

Validation:

- macOS Release and iOS simulator builds passed. 103 native tests across 14 suites passed.
- The disposable character fixture supports `OPENSTRUDEL_GROUP_HISTORY_QA=1`: one synthetic group with 155 messages and no Telegram poller or real provider calls.
- Visual checks verified the bounded avatar, visible selected group, private/group switching, latest 50 messages, and a second 50-message page preserving message 106 at the top.
- This native release includes the same tested Home runtime as build 17. The iOS version and App Store submission are unchanged.

The previous release's runtime, paging, employee deletion and Telegram continuity checks are documented in `2026-10-07-history-and-telegram.md`. Private migration evidence and deployment receipts remain outside the repository's public release files.
