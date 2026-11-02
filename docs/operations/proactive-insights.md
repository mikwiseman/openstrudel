# A useful morning focus

Use the owner's existing morning schedule, conversation and delivery route. The
brief should contain at most three useful actions or decisions, roughly within
1,200 characters. Fewer points are fine. Do not create another schedule, daemon
or state ledger to make the brief more proactive.

Start with the owner's latest direct priorities and recent editions. Check
today's calendar, then follow relevant signals in mail, Telegram, meeting
decisions, contracts, tasks and available employee work. Legal, PR and development
are possible sources, not mandatory daily sections. Read source changes since
the last successful edition, bounded to 72 hours after a missed run, and open the
original evidence and latest human replies for any selected point.

Each point should say what changed and when, why it matters now, and one useful
next step, with a source link. A request to move a meeting is not acceptance;
acceptance is not a calendar update. A prepared or approved draft is not a sent
message. A transcript is secondary evidence, and a later human correction takes
precedence. An old assistant answer does not confirm a current fact.

Connection metadata establishes that a service is configured, not that its
records were read successfully. State the uncertainty that affects a conclusion.
Do not claim an unavailable source was checked, or infer that no event exists
from an incomplete calendar or one page of messages.

## Silence, repetition and automation proposals

Compare with the previous seven days of this schedule's results and the current
conversation history. Revisit a point only for a new answer, a material change or
an approaching confirmed deadline. Do not enumerate unchanged deals, repeat
generic attention warnings, reopen completed work or regenerate approved drafts.
Successful reads with nothing useful produce exactly `NO_REPLY`. If an essential
source failure prevents a reliable edition, return `FAILED: ` and a short reason;
do not turn failed retrieval into a quiet day.

An automation or employee-role proposal counts toward the same three-item limit.
Make at most one in seven days, supported by at least three separately evidenced
instances of a repeated task within fourteen days. Repeated reminders about one
task do not qualify. Cite the dates and sources, identify the repeated step, and
check existing employees and processes first. State the expected practical
benefit without inventing time savings. If history is insufficient, omit the
proposal. Do not create an employee or automation from the scheduled run.

The morning schedule authorizes reading and returning the brief for its existing
delivery route. It does not authorize tool-based messages, calendar changes, CRM
updates, task edits, document changes or schedule changes. Apply the existing
[sender-specific disclosure policy](telegram-disclosure-policy.md): the bot's
brief does not acquire a personal-send footer.

## Source access and configuration changes

Use only sources actually available to the scheduled turn. The current native
owner source catalogue is injected for interactive owner turns; scheduled turns
do not receive that catalogue and its read paths. `read_chat_history` reads the
current conversation. A prompt edit cannot establish access to every private
employee history. Connected source tools and permitted employee results can still
support useful work. Any broader owner-schedule retrieval requires a separate
reviewed product change; never bypass the boundary with arbitrary workspace
reads or elevated flags.

For a prompt-only improvement, inspect the actual schedule and recent results,
save the exact full row in a timestamped private backup, and use a conditional
update against that row. Preserve its identity, name, clock, timezone, enabled
state, next run, destination, conversation and prior runs. Refuse while that
schedule or conversation has active work. If the native save API recomputes the
next run, use the reviewed narrow persistence path to preserve it. Change only
the prompt; no restart is needed.

Read back through storage and the authenticated native API, check health and
verify that repeating the operation reports already applied. On validation
failure, restore only the prompt with an exact after-value guard. Do not erase
later owner changes or history. Keep private source messages and maintenance
receipts outside Git.

## Private acceptance

Use the installed native engine's existing restricted mode in an isolated private
workspace, with sending, writes, apps, MCP, shell, web and network unavailable.
Use the current main instructions and model selection with the exact proposed
prompt. Supply source fixtures as test data, clearly separate from live events.

Check these boundaries before applying:

- A requested reschedule remains pending until the relevant people accept it.
- Later acceptance changes the brief, without claiming a calendar write occurred.
- Unchanged items and completed drafts produce exact `NO_REPLY`.
- Separately evidenced repeated tasks support one proposal for an existing
  employee where suitable; repeated reminders and invented savings do not.
- Essential source failure produces `FAILED:`, not a fabricated brief or silence.

Inspect the text against its sources and audit actual tool calls and delivery
state. This establishes decisions on supplied fixtures. It does not establish
live retrieval, complete cross-employee knowledge or future delivery. Observe the
next real scheduled edition before claiming those outcomes; do not send QA
messages to a real chat.

The 3 November 2026 update passed these five cases with the installed native
engine, with zero tool calls or QA deliveries. Only the existing morning prompt
changed. Storage/API readback, health, idempotency and preservation checks passed;
the next real edition remains the check of live retrieval and delivery.
