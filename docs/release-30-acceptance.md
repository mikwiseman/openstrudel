# Release 30 acceptance

This is the full follow-up requested on 9 October after release 29. A check is
complete only with a recorded result. Passing transport or unit tests does not
stand in for real device, microphone or assistive-technology evidence.

## Preserve

- Keep the five existing employees and the user's deliberate deletions.
- Test messages only in the owner DM or the private QA group. Never replay
  historical cancellation, payment or CRM instructions against live records.
- Keep the Telegram sender and conversation audience intact. Source access
  decisions must not be bypassed using the owner's private identity.
- Preserve user data, Codex history, active work in other projects, existing
  release archives and review submissions. Use the managed build and backup tools.

## Ordered acceptance

1. [x] Reconcile runtime/native regressions, current installation and release
   evidence. Record test failures before making changes.
2. [x] Complete queued-message editing and ordering with conflict handling,
   attachment preservation, cancellation and native Codex steering. Check a turn
   finishing while a queue action is submitted, retries, two clients and restart.
3. [ ] Exercise accessible navigation, Hide/Show and device removal with touch,
   keyboard and accessibility inspection; check empty states, narrow layouts,
   light/dark appearance, reduced motion and large text. Run Apple audit checks.
4. [ ] Exercise recording, denied permission, cancellation, app switching,
   transcription, draft review/send and Open Ramble's supported entry point.
   Clearly distinguish an actual microphone capture from a file fixture.
5. [x] Exercise direct and remote clients, catalog deletion, disconnected devices,
   conditional refresh, reconnection, stale requests and rejected credentials.
   Identify which physical/network combinations were actually available.
6. [x] Replay useful Telegram work privately: context retention, native employee
   delegation, text/photo/document input, service/skill availability and approval
   modes. Verify receipts, useful output and no unintended external changes.
7. [x] Inspect the source's Core Team access policy. Validate permitted reads and
   useful denied-access recovery. Any change to the shared audience's source
   permissions must be explicit and limited to the intended data and group.
8. [x] Run final regression/build checks after fixes, inspect diffs, then deploy
   verified changes with backup, atomic installation and rollback. Verify public
   artifacts and the installed update separately. Preserve pending iOS review.

## Evidence

Private logs and real-case observations: `.data/full-acceptance-2026-10-09/`.
Prior evidence and exact known boundaries: `docs/telegram-parity-migration.md`.
Record environment or permission blockers here; never mark them passed by
substituting a simulation.

## Verified on 9 October

| Area | Result and evidence |
| --- | --- |
| Runtime regression | 316 tests in 49 files passed; TypeScript type checking passed. Includes queue edits, attachments, ordering, cancellation, conflicting clients, restart recovery, steering and context checkpoints. `final-runtime-tests.log`, `final-typecheck.log`. |
| Native regression | 126 tests in 17 suites passed again after the final accessibility layout refinement. Includes actual local recognition of a Russian audio file (0.727 s), not physical microphone capture. `native-verified.xcresult`. |
| Build storage | 11 maintenance tests passed. Only the managed cache wrapper is used; no dated DerivedData directories. |
| iPad workflows | Settings, employee changes, messages and recovery passed. Telegram group discovery, pause/resume, imported history and service scope passed. Hide persists after relaunch; Show restores the row. Removing an unavailable device preserves host employees and Telegram bindings. `ipad-acceptance.xcresult`, `ipad-final-telegram-visibility.xcresult`. |
| Narrow iPhone and large text | Dark appearance, maximum accessibility text size: Apple accessibility audit and queue edit/reorder/cancel/send passed. Screenshots exposed cramped controls that the audit alone missed. Consent and service buttons now wrap correctly; input gets its own full-width row and symbols retain their 44-point targets. `iphone-readable-composer.xcresult`, `iphone-readable-images/`. |
| Final settings regression | A fresh fixture and clean dedicated iPhone simulator passed the full settings/employee/message/recovery scenario in 197 seconds at maximum accessibility text size. `iphone-final-settings.xcresult`. |
| Long histories | 5,000 messages, 100 pages of 50: no omissions or duplicate IDs. Across 300 HTTP reads, median 4.53 ms, p95 5.71 ms; largest response 143,512 bytes. Observed runtime RSS 115.2–123.2 MiB. This is a measured server fixture, not an end-to-end latency or universal memory bound. `history-performance.json`. |
| Different networks | An external Linux host reached the Mini over its public TLS endpoint. Fourteen checks covered certificate pinning, unauthenticated/invalid requests, origin checks, pairing retries, one-use invitations, non-owner restrictions, logout and revocation. The existing two connections were preserved. `external-probe-summary.log`. |
| Real Telegram inputs | Private QA group: unaddressed background context stayed silent; a subsequent mention retained the changed venue, proposed dates and headcounts. A photo produced the correct 3,840 total; a text attachment produced the correct 1,160 remaining delivery budget. Requests/replies: 1677349–1677351, 1677353–1677354, 1677357–1677358. `real-evidence.json`. |
| Useful work replay | An isolated replay retained the original shared audience and distinguished the 950k construction case, 1.5m discussion and latest 2m karting offer, with a useful draft and missing terms. This run reused retained context; its trace does not prove a fresh PDF/tool read. No production records were changed. `real-case-replay.log`. |
| Crash and disconnection | The inspected October 9 crash belongs to the older QA27 bundle and its Telegram callback, already fixed with MainActor handling in 29. Current health and retained logs did not reproduce the reported intermittent disconnect. No cause is assigned without evidence. |

## Changes made from failures

- Queue actions use the existing conversation executor and native Codex steering.
  An edit uses the expected previous text; ordering uses the expected current
  queue. A late or conflicting action returns an error and keeps the edit in the
  sheet. Telegram jobs retain their positions and sender identity. Attachments
  remain attached. Consumed context never moves backward when input is reordered.
- The queue is included independently of the visible history page, so loading
  older messages cannot hide pending input. Client generations reject stale polls
  and mutations after changing conversations or connections.
- Apple accessibility checks and screenshots are both required. List/code content
  has combined accessibility elements; large text has adaptive button layouts,
  fixed-size control symbols and a full-width composer.
- Earlier UI failures came from an employee renamed by a preceding test, an
  off-screen lazy-list row and simulator Keychain access in an unsigned build.
  Tests now use stable employee IDs and reveal rows before interacting, with fresh
  fixtures and ad hoc signed simulator builds. Failed bundles were retained.

## Boundaries that remain explicit

- Physical microphone capture and the system permission dialog remain unverified.
  Computer Use rejected control of that surface. No TCC or alternative permission
  bypass was used. File recognition and saved-draft review/send are verified.
- Apple accessibility auditing and semantic inspection do not replace a complete
  human VoiceOver gesture pass on physical devices. Appearance/text-size evidence
  covers the named configurations, not every possible device/setting combination.
- The company-source bridge explicitly limits the shared technical actor to School
  tools. Group meetings, finance and documents cannot be exposed by substituting
  the owner's private identity. Owner-DM reads and the source denial are verified;
  complete Core Team source parity requires an explicit group-scoped source grant.
- The intentionally deleted employees and their schedules remain deleted. Personal
  Israel scheduling is not re-enabled or claimed as running on this Home.
- No new sustained 30–40 GB memory growth or connection loss was reproduced.
  Healthy samples are not proof that these historical incidents cannot recur.

## Release gate

Release 30 must pass final native compilation/tests after the accessibility
refinement, notarization and signature checks, an atomic local installation with
a healthy managed rollback snapshot, post-installation Telegram/network checks,
and the isolated Sparkle update. Public artifact hashes and the installed runtime
are checked independently. iOS 28's pending review must remain untouched.

### Release result

- PR [#9](https://github.com/mikwiseman/openstrudel/pull/9) merged as
  `f5869d9`. Artifacts contain the verified source commit `a303b49`.
- Mac app and DMG both received Accepted notarization results and were stapled.
  Gatekeeper, code signatures, Sparkle archive and feed signatures passed.
- Mini now runs 1.0 (30). The cutover preserved all five employees, 13
  conversations, 1,792 messages, three schedules and every Telegram binding.
  The consistent managed backup was marked healthy after the checks.
- A disposable employee on the installed production runtime exercised actual
  Codex queue execution. Editing and promotion took effect; the cancelled item
  never ran. Exactly two replies appeared, including the edited `ПРОВЕРЕНО-30`.
  The disposable employee was removed after completion; the existing five remain.
- Private Telegram request 1677380 received one useful reply, 1677381, after
  installation. No live working group received a release probe.
- The external-network 14-check suite passed again after installation. An earlier
  simultaneous attempt encountered the extra disposable employee while asserting
  a five-employee catalog; that failed evidence is retained. The sequential rerun
  passed without changing the assertion or production data.
- The immutable Mac/Home downloads, stable aliases, checksums and signed public
  feed were published and externally hash-verified. The installed app accepted
  the public feed and reported it was up to date. No web service was restarted.
- Computer Use exercised the separate signed Sparkle QA bundle from 29 through
  discovery, download, verification, installation and relaunch. Its About panel
  and installed bundle both reported 30. It remained signed out, with no runtime
  or production endpoint. The temporary public test feed was removed afterward.
- iOS 30 is VALID and IN_BETA_TESTING in the existing internal tester group.
  iOS 28 remains WAITING_FOR_REVIEW.
- Final installed health: Telegram running without a connection error, SQLite
  integrity OK, five employees, zero unfinished messages. Observed Home RSS was
  89 MiB. This is a point-in-time observation, not a memory guarantee.

Deployment, public hashes, update, Apple and live test receipts are retained in
`.data/full-acceptance-2026-10-09/release30-shipping/`. The physical and source-access
boundaries above remain open; release completion does not mark them as passed.
