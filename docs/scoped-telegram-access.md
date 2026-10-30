# Scoped Telegram access

Home owners can restrict Telegram participants independently of the broad
`access.people` list. The server applies both a person's grant and the audience's
policy. A paired owner is still subject to a protected group's policy.

`GET/PUT /v1/settings/telegram-authorization` is owner-only. GET omits connector
headers; PUT preserves omitted headers on an existing connector ID only while its
URL is unchanged. A new URL needs its own `headers` (400 otherwise). PUT requires
the current `revision` and an idle message queue, except a change that only
switches existing subjects or chats to `enabled: false`: revocation is accepted
while turns run, and those turns are revoked at their next policy check. PUT
increments the revision.
Existing subjects/chats cannot be removed: revoke them with `enabled: false` so
that an old owner grant cannot silently become effective again.

PUT atomically provisions missing private and group registry entries, including
disabled entries, and sets their legacy transport to `access: approved` with
an empty `allowedSenders`. No pairing link, message or Bot API polling is needed.
A new group gets a generic `Telegram <chatId>` title (renamed on its next real
update), `replies: mentions`, and its canonical restricted conversation. The
bot must already be a member of that Telegram group. Existing titles, employee
bindings, conversations and history stay in place. A protected group always
answers only an `@mention` or a reply to the bot: its stored reply mode becomes
`mentions`, and the adapter applies this even if an older row says otherwise.
Repeated PUTs reuse the same registry entry and conversation. Existing paused
groups stay paused; policy `enabled: false` always prevents responses. Pausing
a protected group is accepted while it is answering.

The current adapter admits real Telegram senders to enabled protected audiences
through the scoped policy, independently of the empty legacy sender list.
Globally disabled subjects remain denied in a protected group. Link, bind,
discovery and restored group snapshots cannot recreate legacy grants while a
policy is configured. Ordinary unconfigured groups and owner DMs keep their
existing behavior.

Example with synthetic IDs and tool names:

```json
{
  "version": 1,
  "revision": 0,
  "connectors": {
    "private": {"url": "https://service.example/mcp", "headers": {"Authorization": "Bearer <limited-transport>"}},
    "family": {"url": "https://service.example/mcp", "headers": {"Authorization": "Bearer <family-transport>"}}
  },
  "policies": {
    "mentor": {"connectorId": "private", "tools": [
      {"name": "mentor_schedule", "capability": "schedule.read"},
      {"name": "mentor_move", "capability": "schedule.move"},
      {"name": "mentor_draft", "capability": "draft.read"}
    ]},
    "family": {"connectorId": "family", "tools": [
      {"name": "family_schedule", "capability": "schedule.read"},
      {"name": "family_move", "capability": "schedule.move"}
    ]}
  },
  "subjects": {
    "222": {"enabled": true, "privatePolicyId": "mentor", "capabilities": ["schedule.read", "schedule.move", "draft.read"]}
  },
  "chats": {
    "-100222": {"enabled": true, "policyId": "family", "defaultCapabilities": ["schedule.read"],
      "members": {"111": ["schedule.read", "schedule.move"], "222": ["schedule.read", "schedule.move"]}}
  }
}
```

Capabilities are exact strings, not wildcards. The effective group tools are
those permitted by its member/default grant and, for a limited person, their
global subject grant. A limited person cannot use an unconfigured group. Their
private conversation is provisioned without owner pairing and cannot redeem
an owner pairing link. The ordinary app/API cannot forge Telegram identity.

Business services remain the final authority. They must validate the verified
sender, chat and requested resource on every call. For a mentor, a grant to
`schedule.read` does not itself grant any pupil; the service must check the
current mentor assignment. Family endpoints must never return private drafts,
preview bearer URLs, financial data or internal review notes, even for owners.
Use restricted transport credentials, not an owner's corporate credential.

Protected turns use a fresh, isolated Codex 0.156.1 execution context with a
read-only workspace, no command network, no shell, apps, plugins, shared
memories, ordinary native Home tools or provider fallback. Only policy-listed
MCP tools are proxied by the server, with verified Telegram identity and a
current-policy check at execution. Transport credentials never enter the model
configuration or tool arguments. The model cannot administer Home, create
Home schedules or send to another chat through this route.

A protected turn answers one bounded question with a few business tool calls.
Unless the owner chose a model for that chat, it runs the device's model and
reasoning level at Fast speed where the model offers it (`models.restricted`,
default `{"reasoningEffort":null,"fast":true}`). The device owner changes it with
`POST /v1/settings/models` and `restricted: {reasoningEffort, fast}`: a level
such as `high` or `low` answers two to three times faster but searches lesson
recordings less deeply (measured 30.10.2026), `fast: false` keeps the ordinary
speed, and `restricted: null` restores the default. A level the model does not
offer falls back to the model's own. Isolation does not depend on this choice.

Old conversations remain stored for the owner. They are not loaded into the
restricted runtime. Limited follow-ups can use the same sender's recent input
and Telegram's quoted reply; previous assistant/tool output is not replayed.
This avoids disclosing an old draft after a pupil changes mentors. Ask for the
current schedule/report again when context is missing. File attachments are not
supported by this route yet; ordinary text and transcribed voice are supported.
In a protected audience nothing is downloaded or transcribed unless the message
addresses the bot, and photos or other files are never downloaded: an
unaddressed voice note is not stored at all, an attachment's caption is.

Business refusals reach the model as `{ok:false, code, text}`: a lower-case
service code and the service's own short plain text (control characters
removed, at most 500 characters; JSON payloads are never relayed as text).
`invalid_arguments` may include up to five short issues. Anything else becomes
`unavailable`. Every configured connector header value (and its Base64,
Base64url, URI- and JSON-escaped forms) is treated as a credential: a response
containing one fails closed. The service session header names both the audience
and the verified sender (`openstrudel:<conversation>:<user>`), so a service never
shares state between participants of one group.

Messages persist verified sender, chat, source message ID and policy fingerprint.
Queued work and final delivery are rechecked, including each photo batch and file.
Completed requests cannot replay old private output. A Telegram message ID names
its chat: no app/API message may claim a protected chat's or a limited person's
message ID, and approval cards are never posted to a protected audience. Model
turns (including the owner's) and the notification hook cannot send to a
protected audience; only its own verified answers reach it, and the owner can
still reply manually from the app. Scheduled delivery is refused there too.
A protected conversation holds at most five queued or running turns: a further
message is kept as context without a turn, and a burst beyond ten is refused.
A failed protected turn is never explained in the group; the owner gets one
private notice per incident. Telegram group migration preserves a disabled policy for
the new address until its business binding is configured and enabled. Policy,
legacy transport protection and registry migration commit together. A target
already discovered with member access is closed even when the source registry
row is missing.

Deployment does not enable any policy automatically. Configure and test the
business transport first, then the Home policy, then the group. Test allowed
and denied reads/writes, current assignment revocation, private/group audience
boundaries, queued/replayed work and owner regression. No automatic report
approval, publication or delivery is introduced by this change.

Older Homes reject the provisioned protected chats through their existing
`approved`/empty-senders predicate. Private registry rows also prevent their
legacy `telegram.linked_chats` migration from recreating owner access. This is
defense for existing bindings, not support for administering scoped access in
an old Home: an old pairing or remove/re-add flow can overwrite those rows, and
old Homes cannot enforce a person's policy in other unconfigured groups.
Before rollback, still disable protected Telegram chats and limited DMs, remove
old broad grants, and do not re-pair or re-register them on the old version.
Keep the additive identity audit table and preserved conversation history.
