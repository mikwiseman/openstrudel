# Telegram bridge

A small standalone transport for an existing agent. Telegram long polling sends addressed text to the agent's native webhook. The agent replies through authenticated MCP tools, or initiates a new Telegram message directly from its own app. No inference provider, copied agent memory or OpenStrudel runtime is required.

Requires Node 24+ and a public HTTPS reverse proxy. Run `node bridge.mjs /private/config.json` using `config.example.json` as the configuration shape. Add `--serve-only` during MCP setup to keep Telegram polling paused. Keep this file private; never commit real keys. Back up the SQLite queue along with configuration. Only one process may poll a bot token.

1. Create a Telegram bot with BotFather and add it to the intended group. Obtain the exact bot and chat IDs from `getMe` and an addressed `getUpdates` message.
2. Create a native agent with a webhook routine. Record the routine's URL and key in the private bridge config. HTTP 200 only means the native run started. For a personal agent whose webhook uses the owner's apps and memory, set `allowedUserIds` to that owner's numeric Telegram ID. Other participants and anonymous senders must not inherit owner access. Omit this allowlist only when the native destination already enforces the intended shared permissions.
3. Connect the HTTPS `/mcp` endpoint using the bridge's bearer token. The plugin manifest, `mcp.json` and skill describe this connection for clients supporting Cursor-format plugins; custom remote MCP setup works without installing the package.
4. Tell the native routine to answer the webhook's `request_id` using `reply_to_telegram`. Confirm that the actual tools are available before polling Telegram.
5. Send `/ask@your_recipes_bot ...` in the group, then reply to the bot's answer. Check both Telegram and the native conversation.
6. In the native app, ask the agent to send a message to Telegram. It uses `send_to_telegram` with a unique delivery key; repeated calls and restarts preserve the same receipt. Native scheduled posts use this tool too, so the bridge needs no scheduler.
7. For an exact earlier answer, use `get_telegram_history` and follow `next_before` if needed. This reads the existing delivery archive in pages of 20, including saved reply text, without sending the whole history on every webhook. It contains only exchanges handled by this bridge; it is not an import of the group's archive or a replacement for native memory.

If the agent already has authorized access to the group's history or files through another connector, let the routine use that connector for reading and this bridge for sending. Keep that group's instructions in its Bot or routine: account-wide connector instructions also affect unrelated Bots. An empty bridge archive does not mean an older group document is missing.

Privacy Mode can stay on: bot commands and replies to the bot work. Plain mentions depend on Telegram's Privacy Mode. Existing bots and scheduled posts remain independent. Incoming images, voice and files are not transported by this pilot.

`/health` is a public process check; authenticated `/status` reports queue states and polling freshness without message bodies. Logs contain request IDs and transitions, never tokens or message text. SQLite persists incoming work before Telegram advances its offset. Confirmed 429/5xx webhook rejections retry; ambiguous webhook delivery and ambiguous Telegram sends stop for inspection instead of duplicating messages. Native routine failures after acceptance are visible in the native conversation; the bridge cannot infer their outcome. `dispatch_unknown` may still be completed by a native callback.

Tests: `npm test -- tests/telegram-bridge.test.ts` from the repository root. They exercise an actual MCP client, chat isolation, duplicate delivery, restart recovery and Telegram's text boundary.

## WAI work access from a verified group request

For WAI, add `waiToken` to the private config. This must be a dedicated technical
actor on the existing `https://waiwai.is/api/mcp/company` service, with
`space: business`, the intended projects, and `trustedGroups` containing exactly
this Telegram group and the owner who delegates its work access. Do not use an
owner-bound personal token. The permanent key stays on the bridge server; it is
never supplied to the native agent. No new WAI backend or copied catalog is needed.

The bridge adds two MCP tools, `wai_tools_list` and `wai_tool_call`. Each dispatched
webhook gets a random `wai_request_token`, valid for two hours and only until its
final reply. Both tools require that token. Telegram sender, group and original
message headers come from the persisted Telegram update, never from tool arguments
or a process-wide "current request". WAI rechecks access and audits the real sender
on each operation. The current bridge allowlist is also rechecked on every call.

Capabilities survive a bridge restart with the delivery queue. They are absent
from request lookup, chat history, health/status and logs. Replaying a delivered
webhook must stop; a native-app `send_to_telegram` does not mint work access.
Business writes use the original WAI preview, revision and mutationKey rules.
The bridge does not retry an uncertain WAI operation.

This protects the **WAI connection**, not the native Bot's other connectors or
computer. Keep `allowedUserIds` owner-only while the webhook executes in a personal
account. For a group bot, use a separate work-only Grok account and verify its
connector/computer isolation before admitting every member. A Team Bot routine
still runs as its owner; publishing a Team Bot alone does not change that.
Never connect the owner's general WAI Telegram credential to that work account:
older group history/files require an independently enforced single-group reader.

Tests: `npm test -- tests/telegram-bridge.test.ts tests/telegram-bridge-wai.test.ts`.
The additional suite uses real MCP clients and covers two participants, concurrent
calls, spoofing, expiry, completed requests, restart, revoked access and uncertain
writes. These tests do not establish live acceptance of a shared native account.
