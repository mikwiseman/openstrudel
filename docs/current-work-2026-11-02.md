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
| Memory and retrieval | Existing Codex/SQL/vector architecture inspected; broad and client-scoped live retrieval compared; streaming history export and access cleanup implemented | Integrate, run the complete server suite, compile, validate deployed behavior and retained source access |
| Legal library | Hardened importer: incomplete roots and missing dependencies cannot publish false deletions; 15 tests; two live read-only employee cases; dated source corrections applied with backups | Full refresh waits for mapped source roots and required extraction dependency; current live snapshot retained |
| Incident reliability | 104 focused tests and typecheck; failures scoped to schedule/task; unrelated replies cannot clear failures; voice/delivery independent | Obtain existing WaiClaw access to inspect actual runtime cause and deploy; no claim that alerts alone repair the failing task |
| Entity/document corrections | Reproduced omitted-field archival reset and case-sensitive alias mismatch | Permission-aware regression tests and integration |
| Finance categories | Owner-only company MCP operations, idempotency and readback; stable School category identities; API and School checks passed | Reconcile live security overlay, review exact token-scope delta, deploy safely, then verify actual category and transaction changes |
| Calendar/Grant | Earlier handoff includes account/source inventory | Recheck real employee access and all attendees; no test invitations; no assumption that unknown is free |
| News/Startups | Wrong destination confirmed; target group currently contains a different bot | Add correct existing bot only as part of verified cutover, bind employee, move the existing schedule; no copied chat history or duplicate schedule |

## Local verification

- `npm run typecheck`: passed for the streaming change.
- `npm test -- tests/knowledge.test.ts tests/history-export.test.ts tests/agent-archive.test.ts`: 37 passed.
- Stress fixture exports 8,000 messages, producing source files larger than 64 MiB, in a Node child with `--max-old-space-size=64`. Full owner and imported histories remain available. This tests one identified unbounded allocation path, not the cause of every past memory incident.
- Derived JSONL publication preserves the previous complete file when iteration fails; permissions remain private. Hidden final imported rows remove their obsolete derived copy. Deleted-only native memory paths are no longer granted; native files remain on disk.

## Deployment constraints

Wolf runs a signing image whose compiled runtime includes a security-sensitive tool absent from main's source. Read-only comparison recovered the exact extra compiled files and dependencies. A clean rebuild of current main would remove that tool. Preserve it during any scoped rollout; recover and reconcile its source before claiming a complete reproducible public release.

Existing Mini-to-WaiClaw and trusted Wolf-to-WaiClaw SSH attempts reject authentication. No available saved Mini connection contains that Home's access. Keep this as an explicit live-validation constraint rather than guessing credentials or reporting the task fixed.

Private source records, model QA responses, token identifiers and deployment receipts stay outside Git. Public work notes record checks and limitations without copying the knowledge corpus.
