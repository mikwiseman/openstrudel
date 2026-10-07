# Mac 1.0 (17): history, menu bar and Telegram continuity

The menu-bar window now follows the selected device and sizes itself to its contents. Opening a long chat reads its latest 50 messages; older pages load on request without moving the reader away from their place. New replies and pending-message updates are merged by message ID. Legacy Home responses remain supported.

Employees can be deleted from the sidebar context menu or with Backspace, followed by a confirmation that identifies the employee and device. Text fields retain normal Backspace behavior. Active work blocks deletion. The operation removes only that employee's product conversations and schedules, detaches its Telegram binding, and leaves other employees and shared workspace files alone.

Telegram groups keep `NO_REPLY` internal, recognize replies to messages from before a migration, and transcribe video notes in message order. Group and private histories remain separate. Installer-provisioned Telegram MCP services receive the verified sender, chat and message identity. Codex unloads the thread's existing MCP transport before changing that identity; a plain resume retained the prior participant's headers in live testing. Turns without verified Telegram identity cannot enable these services.

Validation:

- 249 runtime tests across 42 suites, TypeScript checking and diff checks passed.
- 103 native tests across 14 suites passed; macOS Release and iOS simulator builds passed. No App Store submission was changed.
- Isolated Mac UI: context menu, Backspace confirmation, cancel, text editing, and complete menu-bar content verified. Production employee data was not deleted for testing.
- Read-only native Codex/MCP checks verified three distinct authorized participants in a shared group. Real model checks verified silence on an unaddressed message and confirmation before changes. No test messages or business changes were sent to Telegram or its connected services.
- Local migration rehearsal imported history idempotently and preserved private conversations. Production checks confirmed 50-message pages without overlap, unchanged employee/schedule counts, SQLite integrity and a running Telegram adapter.
- App and DMG were Developer ID signed, notarized and stapled. Sparkle metadata and archive signature were independently checked.

Pagination contract: `olderCursor` indicates that older messages exist. `hasMore` indicates additional *newer* messages when using `after`; it is false on the initial or older page. Deployment checks use the correct direction. A mistaken initial assertion exercised automatic rollback before the corrected deployment completed.

Private source exports, credentials, sender IDs, deployment receipts and backups remain outside the public source archive. Production acceptance does not include sending a synthetic message into a user's group or exercising a destructive CRM action.
