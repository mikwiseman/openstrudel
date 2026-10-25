# WAI Core: shared Grok access

The owner asked to let every Wai Core Team participant use the existing
`@wai_core_bridge_bot`, with the same work access as Wolf. This is a continuation
of the [native bridge pilot](telegram-bridge-pilot-2026-10-19.md).

## Native account boundary, verified 19 October

The installed Grok app offers personal Bot creation and account-wide connectors.
Its General settings identify the personal account; no Team Bot setup or per-Bot
connector access control was available in this session. No new Bot, account,
subscription or team was created during the inspection.

The vendor's current documentation confirms that personal Bots share their
account's connectors and hosted computer. Team Bot webhook routines also run in
their owner's context. Publishing a Team Bot does not turn a webhook into a
verified Telegram-participant session. A work-only account is therefore the
supported isolation boundary for this bridge route.

Sources: [connected apps](https://cursor.com/help/grok-bot/connect-apps),
[computer isolation](https://docs.x.ai/grok-bot/teams-and-enterprises#how-users-are-isolated),
[Team Bot routines](https://docs.x.ai/grok-bot/team-bots#routines-on-a-team-bot).

## Prepared WAI connection

The bridge now supports a server-held `waiToken` for one trusted work group.
`wai_tools_list` reads the live canonical MCP schemas. `wai_tool_call` forwards
operations to the same WAI service used by Wolf, with the actual Telegram
sender/message/group from the persisted update. It cannot override those headers
or select a personal endpoint. There is no copied business data or authorization
implementation.

Each native webhook receives a random capability for its request. It expires in
two hours or when the reply is delivered, survives restart, and is not returned
by history/request lookup/status or logged. The bridge rechecks its current
sender allowlist; WAI independently rechecks delegation, project access and
source permissions and records the caller in its existing audit log.

Seven regression tests failed before implementation. The final selected suite
passed 49 tests across bridge delivery, WAI request binding, Telegram MCP context
and continuity. Ten new tests cover two participants, simultaneous calls,
invalid/anonymous senders, identity override attempts, expiry, completed requests,
restart, revoked access, live schema forwarding and uncertain write responses.
The 20 October catalog check also caught legacy WAI tool names without the
company/School prefixes, including Zoom, team meetings and knowledge documents.
A regression test now proves that they reach the canonical service too; tool
authorization remains the service's responsibility, not a second bridge list.
Typecheck, build, JavaScript syntax and whitespace checks pass. Upstream responses in
these tests are controlled fixtures; this is not live team acceptance.

## Activation still pending

The change is prepared for review, not deployed. The live pilot remains
owner-only. The owner has been asked which separate work Grok/Cursor account to
use. The existing Wolf, work/personal connectors, live bridge configuration,
Telegram polling offset and delivery queue were not modified.

After that account is available:

1. Establish the native work Bot with only group-authorized sources. Its hosted
   computer, memories and other connectors must not inherit the personal account.
2. Register a distinct business technical actor in WAI for the existing group.
   Keep its permanent key in the private bridge config, not in Grok.
3. Provide old group history/files through a reader that enforces this single
   group. The owner's unrestricted WAI Telegram connector must not be added.
4. Back up the live config and SQLite queue, deploy the bridge, and update the
   native webhook while preserving the existing Telegram Bot and delivery IDs.
5. Verify work reads and forbidden personal access through that native Bot,
   then admit the group's participants. Confirm a real non-owner's request,
   its WAI audit identity, one Telegram reply and continued Wolf operation.

Only that last readback establishes that the whole team can use the native Grok
Bot. Neither unit tests nor webhook HTTP acceptance establish it.
