# News editorial contract

The News employee finds, checks and writes stories; the application writes and sends its Telegram posts. These four files are the standing profile (`soul.md`), the two schedule prompts (`radar.md`, `morning.md`) and the workspace skill (`SKILL.md`). They do not create services or schedules.

The radar runs every hour at :05 from 08:05 to 02:05 Moscow time. It reads the collectors' queue from the chat's previous successful run, which the scheduler names in its request, ranked by evidence so the strongest stories come first, makes at most two searches of its own, and publishes each story with `publish_story`. The story's `telegram` field decides how it reaches the reader's chat: `alert` with sound, `card` silently, `null` for the app and the edition only. The application writes the post from the story (title, summary, view, sources), sends it once, sends a development as a reply under the first post, and allows two alerts a day in the owner's daytime.

The edition runs at 06:45. It reads the day's queue, the night's queue and the reference lane, includes every story that two or more reference sources carried, and publishes one selection with `publish_edition`. The application sends that day's edition once as one rich message: the lead stories in full, the rest under their sections, each opening to its summary.

`read_news` gives one line per story with stable story IDs, whether the application has posted it and what readers left on the post; with a `storyId` it gives the complete story. Telegram delivers reactions from a group only to a bot that is an administrator there. The collectors' claim commands are no longer part of the work.

Apply only to the selected News profile and its existing schedules, with a snapshot and a comparison against the current values. Preserve the schedule IDs, time zone, delivery destination and enabled state. The runtime must expose `publish_story` with the `telegram` field before the prompts are applied. Keep the existing skill's scripts in place when replacing SKILL.md.

Acceptance: send the first rendered card and edition to the owner's private chat and look at them on a phone and a desktop before the reader's group gets one; examine the selected stories against primary sources; confirm a development arrives as a reply and a repeated run sends nothing twice; verify the rendered app and an ordinary scheduled run. Measure actual discovery and delivery times; a passing preview does not establish exhaustive coverage or long-term reliability.
