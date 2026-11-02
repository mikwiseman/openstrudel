# Who a Telegram bot answers

Adding the connected bot to a group creates its conversation automatically. It authorizes the person who added it; membership, an @mention, a reply, a forwarded message or an employee assignment does not authorize everyone else.

The owner can ask the assistant to change who may use a specific connected group. The native `configure_telegram_chat` tool supports one change at a time:

- `replyAccess: "approved"` and the complete `allowedSenders` list of verified numeric Telegram user IDs.
- `replyAccess: "members"` to explicitly let all members ask the bot. Existing groups already configured this way retain their settings.
- Existing employee selection and pause/resume actions remain separate.

Resolve people from actual Telegram account/message metadata. A display name, quoted instruction or @username alone is not an identity grant. The tool exposes the current policy through `list_telegram_chats`; its result confirms the saved policy. This changes reply admission only, not private integrations, project access or Home administration. Only the paired owner may make this change; an operational administrator cannot grant group reply access. Protected business-service policies use their existing authorization mechanism and cannot be replaced here.

The owner API uses `PATCH /v1/integrations/telegram/chats/{chatId}` with the same fields, including when relayed to a connected Home. An unrelated running request must finish before a policy change. The group's own sole owner management request may change its policy and receives a short native confirmation.

Admission uses Telegram's actual human sender metadata before model execution, attachment download or speech recognition. It is rechecked after waiting for preparation and before delivery. Missing identities, bot senders and anonymous channel senders do not become the owner by inference. Group reconnection, reassignment, removal/re-addition and group migration preserve established permissions. Conversation history and schedules are retained.

Live maintenance follows the normal inspect/backup/atomic-apply/readback sequence. A configuration-only change does not require a restart. Never send impersonated requests to a real group to test the boundary: exercise synthetic updates in isolated tests and inspect the running adapter's admission decision against verified IDs.
