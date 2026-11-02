# Current work · 2 November 2026

## Scope and baseline

The user asked for current second-brain research, autonomous implementation and parallel agents. Simplicity remains the product constraint: native Codex execution, existing source systems, useful evidence and verified results. This supplements earlier work; it does not restore intentionally deleted employees or recreate removed Codex automations.

- Start: OpenStrudel main `33eb2eb`; WaiWeb main `519fdc46`.
- Verified all 723 files in the continuation handoff against their sizes and SHA-256 values.
- Preserve unrelated local files and other chats' worktrees.
- Resource checks are during active work only. Initial Mini check: about 23.45 GiB free, memory pressure normal, swap 182 MiB. No cleanup required.
- [Architecture decision and current source comparison](architecture/second-brain-2026-11-02.md).

## Work streams

| Stream | Completed evidence | Remaining acceptance |
| --- | --- | --- |
| Memory and retrieval | Existing Codex/SQL/vector architecture inspected; broad and client-scoped live retrieval compared; streaming history export and access cleanup implemented, tested and deployed on Wolf | Finish post-update employee QA; public client release and inaccessible Homes remain separate acceptance gates |
| Legal library | Hardened importer: incomplete roots and missing dependencies cannot publish false deletions; 15 tests; two live read-only employee cases; dated source corrections applied with backups; updated skill installed through the native extension API | Full refresh waits for mapped source roots and required extraction dependency; current live snapshot retained |
| Incident reliability | 104 focused tests and typecheck; failures scoped to schedule/task; unrelated replies cannot clear failures; voice/delivery independent | Obtain existing WaiClaw access to inspect actual runtime cause and deploy; no claim that alerts alone repair the failing task |
| Entity/document corrections | Fixed omitted-field archival reset and case-sensitive alias mismatch; 14 database integration and 19 focused tests passed, including permission boundaries; named-client retrieval guidance also checks unlinked sources; company API deployed with 22 authenticated acceptance checks | Broader retrieval evaluation across the remaining personal sources |
| Finance categories | Owner-only company MCP operations, idempotency and readback; stable School category identities; Money, School and company API deployed and checked; existing security dependency overlay preserved | Employee-level tool discovery and a separate authenticated browser check; no real financial mutation required for acceptance |
| Calendar/Grant | Earlier handoff includes account/source inventory | Recheck real employee access and all attendees; no test invitations; no assumption that unknown is free |
| News/Startups | Wrong destination confirmed; target group currently contains a different bot | Add correct existing bot only as part of verified cutover, bind employee, move the existing schedule; no copied chat history or duplicate schedule |

## Local verification

- `npm run typecheck`: passed for the streaming change.
- `npm test -- tests/knowledge.test.ts tests/history-export.test.ts tests/agent-archive.test.ts`: 37 passed.
- Stress fixture exports 8,000 messages, producing source files larger than 64 MiB, in a Node child with `--max-old-space-size=64`. Full owner and imported histories remain available. This tests one identified unbounded allocation path, not the cause of every past memory incident.
- Derived JSONL publication preserves the previous complete file when iteration fails; permissions remain private. Hidden final imported rows remove their obsolete derived copy. Deleted-only native memory paths are no longer granted; native files remain on disk.
- Final combined OpenStrudel suite: **963 passed, 4 skipped**, across 104 passing files and one skipped file. TypeScript compilation passed. Skipped tests are not counted as live acceptance.
- Linux image verification: 8,000 messages exported to an 85,045,780-byte source file with a 64 MiB JavaScript heap cap. Peak sampled process RSS was about 190 MiB; SQLite/native memory is outside that heap cap. Exact inherited signing-file hashes matched production.
- Combined company API suite at `02855b52`: **2,493 passed, 8 skipped**, TypeScript passed. The database-backed knowledge cases use one PGlite connection and do not establish concurrent-writer behavior.
- School finance acceptance includes 58 finance tests, 27 sync tests, 15 MCP tests, typecheck and production build, plus nine actual SQL identity checks in an isolated database. No synthetic financial records were inserted in production.

## Completed production changes

- Wolf now runs `openstrudel:brain-20261102-5927c5b`. A deployment attempt correctly refused to interrupt an active request. Once idle, the deployment created a consistent stopped-volume rollback snapshot, atomically changed only the main Home image, and passed authenticated health, SQLite integrity and retained-data checks. Six employees, 15 schedules and all 5,017 existing messages were retained. The separate App Review container and public health route were unchanged; signing runtime hashes were preserved.
- The legal-library skill update used the existing preview/install transaction and native Codex skill reload. The existing index remained intact: 678 ready documents, two requiring review, four online-only pointers and 14 historical missing records. No full import or new reminder schedule was created.
- Post-update root assistant QA completed through its private API conversation with no question card. It correctly separated an earlier positive assessment from the latest pending registry entry, cited the dated original Telegram messages, and treated a colleague's promise as uncompleted work. The multi-source answer took about 3 minutes 39 seconds; this establishes correctness for that case, not a general low-latency guarantee.
- A one-sentence follow-up using the same evidence completed in 24.1 seconds. The private QA conversation and checked request/response IDs have no Telegram outbox entries; the SQLite integrity check remained `ok`.
- A subsequent read-only employee test discovered the newly deployed finance capabilities through its normal connection, returned all eight current School expense categories, and correctly named the create/update tools. It completed in 43.4 seconds with no question card or pending interaction. Direct authenticated service acceptance remains the authority for operation permissions and unchanged data.
- WaiMoney `68c51a9` passed server-side tests, typecheck and production build, then the documented atomic rollout and health checks. Only the reviewed category-write permission was added to three existing owner/company integrations. Credentials, categories and transactions were unchanged. School's existing sync sidecar briefly retried HTTP 502 during the upstream restart, recovered automatically and resumed successful minute-by-minute sync; no School deployment caused that restart.
- School main `43dee147` passed the candidate gate (34 routes and five report groups) and the production gate (138 routes and five report groups). Only the app container changed. All 34 category IDs and 206 finance-entry IDs were retained; eight categories are linked to the configured source budget, with no cross-budget links. The other 11 containers and existing configuration remained unchanged. A timestamped database backup and exact-image rollback were retained.
- Company API release `02855b52` is active with 22 authenticated checks passed. Exact-name and case-varied aliases now resolve to the same entity and revision. The tool catalogue gained only the two category operations; preview and stale-version rejection passed, with no category mutation. All 17 unrelated processes and canonical/web state remained unchanged. The first activation rolled back automatically because the acceptance harness incorrectly rejected a nullable optional Boolean schema; correcting that assertion allowed the unchanged candidate to pass.

## Active resource and release checks

An unrelated active build exhausted the Mini's free disk during this work. Cleanup was limited to this task's verified idle dependency/build directories and the reproducible npm download cache. Codex history, active builds, databases, release archives and rollback material were retained. No other task was interrupted. The other build's later cleanup is not attributed to this task.

Free space recovered to about 18.5 GiB, with normal memory pressure, before the controlled native release build began. Resource measurements and cleanup receipts are private under `.data/resource-monitor`; no recurring resource automation was created.

Build 66 is being prepared for macOS and the Home archive. The native application source is unchanged from build 65; iOS retains its explicit build-65 override. TestFlight does not need an identical new archive for these server/runtime changes. Public installer and feed publication remain gated on signed-package verification, notarization and updater acceptance.

The School production browser check reached the normal login boundary. Brave had no authenticated School session and the 1Password GUI was locked; an existing saved account reference did not establish a usable founder session. The temporary test tab was closed. This is an outstanding authenticated visual check, not a failure of the passed HTTP, database or MCP checks. No login was fabricated and no user question was required to continue independent release work.

## Deployment constraints

Wolf's previous signing image contained a security-sensitive tool absent from main's source. Typed source, wrapper and build dependencies have now been reconstructed and committed. The emitted signing JavaScript and wrapper are byte-for-byte identical to the running implementation; the original missing Git commit was not recovered. The public source now retains that capability, with 21 synthetic signing/guard tests and a verified Home archive. No real document was signed during testing.

Existing Mini-to-WaiClaw and trusted Wolf-to-WaiClaw SSH attempts reject authentication. No available saved Mini connection contains that Home's access. Keep this as an explicit live-validation constraint rather than guessing credentials or reporting the task fixed.

Private source records, model QA responses, token identifiers and deployment receipts stay outside Git. Public work notes record checks and limitations without copying the knowledge corpus.
