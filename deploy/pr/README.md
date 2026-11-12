# PR employee

An employee that keeps the owner visible: it finds stages worth speaking on, remembers every deadline the team accepted, and brings post ideas written in the owner's voice. It prepares; people decide, submit and publish.

- `soul.md` is the employee's profile: what counts as useful, the calendar's format, the rules for deadlines and post ideas, the voice in short, and what it never does.
- `week.md` is the Monday schedule: update the calendar and ask for decisions.
- `posts.md` is the Tuesday and Thursday schedule: two or three post ideas.

## Rhythm

Three mornings a week, 09:00 in the owner's time zone, into the team's group. At most one message a run, and none when there is nothing to decide or do.

| Day | Run | Message |
|---|---|---|
| Monday | `week.md` | Deadlines of this week and one new opportunity, the best one still unanswered |
| Tuesday, Thursday | `posts.md` | Two or three post ideas: title, the point, opening lines, sources; one of them also for LinkedIn. One ready post instead when the channel has been silent for five days |

One decision per run is asked as a card (`raise_card`, kind `answer`), shown right after the message with its answers as buttons: «Идём на …?» with «Да», «Нет», «Позже». A press comes back to the employee's own conversation, where it marks the calendar at once and prepares the next step. Words in reply to the card or to a delivered report come back the same way. A card that still waits is not raised again; one that is out of date is closed with `close_card`.

Why not daily. The first version ran every morning for twelve days and sent three to five items each time: meetups a day away, paid awards nobody had chosen, early price stages. Nobody answered one of them. Calls for speakers and awards move in weeks, so one checked list a week is enough, and a deadline still gets its reminder: every run first looks at what expires before the next run. Posts follow the pace the owner really publishes at, about two a week.

## What it keeps

All private facts live in the employee's working folder on the Home, not in this repository:

- `pr/brief.md`: the people, where the team is in the coming weeks, geography and talk topics, dated decisions, the addresses of the channel and of the team's tracker.
- `pr/calendar.md`: the one living list, four tables: commitments, to decide, waiting, archive. One opportunity is one row with its date, place, format, deadline, why it fits, status, link and the date it was last checked at the organiser's page.
- `pr/posts.md`: every idea it offered and what became of it.

The owner's voice comes from the skill `wisemantalks`, installed for this employee: how he writes, with his published posts as examples. The prompts name the skill and do not copy it.

## What it needs from the Home

- `read_news` with `desk`: an employee reads a colleague's reader (`desk: "News"`), so post ideas start from stories that are already checked. Employees of one domain read each other's desks.
- Delivery to a group that belongs to the main assistant, and replies to a delivered report routed back to the employee's conversation. A message in the group that is not a reply does not reach the employee.
- A web search and page reading for organisers' pages, and the public preview page of the owner's channel for views and reactions.

## Apply

Set the profile's instructions from `soul.md`, keep the existing employee, its conversation and its delivery group. The old daily schedule becomes the Monday one (same id, new name, prompt and cron `0 9 * * 1`); add the Tuesday and Thursday one (`0 9 * * 2,4`). Take a snapshot of the profile and schedules first.

Acceptance: run each schedule once into the owner's private chat and read the result on a phone and on the employee's page in the app. Check three calendar rows against the organisers' pages, check that a second run repeats nothing, and that a quiet day stays quiet.
