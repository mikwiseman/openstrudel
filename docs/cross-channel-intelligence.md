# Personal sources and Telegram drafts

The existing Gmail and Google Calendar apps provide mail and real free/busy reads. Wai Telegram remains the primary Telegram reader and native draft writer. Unipile adds bounded reads for verified LinkedIn and WhatsApp identities through the Home's existing service configuration. The [correspondence workflow](architecture/correspondence-2026-11-05.md) receives source events and uses these readers; it adds no message index or periodic inbox scan.

The upstream Unipile MCP offers a generic `execute_request` tool that can make writes and reach every account permitted by its key. An instruction naming two accounts is not an access boundary. The Home adapter therefore requires all three settings before its first request:

- The `unipile` connector uses `https://developer.unipile.com/mcp`, its existing `X-API-KEY` header, and `disabled_tools = ["execute_request"]`.
- `ownerOnlyServers` in `.data/extensions/all-chats.json` includes `unipile`. Save this before installing the connection. Other owner-chosen sharing settings remain unchanged.
- The existing private Store setting `unipile.accounts` contains an array of `{accountId, provider, providerUserId}` records. Only `linkedin` and `whatsapp` are supported. Copy stable identifiers from a verified owner identity; an account's display name or a phone-only label is not sufficient verification. An absent, empty or malformed allowlist denies reads.

Keep credentials and the actual identifiers out of Git. Do not silently import every account visible to an application-wide key. The provider's alternative scoped-key mechanism requires permanently assigning accounts to a Scope; this implementation does not change that authorization state.

## Runtime integration

`UnipileAdapter(root, store, {owner})` defaults to denied access. The caller sets `owner: true` only from a trusted private read context, never from model arguments, a manager role or the `scheduled` flag alone. It rechecks that caller authorization after awaiting a result. `store` needs only its existing `getSetting` method. There is no new schema or write endpoint.

The caller's predicate must inspect the persisted audience: no group or protected business audience, no employee context, and only the authenticated owner's app conversation or an existing paired owner's private DM. A scheduled read also needs a real running schedule receipt for that conversation and an owner-approved job with an unchanged prompt/destination, delivered only in the app or to that paired owner. Home managers can currently assign jobs to other conversations, so a personal destination by itself does not prove owner authorization. Use existing private settings for an owner-reviewed schedule grant if the runtime has no persisted creator identity. This grants source reads only; it does not enable scheduled configuration changes or message sending.

`accounts()` reads each allowlisted account directly and verifies its exact account ID, provider and provider user ID, running status and unlocked state. It returns the verified name and a source reference. It never enumerates the provider's global account list. `read(input)` accepts the exported `unipileReadSchema`: account ID, `sourceFingerprint`, resource (`inboxes`, `chats` or `messages`), applicable inbox/chat IDs and bounded page/date arguments. LinkedIn chat reads require an inbox. WhatsApp can use its account's chat list. The native tool names used by the skill are `unipile_accounts` and `unipile_read`; server/home-management registration must enforce the same trusted owner/main-chat boundary.

Every request uses fixed `https://api.unipile.com/v2` GET routes. The caller cannot supply a URL, method, account-management request, send request or mark-read request. Redirects are refused. Pages are limited to 50 items and responses to 1 MiB, with a deadline. Errors use fixed messages and response content that echoes the key is refused. Account identity is rechecked before each page; configuration and allowlist changes are checked again before returning it. Fingerprints bind a reference to the credential and exact account identity, so a renamed connection or changed credential cannot silently reuse an old reference.

Results include account/provider identifiers, checked time and source fingerprint; messages retain IDs, source dates, sender direction and edit/delete state. Hidden or deleted message bodies are withheld. Attachments are metadata only, with no signed download URLs. A failed read does not replace an earlier result with an empty list.

Coverage describes one live page, its cursor or offset, total when supplied, and `hasMore`/`complete`, which can be `null`. `complete: true` requires a query beginning at offset zero whose entire reported result fits this page; reaching the last page alone does not prove that earlier pages were read. A short page without authoritative pagination information is not proof of exhaustion. A suggested next offset can be used while coverage remains unknown. Do not call a bounded scan the whole inbox, or the current chat tail the whole history.

## Drafts and meetings

The [cross-channel-intelligence skill](../extensions/cross-channel-intelligence/SKILL.md) combines the existing readers with the event-driven owner workflow. It preserves human and unknown drafts. Updating its own draft requires an exact prior receipt, unchanged live content/bindings, current conversation evidence and post-save readback. On an uncertain result, reconcile before retrying.

Telegram's [`messages.saveDraft`](https://core.telegram.org/method/messages.saveDraft) has no expected revision or hash parameter. The current Wai Telegram writer replaces the draft and returns the submitted text; a separate `list_drafts` read is needed to verify stored state. Checking before saving reduces the race but is not atomic CAS against another Telegram client. A strict guarantee against overwriting a simultaneous manual edit requires leaving the proposal in the app.

Meeting proposals use [Google Calendar free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query), with explicit offset-bearing timestamps and an IANA response timezone. Check every relevant owner and accessible attendee calendar, handle per-calendar errors as unknown availability, and label unverified attendee options tentative. Room availability, an email promise or an old calendar event is not a substitute. Drafting does not create invitations.

## Automatic calendar capture

The same skill supports explicitly authorized automatic calendar capture from Telegram, Gmail, verified LinkedIn/WhatsApp accounts, and work/personal Zoom recordings. Source events enter the owner's main private conversation with app-only results. Authorization binds the source accounts, destination calendar, duration policy and live audience; a real running event receipt is required for private-source tools. One workflow covers both contexts; a second Home must not write the same calendar or draft independently.

The saved request specifies the destination calendar, default duration, timezone policy, scan cadence and source coverage. Only actual agreed future appointments involving the owner become events. Missing dates/times or ambiguous timezone remain pending. A configured duration is labelled as reserved when not agreed. Existing invitations, calendar entries, later corrections and owner deletions are reconciled before writes. Events are private copies without attendees; the workflow neither sends invitations nor provisions Zoom rooms.

Zoom capture runs after the existing recording pipeline makes the transcript available. Recording summaries select passages to read; they do not independently establish agreement. Track pending transcripts and source notification cursors so a late transcript is not skipped because its meeting happened before the latest scan.

`calendar-capture/state.json` in the owner's private workspace holds source cursors, pending decisions and verified calendar receipts. Keep raw messages and transcripts in their source systems. The calendar remains authoritative for deduplication; uncertain writes are read back before retrying. Do not advance a failed source's cursor or call incomplete pagination exhaustive.

Activation requires a real source-to-calendar run and a repeat that finds the existing event. Verify source date/time, preserved call link, privacy, no attendees, and each source's actual event delivery. Skill installation or an accepted test webhook alone is not proof of a live provider subscription.

## Validation and activation

Focused tests cover custom-header validation and persistence, private-service inheritance across audiences, fail-closed policy parsing, allowlisted identity verification, permission/configuration changes, fixed GET routing, blocked URL/write inputs, unknown pagination coverage, source mismatch, secret reflection, response bounds and deadlines. They use synthetic records and fake transport; they never contact private accounts or modify drafts.

Activation separately requires reviewing the private connection diff, verifying owner identities, saving the sharing exclusion and disabled-tool setting before the key is installed, and checking both native tool availability and denial outside the owner's main chat. Keep Telegram drafts and existing schedules unchanged during this read-only acceptance. Source/unit support alone is not a claim that a live connector, schedule or draft workflow has been activated.
