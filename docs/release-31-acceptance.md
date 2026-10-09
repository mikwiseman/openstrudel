# Release 31: create employees on connected devices

## User path

With several devices connected, **+ → device → describe the employee → Send** creates the employee on that device. All clients connected by an ordinary invitation can use this path. With one device, + still opens the draft directly. Command-N starts on the current device.

The draft states **«Создать на: …»** and can be moved before submission. Text, attachments and appearance travel with it. Unreachable or unpaired destinations are unavailable in the menu. The host owns the employee, conversation, files and execution; disconnecting the client does not delete them.

## Implementation

- One native destination menu shared by the Mac sidebar, iOS chat list and draft. Reuses existing connections and APIs.
- No new backend permission or API. Ordinary paired clients already have permission to create employees; account, approval and invitation administration remains owner-only.
- Fixed a draft-loss regression exposed by the UI test: a disappearing conversation could overwrite a moved draft with its stale copy of the whole defaults dictionary. Conversation views now read/write the current library store and ignore callbacks from a no-longer-active connection.
- The bundled Home runtime digest is identical to build 30. This release requires an application update, with no service restart or data migration.

## Acceptance evidence, 9 October 2026

- TypeScript typecheck and all 317 server tests / 50 files passed. The new transport test uses TLS-pinned, ordinary invitations to two independent runtimes; verifies correct-host creation, idempotent retry, another client's catalogue, chat routing, persistence after disconnect, 403 for administration and 401 after revocation.
- All 127 native tests / 17 suites passed after the draft fix.
- iPhone 17 Pro UI scenario passed in light appearance and dark appearance with maximum accessibility text: pair two hosts, choose either host, move the draft both ways, create and receive a reply, relaunch, find the employee and disable an offline destination. The large-text test scrolls the native list to find an offscreen row.
- The same scenario passed on iPhone 16e and iPad mini. Exported screenshots were inspected for the destination menu, draft layout and unavailable destination state.
- Mac Computer Use passed on an isolated build: ordinary pairing, Command-N on remote host, text plus `brief.txt` moved to the local host and back, submission and reply on the remote host. The local fixture retained zero employees.
- Live Mac mini test passed through its public HTTPS address with an ordinary temporary credential. A disposable employee was created, visible to the owner, and answered through real Codex. Only the disposable employee and credential were removed; all five existing employees remain. Previously deleted employees were not restored.
- Release macOS app build and signed iOS archive/export succeeded. An attempted Release-configuration unit-test build hit the existing Swift concurrency diagnostic in `DigitalOceanCloudTests.swift`; the standard Debug test suite and Release application builds succeeded.

Private logs, screenshots, xcresult bundles and live verification: `.data/remote-employee-creation-31/`. Release signing and deployment receipts are in its `shipping/` directory. No credentials, user conversations or state snapshots are committed.

## Shipping checks

- The Mac app and DMG were accepted by Apple's notary service, stapled and accepted by Gatekeeper. Notary submission IDs: app `c4f4a78c-024c-4366-8499-1edc939d9973`; DMG `630f220c-4ff9-4e0f-ad19-a42efe267af1`.
- Build 31 was atomically installed on the Mac mini after a managed rollback snapshot. Computer Use confirmed **Version 1.0 (31)**, the employee list and conversation history. Home kept the same PID, Telegram remained healthy, and all five employees and Telegram bindings were preserved. The snapshot was marked healthy.
- iOS build 31 was uploaded, processed as **VALID**, and added to the existing internal TestFlight group with **IN_BETA_TESTING** status. The public App Store submission remains build 28, **WAITING_FOR_REVIEW**; this release does not replace it.
- The isolated Sparkle 30 → 31 test passed through the native interface: discovery, download, signature verification, installation and relaunch. The About dialog confirmed **Version 1.0 (31)** at the old app's location; the production Home PID remained unchanged.

- The notarized Mac DMG, Home source archive, stable download aliases, checksums and signed update feed were published atomically with rollback copies. Every public artifact was downloaded and matched against its SHA-256; the download page returned 200. The installed production app read the public feed and confirmed it was up to date. No web or Home service restart was needed.
- Completed fixture processes were stopped, three disposable simulators and the temporary public updater feed were removed. Test results, screenshots, release archives and rollback evidence were retained.

All release-31 acceptance and shipping checks above are complete. This evidence covers the stated paths; it is not a claim of exhaustive coverage of every possible environment.
