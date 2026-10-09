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
- Mac Computer Use passed on an isolated build: ordinary pairing, Command-N on remote host, text plus `brief.txt` moved to the local host and back, submission and reply on the remote host. The local fixture retained zero employees.
- Live Mac mini test passed through its public HTTPS address with an ordinary temporary credential. A disposable employee was created, visible to the owner, and answered through real Codex. Only the disposable employee and credential were removed; all five existing employees remain. Previously deleted employees were not restored.
- Release macOS app build and signed iOS archive/export succeeded. An attempted Release-configuration unit-test build hit the existing Swift concurrency diagnostic in `DigitalOceanCloudTests.swift`; the standard Debug test suite and Release application builds succeeded.

Private logs, screenshots, xcresult bundles and live verification: `.data/remote-employee-creation-31/`. Release signing and deployment receipts are in its `shipping/` directory. No credentials, user conversations or state snapshots are committed.

## Shipping checks

Pending: small-phone/iPad layout check, Mac notarization and signed feed publication, isolated Sparkle installation, native-only atomic local install, internal TestFlight availability. Update this section with observed outcomes before declaring this release complete.
