# Telegram sender disclosure

The AI-disclosure footer belongs in the actual outbound text that AI sends through Mik's personal Telegram account on his behalf. Messages sent by the connected Telegram bot have no outer footer: direct replies, statuses, scheduled reminders, insights and bot-chat draft previews follow this rule, including discussion of a future message from Mik. Preserve disclosure already inside the exact text explicitly prepared for a personal-account send, without an extra footer on the surrounding bot reply. Do not rewrite existing approved drafts, old messages, or quoted/transcribed text.

On 2 November 2026, an employee behavior update incorrectly required the footer on every AI-authored Telegram reply and scheduled insight. The live root SOUL and employee instructions held that rule. Two older legal reminder clauses also applied it to all reminders. The text was already present in stored model answers before delivery. The deployed bot formatter contained no disclosure append hook or code overlay.

Use [the maintenance recipe](../../scripts/maintenance/telegram-disclosure-policy.mjs) only on inspected instruction fields. It replaces the three exact obsolete clauses and preserves every other byte. Reapplying it produces no changes. Never apply it to message history, quoted text, draft contents or Telegram formatting; a global footer strip would also remove required personal-send attribution.

This correction used a narrow database transaction because the inspected runtime has no root-SOUL HTTP update, profile PATCH also rewrites a conversation title, and schedule save recomputes timing fields. Prefer native settings APIs when they preserve the required fields; this one-off recipe is not a replacement configuration system.

For a live correction:

1. Record the current image/process identity and the SHA-256 of each affected instruction field. Inspect the actual sender binding and confirm the obsolete clause counts. Do not interrupt active turns.
2. Save a timestamped mode-0600 backup of the affected full records in the existing private maintenance area. Preserve old evidence rather than rewriting earlier snapshots.
3. Under a short SQLite `BEGIN IMMEDIATE` transaction, recheck the inspected hashes and apply only the planned field replacements with compare-and-set predicates. Check exact record/clause counts and compare every other field before committing. Only the root setting's update timestamp may change with its value.
4. Read back the committed fields, confirm the recipe is now a no-op, check integrity and health, and confirm the process did not restart. Roll back the exact affected fields only if validation fails, provided they still equal this operation's new values.
5. Use at most two short private API acceptance turns with no external sends: one bot reply/insight/draft-preview case must omit the footer; one exact personal-account message must include it once. Confirm zero outbound Telegram delivery for those API conversation/message IDs and no send-tool calls. Keep raw prompts/results and record IDs private.

The native runtime reads the saved SOUL for each new request. `src/codex.ts` injects a changed identity into a resumed thread without deleting its history; `tests/codex-identity.test.ts` covers this mechanism. A turn already in progress can finish under the old instructions. No runtime deployment or restart is needed for this correction.

Wolf acceptance on 2 November 2026 changed exactly six records and seven obsolete clauses. All other fields, including schedule timing and delivery, were unchanged. SQLite integrity, native profile readback and a second no-op plan passed; the container image, PID and start time stayed the same. Two private API turns passed: the bot reply/insight/preview contained no footer, and the personal-account outbound text contained it once. Their native session logs recorded zero tool calls, and neither conversation had a Telegram binding, delivery outbox entry or schedule. These are private content checks, not messages sent to Telegram. Each other Home needs its own inspected instruction-state correction; changing runtime code does not update its saved SOUL.

Regression boundaries to preserve:

| Sender / content | Expected disclosure |
| --- | --- |
| Connected bot, ordinary group or direct reply | None |
| Connected bot, native schedule or insight | None |
| Bot showing a generic draft preview | None on the bot reply |
| Exact text prepared for an AI send through Mik's personal account | Once inside the intended message |
| Literal quotation discussing an old footer | Preserve the quoted text |
| Quiet scheduled result | Exactly `NO_REPLY`, no footer |
