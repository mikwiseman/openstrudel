# Native release acceptance, 8 October 2026

Mac build 19 and iOS build 18 contain the native interface fixes from this audit. The Mac package keeps the existing Home runtime, identified by `67fb2c28bda404b51a98f2b93d19b2f9f5559214ccb0144cc104ee20c265f4e5`. No runtime migration or service restart is needed for this update.

## Changes

- Opening the app from the menu bar returns to the same Mac window, retaining its draft and reading position.
- History pagination uses SwiftUI's scroll target and position APIs. Polling no longer forces a scroll to the bottom. A tap on a question's answer does not change the reading anchor.
- Imported document text appears in a file card with a selectable detail view. Stored history and model input remain unchanged. The renderer never opens file paths from imported text.
- Long Telegram group names stay within the conversation header. The Telegram explanation distinguishes group history from private chats without an incorrect claim that only the owner can receive answers.
- Employee and service search remain available on iPad at accessibility text sizes. Service descriptions and actions share one scrolling area; at large text sizes actions move below descriptions.

## Acceptance evidence

Private screenshots, results and delivery receipts are in `.data/full-audit-2026-10-07/`. Do not publish that directory; it contains private operational evidence as well as synthetic test data.

| Journey | Result | Evidence |
| --- | --- | --- |
| Fresh iPhone installation, consent and device invitation | Passed | `ios-retry.xcresult`, DesignAccessibilityUITests and ReleaseScenariosUITests |
| Settings, employee search, edit cancellation, service connection and Telegram binding | Passed with synthetic providers | Same result bundle; 2 tests, 179.54 seconds, no failures |
| Multiline drafts, queued messages, interactive answer, storage error and retry | Passed with synthetic engine | ReleaseScenariosUITests |
| Relaunch, offline state and automatic reconnection | Passed | ReleaseScenariosUITests |
| iPad landscape, largest accessibility text size, search and service action width | Passed | `ipad-final.xcresult`; 70.89 seconds |
| Accessible names and hit regions on audited iPhone/iPad screens | Passed | XCTest accessibility reports and viewed screenshots |
| Mac settings, device invitation, accounts, backups, app settings and erase confirmation | Inspected | Numbered Mac screenshots 01–10; production erasure was not executed |
| Mac context-menu and Backspace deletion confirmation | Passed | `18-delete-confirmation.png`; cancellation retained the employee; Backspace in the composer edited only the draft |
| Mac menu-bar Open action | Passed | `16-menu-draft-after.png`; same workspace and draft |
| Mac history position and imported document | Passed | Screenshots 12–17; synthetic 155-message group plus a long document |
| Final Mac service layout | Passed | `19-final-mac-services.png`, Release build 19 with isolated bundle identifier |
| Runtime regression suite | Passed | 249 tests in 42 files; TypeScript typecheck passed |
| Native unit suite | Passed | 106 tests in 14 suites, including malformed and multiple imported attachments |
| Real Telegram transport and response behaviour | Passed for observed traffic | Three real replies have Telegram delivery receipts; normal discussion produced no reply. Read-only inspection, no test message sent to the group |
| Production database and Home health | Passed before deployment | SQLite quick check and authenticated health endpoint; post-deployment evidence is recorded separately |

## Performance and limits

The synthetic storage benchmark read 50,000 messages in 1,000 pages with no omissions. Median query time was 0.12 ms and p95 was 0.80 ms; the largest page was 27.4 KB. These are database timings, not end-to-end internet latency.

The full accessibility report also contains contrast and Dynamic Type observations on clipped offscreen content and size-capped system controls. Screenshots were reviewed and the obstructed service layout was fixed. This is not a claim of complete VoiceOver or accessibility certification. The test matrix uses simulators and a native Mac; it does not replace testing on every physical device.

External OAuth was exercised with a disposable provider. Real Telegram delivery was verified independently. No paid infrastructure test or fresh third-party account authorization was performed. Existing Apple review build 12 remains in its review queue; build 18 is a separate TestFlight update.

Liquid Glass is reserved for system controls and navigation; message content remains readable on an opaque background, following Apple's material guidance.
