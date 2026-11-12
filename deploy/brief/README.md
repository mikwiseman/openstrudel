# One morning brief for the owner

Before this, the owner got four messages each morning from four schedules: the main assistant's focus at 07:00, Sales at 08:30, the statistics card at 09:00 and the lawyer at 09:15. The same clients appeared in several of them. Now the employees' morning schedules keep their results on their own pages in the app, and the 07:00 schedule becomes one brief built from them:

1. at most three things for the owner today, each with one action;
2. one line per employee, from the line each result opens with (`OUTCOME:`);
3. one line for what stayed quiet, failed or is still working.

`brief.md` is the prompt of the 07:00 schedule.

## What the server provides

- `read_team`, a tool that reads what every schedule on the Home did since a time. It is offered only where private sources may be read: the main assistant in the owner's own chat, on his own turn, or in a schedule he approved for his private sources. An employee, a group, a colleague and an unapproved schedule never get it.
- The line that opens every scheduled result (`OUTCOME:`), stored with the message as `outcome`.
- The statistics card can stay on the owner's page in the app (`delivery: app`) instead of being posted to Telegram.

## Live steps on a Home

Apply these after the server update. They change live settings.

1. Move the employees' morning schedules to before 07:00 and keep them in the app, for example Sales at 06:30, the lawyer at 06:40 and the statistics card at 06:50, each with `delivery: app`. A run that is still going at 07:00 is named in the brief's last line.
2. Replace the 07:00 focus schedule's prompt with `brief.md`. Keep its time and its delivery to the owner's private chat.
3. **The owner re-approves that schedule for his private sources.** Every edit of a schedule voids its approval, and without it the brief can read neither private sources nor the team. In the app this is the schedule's private sources switch. Through the API it is `GET`, then `POST {"enabled": true, "fingerprint": …}` with the returned fingerprint, on `/v1/conversations/<chat>/schedules/<id>/private-sources`, from an owner's device. It is an access decision, so only the owner makes it.
4. Leave schedules that post to a group as they are. A person whose only morning message is already one (an administrator's own summary, say) needs no change.

## How to check

The next morning, count the scheduled messages to the owner's private chat before 10:00: one, where there were four. The brief names each fact once. Each employee's result is on its page in the app, opening with its line.
