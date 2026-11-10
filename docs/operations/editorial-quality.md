# PR, News and Startups editorial quality

The goal is useful, verifiable work that builds on earlier work. More cards, more
conference listings or a longer prompt do not establish better editorial quality.
Use the employee's existing identity, workspace, history, schedules and delivery
ledger. Keep private source material and operational receipts outside Git.

## PR: an argument and a suitable publication

PR should propose original articles, columns, expert comments, interviews and
talks, alongside relevant awards and commitments. A useful proposal identifies:

- A specific reader and problem, and one clear argument with something new to say.
- Evidence from actual work, or the exact missing evidence needed to support it.
- A publication and format whose current rules and recent coverage fit the idea.
- A small next step that respects the owner's current priorities.

Verify claims about results, customers, money and performance against original
sources. Do not turn a promising hypothesis into an achieved case study. Private
client material needs permission before publication. Distinguish editorial
submission, self-publication and paid promotion; a contact form is not acceptance.

Compare proposed ideas by argument, audience, case and venue. A new headline for
the same idea is not a new proposal. Revisit it when evidence, an editor's answer
or a human decision changes. Do not fill a daily quota.

Keep selected and paid commitments visible. For a paid or explicitly chosen
application, retain the established deadline reminders and completion state.
An unselected paid opportunity should not reappear at every early-price stage.
An absent answer is an unknown decision. Preserve the existing watch ledger,
including past deliveries; do not create a parallel tracker or erase history.

The current publisher rules are part of the research. Cossa asks for original,
useful cases and columns; HBR expects a distinctive argument backed by evidence
and useful to its readership. Habr's rules distinguish knowledge sharing from
promotion, and its Sandbox rejects generated material. An assistant can prepare
research and an outline without pretending that the venue accepts an AI-written
submission. Check the applicable route before proposing it:
[Cossa](https://www.cossa.ru/rules/),
[HBR](https://hbr.org/guidelines-for-authors),
[Habr rules](https://habr.com/ru/docs/help/rules/) and
[Sandbox](https://habr.com/ru/docs/help/sandbox/).

## News and Startups: a compact selection check

Before selecting a story, establish six things:

1. **Development and date.** What changed, and when? Discovery time is separate
   from the event's date. A newly indexed old page is not a fresh announcement.
2. **Evidence.** Which original source was actually read? Label a secondary
   account when the original is unavailable. Syndicated copies are one source;
   a company's benchmark remains its claim.
3. **Novelty.** What is new compared with the delivered event, even if its URL or
   headline changed? A material development updates the existing story identity.
4. **Reader value.** What new capability, practical use, consequential change or
   well-supported surprise makes this worth attention? Do not force every story
   into a private client project.
5. **Interpretation and limits.** Keep reported facts, company claims and our
   interpretation distinct. Name the uncertainty that affects the conclusion.
6. **Useful outcome.** A small experiment, decision or insight should be clear
   when the evidence supports one. Generic advice and filler are unnecessary.

This is an editing check, not a numeric score or a mandatory number of stories.
Interesting science, smaller teams and unexpected uses deserve attention even
without a famous brand or many likes. Routine price changes and weak updates can
wait for the digest or be omitted. Do not increase radar frequency to compensate
for weak selection.

For Startups, discovery sites such as Product Hunt, HN, YC and Alliance lead to
the maker's site, repository or documentation. Link the verified original when
describing license, deployment, price or permissions. Explain whom the product
helps, the particular new development and the meaningful difference from a
familiar alternative. A shortlist should say what to examine first and why;
never imply a test was performed when it was only proposed. Votes do not prove
demand, letters of intent do not prove revenue, and a large company's feature
is not an independent startup.

Use existing `read_news`, stable story IDs, `view`, `verification`, sources and
`publish_edition`. The application writes and sends a story's Telegram post and
the edition from those fields, once each, and reports what went out. Unknown
delivery is not a reason to retry. A successful search with nothing useful can be quiet; an essential
source failure must not masquerade as a quiet day. Apply the
[sender-specific disclosure policy](telegram-disclosure-policy.md) to future
output, without rewriting approved drafts or old messages.

These standards follow primary newsroom guidance on accuracy, attribution and
separating fact from opinion. [Reuters standards](https://reutersagency.com/about/standards-values/)
put accuracy ahead of speed. The official Grok Bot
[skills and routines guide](https://docs.x.ai/grok-bot/skills-routines-and-automations)
similarly recommends proving a task before automating it and checking current
inputs, completion, failure behavior and approval boundaries. Its
[workflow examples](https://x.ai/bot/guides/grok-bot-101) show concrete work built
around the owner's interests. These are useful comparison criteria, not evidence
that one product's generated output is inherently better. Sources checked on
2 November 2026.

## Bounded configuration and acceptance

Inspect recent actual output and the current role, brief, skill, schedule and
delivery state before editing. A strong existing rule that is not followed needs
diagnosis; adding another copy may create conflicts. Verify the live Home and
canonical employee before a routing change. An inactive imported employee is
not an authorized duplicate publication route.

For a PR scope correction, the small change is the existing profile's purpose
and instructions, its brief and the existing daily prompt. Preserve unrelated
instructions, schedule identity/name/time/timezone/next-run/destination, access,
committed deadlines, ledger and history. Keep the disclosure policy intact.

Use a timestamped private backup and exact compare-and-swap preconditions. Refuse
to apply while that employee has active or queued work. If the native update API
would change unrelated fields, use the reviewed narrow persistence path instead.
SQLite and a workspace file do not share a transaction: combine the database
transaction with atomic file replacement and conditional restoration on failure.
Read back all changed fields through storage and the native API; a repeat plan
must report already applied. A configuration-only change needs no service restart.

Exercise the actual native engine in an isolated private preview with sending
and publishing absent. The existing restricted engine mode can evaluate supplied
source fixtures without apps, MCP, shell or network. Useful acceptance cases are:

- Repeated unselected opportunities and a renamed old argument produce no post.
- New evidence produces a concrete angle, venue fit and small next step, while
  a real committed deadline remains visible.
- An unavailable required source produces an explicit failure, without invented
  research or a false claim of completion.
- A repeated event is deduplicated across sources; a real new fact retains its
  story identity and names the change.

Inspect the result against the sources and audit actual tool calls and delivery
state. Fixture acceptance establishes editorial decisions; it does not establish
live retrieval, correct routing or later scheduled delivery. Observe subsequent
real editions before claiming an improvement. Never send QA messages to a real
group or submit articles, applications or outreach as part of this check.

The 2 November PR correction followed this scope and passed the private native
acceptance. News/Startups selection improvements remain a proposal until their
current live configuration and delivery owner can be inspected; no duplicate
schedule or replacement publication route was enabled.
