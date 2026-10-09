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
- [ ] Test delegation with a real specialist task and verify the helper ran.
- [x] Verify read tasks do not change CRM, schedules or send messages elsewhere.
  Verify write behavior with isolated fixtures or a separately authorized real
  operation; do not replay historical cancellation instructions against today.
- [ ] Fix demonstrated runtime/configuration gaps and repeat failed cases.
- [ ] Confirm exactly one active Telegram delivery path and no duplicate replies.

### 2. Personal “Эрец Исраэль aka Земля в Израиле”

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
- [ ] Observe the first complete scheduled ten-listing issue. A three-listing
  preview and an already-delivered-day dry run do not prove this final step.

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

- [ ] Run relevant runtime regressions and native build/tests using the managed
  build wrapper; inspect the real application through Computer Use.
- [x] Keep shared-group QA quiet: use a private test group or DM for replay.
- [x] Save private inputs, observations and results outside version control.
- [ ] Ship only verified changes: diff, checks, managed backup, staged atomic
  installation, exact-service restart if required, health/data checks, rollback
  on failure, then mark the backup healthy.
- [ ] Report proven outcomes and remaining blockers separately. Do not equate
  a successful build or a synthetic test with a completed migration.

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

- Runtime: 303 tests in 47 files, plus TypeScript checking.
- Native model: 115 tests across 15 suites, including a root archive and
  employee/group selection without changing the underlying conversation.
- iPhone: private Telegram history, imported root archive, automatic groups,
  pause/resume, missing private link, selected group after relaunch, and services
  scoped to the group passed against the isolated Home fixture.
- macOS Computer Use: main assistant and employee navigation, multiple devices,
  an unavailable device alongside a working one, conversation search/no results,
  and opening the correct imported archive were inspected in the native app.
- iPad landscape with accessibility text sizes is verified using the same
  scenario, with screenshot inspection in addition to functional assertions.
- Mac build 28 and iOS build 29 are separate release numbers. App Store Connect
  already has iOS 28 waiting for review; this revision must preserve that review
  and deliver iOS 29 through TestFlight.
