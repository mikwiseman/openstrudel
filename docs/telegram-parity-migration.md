# Telegram: useful work and a simpler entry point

This continues the 9 October 2026 product revision. The existing transport tests
prove message delivery, attachments and isolation; they do not establish parity
with the user's former OpenClaw/Hermes assistants.

## Product contract

- OpenStrudel is the main assistant and the single Telegram bot on a device.
  It answers directly or asks a suitable employee for help using native Codex
  delegation. Users do not configure a router or bind every group manually.
- Adding the connected bot to an owner-authorized group establishes that
  conversation automatically. Group membership defines its audience. Routing
  never expands access to private employee history, services or files.
- The main sidebar is for the assistant and employees. Telegram history remains
  available through a clearly named conversation browser, without a second
  always-expanded list of Telegram groups below the employees.
- An employee lives on its hosting device. Connecting another device gives
  access; it does not relocate the employee or create a principal device.
- Everyday setup is short. Advanced service, skill, permission and device
  controls remain available with explicit scope and plain language.

## Work streams and acceptance

Execution order for the remaining work: connection/catalog correctness and
removal, personal hiding, composer and dictation, private end-to-end scenarios,
then the combined release. Reuse Codex app-server operations and native Apple
controls; do not introduce a parallel agent engine or a second Telegram router.

### 0. Latest decisions and preservation rules

- [x] The user confirmed that the 37 employees deleted on 9 October at
  11:40–11:42 Moscow were intentionally removed. Leave them, their conversations
  and schedules deleted. This includes «Эрец Исраэль» and «Редактор».
- [x] Merge the approved bun and monochrome menu icons from `84cb899`.
  The combined next Mac/Home release is 29. Installed Mac 28 and public Mac 27
  are different builds; do not publish another artifact as build 28.
- [x] Check why the existing «Тестовая команда» cannot be removed. Distinguish
  disconnecting a saved device from deleting its employees or erasing its data.
  Make the appropriate action visible and verify it when the device is offline.
- [ ] Keep App Store build 28's pending review intact. Deliver a new iOS build
  separately; diagnose the distribution signing failure without rotating keys.

### 1. Wai Core Team on Mac mini

- [x] Read recent real group requests and successful former assistant responses.
- [x] Compare current persona, instructions, memory, tools, permissions and
  schedules with the fresh source on WAI Magic. Preserve scoped credentials;
  do not print them or copy unrelated private data into the group.
- [x] Create a benchmark from real work: proposal/pricing analysis, finding
  source documents, recalling a decision with attribution, and school operations.
- [x] Exercise the same inputs privately with the same employee and tool scope.
  A passing answer must use the relevant evidence and produce a usable result;
  a tool ping or confident prose alone is insufficient.
- [x] Test delegation with a real specialist task and verify the helper ran.
- [x] Verify read tasks do not change CRM, schedules or send messages elsewhere.
  Verify write behavior with isolated fixtures or a separately authorized real
  operation; do not replay historical cancellation instructions against today.
- [ ] Fix demonstrated runtime/configuration gaps and repeat failed cases.
- [x] Confirm exactly one active Telegram delivery path and no duplicate replies.

### 2. Personal “Эрец Исраэль aka Земля в Израиле”

**Superseded by the user's explicit deletion decision on 9 October.** The
historical migration evidence below remains a record of earlier work. Do not
restore this employee, re-enable either schedule, or wait for a new scheduled
issue. Use a new disposable employee for subsequent personal-case tests.

The user requested a separate implementation task. It owns fresh source export,
persona, source quality, deduplication, schedules, migration and personal-case QA.
Coordinate the actual destination from that task's latest user instructions;
do not call a task created on Mac mini a task running on MacBook.

- [x] Inventory fresh source instructions, files, schedules and delivery receipts.
- [x] Compare real listing/digest outputs, including links, photos, current
  availability, location, required facts and explicitly unknown facts.
- [x] Preserve history and deduplication across the transfer.
- [x] Validate the replacement before switching the exact old schedule.
- [x] Avoid two bots or two schedulers publishing the same issue.
- [x] Keep a recoverable source snapshot and documented rollback.
- First complete scheduled ten-listing issue: not observed before intentional
  deletion. A preview did not establish that result; this check is cancelled.

### 3. Navigation and Telegram setup

- [x] Remove the separate Telegram block from the default employee list.
- [x] Provide an obvious conversation/history entry with names, search and
  device context only where needed. Preserve access to existing group history.
- [x] Opening a group must clearly state where an app-authored answer goes.
  Never silently publish an app message to Telegram.
- [x] Keep employee settings on the employee's name/avatar and application
  settings on the device/settings entry; avoid duplicate gears.
- [ ] Verify main assistant, employee, group, imported archive, search, empty
  state, multiple devices, unavailable device, compact iOS and macOS layouts.
- [x] Update documentation that still describes manual group binding.

### 4. Reliability and remaining product requirements

Retain the existing acceptance coverage for staged history loading, bounded
memory, cancelable backups, erase-this-device semantics, useful account loading
states, distinct limits/credits, direct service setup, permissions and safe
cross-network device invitations. Any newly observed failure enters this plan
with a reproduction and evidence before adding a workaround.

- [x] Run relevant runtime regressions and native build/tests using the managed
  build wrapper; inspect the real application through Computer Use.
- [x] Keep shared-group QA quiet: use a private test group or DM for replay.
- [x] Save private inputs, observations and results outside version control.
- [ ] Ship only verified changes: diff, checks, managed backup, staged atomic
  installation, exact-service restart if required, health/data checks, rollback
  on failure, then mark the backup healthy.
- [ ] Report proven outcomes and remaining blockers separately. Do not equate
  a successful build or a synthetic test with a completed migration.

### 5. Connected devices, catalog changes and personal hiding

- [ ] Reproduce removal on one host while two clients are connected. Inspect
  catalog refresh, stale in-flight responses, reconnects and selection changes.
- [x] Update clients promptly without repeatedly loading full histories,
  account limits or integrations. Reuse HTTP conditional requests or an existing
  event mechanism; add new infrastructure only if evidence requires it.
- [x] Check Mini connection logs and distinguish transport failure, account
  checking and a stale menu-bar status. Preserve usable cached data on failure.
- [x] Add reversible Hide/Show actions, stored on each viewing client. Hiding
  must not delete, stop or hide an employee for other people or devices.
- [x] Verify hidden employees stay hidden after reconnect/relaunch, can be
  found in a clear hidden-items view, and never mix across connected hosts.
- [ ] Verify deletion, hiding and device removal through context menus,
  keyboard, confirmation and touch layouts, including offline states.

### 6. Composer, voice and attachments

- [x] Use Codex `turn/steer` with its required expected turn ID for messages
  sent during a running turn. Default to Steer; offer explicit queue behavior.
  Handle turn completion races without duplicate messages or silent loss.
- [x] Keep drafts, attachments and queued inputs visible and recoverable.
  Verify stop, cancel, retry, pasted images, file picker and drag-and-drop.
- [x] Match the supplied recording states: cancel, live waveform, stop to
  review, and send. Avoid duplicate recording/transcription processes.
- [x] Recommend Open Ramble for Mac dictation and use its actual supported
  integration. It currently inserts at the cursor through its global hotkey;
  it has no public URL/IPC recording control. Do not invent one in the UI.
- [ ] Verify microphone/accessibility denial, model download/setup, local
  dictation, text review, empty recording, cancellation and app switching.
- [ ] Check keyboard access, VoiceOver, reduced motion, narrow windows,
  dark/light appearance and accessibility text sizes in every changed state.

### 7. Final real scenarios and shipping

- [x] In the private QA group, an unaddressed discussion supplies facts to a
  later addressed request, with no unsolicited response to the first message.
- [x] Create disposable employees and verify real Codex delegation, retaining
  their distinct instructions and keeping private/group audiences isolated.
- [x] In the owner's bot DM, complete a real read-only company-source request,
  including an ordinary approval. Verify evidence, useful output and no writes.
- [x] Exercise tool/skill setup and missing-access recovery without changing
  global permissions merely to make a test pass.
- [x] Check permissions modes with isolated tests. Never replay historical
  cancellation or scheduling instructions against current production data.
- [x] Validate crash and memory regressions with bounded histories/attachments;
  record observed resource use and unresolved limitations rather than promises.
- [ ] Update PR scope and evidence, run relevant checks, build the combined
  icons/runtime/native release, deploy with backup and rollback, then merge and
  publish matching Mac/Home artifacts. Preserve iOS review and release evidence.

## Evidence

Current investigation: `.data/migration-parity-2026-10-09/` (private).
Earlier transport coverage: `docs/employee-acceptance-2026-10-09.md`.
Earlier routing implementation: `docs/assistant-routing-and-design.md`.

Initial observations:

- The sidebar currently appends every Telegram group after the employee list.
- Native Codex employee delegation is already implemented; adding a second
  router would duplicate it. Investigate actual context and tool scope first.
- The last Core Team release probes asked only for a summary period and a
  trivial text rewrite. They do not measure the usefulness requested here.

### Verified investigation results, 9 October

- **Missing discussion context:** mention-only groups discarded unaddressed
  messages and attachments. They now retain authorized conversation context
  without invoking the model or replying. The next addressed request includes
  up to 50 new context entries with bounded excerpts. A native tool reads full
  text and files from this conversation in pages; it cannot read another group.
  Failed answers and local help do not consume the unread context checkpoint.
- **Existing personal history:** older root-bot DMs had no explicit conversation
  binding. The history browser now resolves the existing conversation on read,
  preserving the employee and audience. Imported archives have the same entry
  point. The old nested conversation dropdown is removed from the title.
- **Imported root archives:** an archive without a separate employee returned
  a null profile ID, which the native model previously rejected. This could
  make the whole catalog look disconnected. The model accepts root archives,
  and a regression checks both loading and selecting one. Archive titles remain
  visible in the iOS toolbar. Conversation subtitles wrap at accessibility text
  sizes rather than truncating the explanation.
- **Proposal benchmark:** actual construction and karting PDFs were read. The
  assistant distinguished the revised 2-million offer from the earlier figure,
  explained scope/price differences and produced a usable draft with explicit
  open terms. No client message or CRM write occurred.
- **School benchmark:** the live summary was read and totals reconciled, with
  completed/upcoming/cancelled lessons separated. Recommendations distinguished
  missing prices and unknown capacity from a proven overload.
- **Company meeting benchmark:** the owner's private Telegram identity could
  search, open records and read transcripts. The answer linked the actual work
  cards and separated decisions, proposals and missing acceptance criteria.
  The same source deliberately withholds company meetings in group contexts.
  This is a source permission boundary, not a disconnected MCP. Full meeting
  parity in Core Team remains open until explicit group-scoped source access
  exists. The client must not substitute the owner's private identity.
- **Personal migration:** the separate task switched only the Israel group and
  its two schedules to Mac mini, preserving 78 history entries and 332 unique
  historical URLs. The old schedules and route were disabled with rollback
  snapshots; unrelated OpenClaw routes stayed active. A private preview and
  delivered photo/map album were verified. The first full scheduled issue has
  not yet been observed, and the destination is not MacBook.

The comparison inputs, model traces and private source material stay outside
version control. No benchmark response was posted to Core Team or another
shared working group. Existing transport, attachment, permissions, crash,
memory and keyboard coverage is detailed in the linked earlier acceptance.

### Release checks

- Runtime: 310 tests in 48 files, plus TypeScript checking.
- Native model: 125 tests across 17 suites, including catalog deletion, stale
  responses, revoked credentials, client-local hiding, offline removal, voice
  drafts and real attachment providers. Build/backup storage: 11 tests.
- iPhone: private Telegram history, imported root archive, automatic groups,
  pause/resume, missing private link, selected group after relaunch, and services
  scoped to the group passed against the isolated Home fixture.
- macOS Computer Use: main assistant and employee navigation, multiple devices,
  an unavailable device alongside a working one, conversation search/no results,
  and opening the correct imported archive were inspected in the native app.
- iPad landscape with accessibility text sizes is verified using the same
  scenario, with screenshot inspection in addition to functional assertions.
- Mac build 28 was installed and its runtime/data health checks passed. The
  combined icons and subsequent changes will ship as Mac/Home 29. App Store
  Connect has iOS 28 waiting for review; preserve that review. iOS 29 archive
  signing uses the existing dedicated release keychain, now verified with a
  test signature. Upload and processing are still pending.


### Revision 29 verification

- Independent conditional catalog requests run every five seconds per connected
  host (15 seconds when unavailable); full account/integration refresh is separate.
  Unchanged catalogs return 304 without publishing a SwiftUI update. Cached data
  survives connection failure. A public health response cannot mask revoked access.
- In the isolated Mac app, «Тестовая команда» was removed while its runtime was
  unavailable. The other device and its employees remained. The actual reported
  saved connection was not present in Mini's production preferences; its screenshot
  may be from another client or an earlier build.
- Hide/Show was exercised through the Mac context menu and hidden-items view.
  Regression tests cover relaunch, another client, and identical employee IDs on
  different hosting devices. No host employee record is modified.
- The 5,000-message fixture opened at message 5,000 and loaded earlier messages
  while retaining the visible boundary near 4,951. Observed QA app RSS was 99.7 MiB.
  This is one measured scenario, not proof of a universal memory ceiling.
- A synthesized Russian recording was actually recognized using Apple's local
  DictationTranscriber. In the Mac UI, a saved audio draft survived relaunch,
  became editable text, and was sent only after pressing Send. The recording was
  then removed. A real file picker plus pasted text also delivered the attachment.
- Live microphone capture reached the macOS permission dialog. Computer Use
  disallowed control of that system surface, so capture permission and physical
  microphone recording remain unverified. No TCC or permission bypass was used.
- Open Ramble is recommended on Mac and opened through its installed application
  or official download page. Its supported global hotkey inserts text at the
  cursor. Integrated waveform recording uses Apple's on-device transcription.
- In the private owner-and-bot QA group, an unaddressed fictional workshop note
  received no unsolicited answer. A later mention retained its date, time,
  duration, headcount, unchanged price and unknown venue. Native Codex traces
  confirmed delegation to the newly created «Проверка релиза 29» employee and
  the returned answer followed that employee's distinct format. One reply arrived.
- The owner's bot DM read actual company meeting evidence with an ordinary
  approval, linked the record and distinguished a proposed price from accepted
  terms. No writes occurred. Group-scoped company-source access is still a
  separate boundary; the private identity was not substituted into a group.
- Mini's current Home and Telegram delivery state were healthy with no unfinished
  runs. Recent retained logs did not reproduce the reported disconnect. The
  exact cause of that earlier occurrence is not established.
- Queue input, cancellation, active interruption, attachment input, same-account
  steering and uncertain delivery are covered by runtime regression tests. Native
  `turn/steer` is used with expectedTurnId; there is no additional agent loop.
  Editing or promoting an already queued message remains a separate follow-up.
