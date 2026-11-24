# Weekly insights against the owner's goals

Once a week the main assistant tells the owner what in the past week moved one of his recorded goals, works against one, or needs a decision. It sends at most three insights and stays silent when it has none.

The goals are never guessed. They live in a note the owner can read and correct, and an insight may only speak about a goal that is in that note.

## The parts

- `goals.md` in the main assistant's workspace: what the owner (and a partner, on a work Home) said they want, in their own words, each line with its date and source. It also holds what they said they do not want, where the partners differ, and what is not on record. The note's text is private and never part of this repository.
- One line in the workspace's `MEMORY.md` that points to the note and says to judge what matters by it. The Home gives `MEMORY.md` to every turn, so the morning brief and ordinary answers see the goals too.
- `insights.md`: the prompt of the weekly schedule.

## What makes an insight worth sending

The prompt holds four tests, and an insight must pass all of them:

1. It is about one goal of the note, named in plain words.
2. Every fact in it is an exact quote or a figure copied from a record of the period, with the record's date and link. Who is responsible, how long something takes and what was promised count as facts.
3. It says something the owner did not already say that week: a change, a contradiction between a goal and what was done, a promise with no next step, a goal with no record at all, two goals pulling against each other.
4. It ends with one action for the week that takes under an hour, or one decision with two options.

When nothing passes, the run returns `NO_REPLY` and the owner gets no message.

## Live steps on a Home

1. Write `goals.md` into the main assistant's workspace and add the pointer line to `MEMORY.md`. Keep a copy of `MEMORY.md` from before.
2. Create a weekly schedule in the owner's main chat with `insights.md` as its prompt, delivered to his private chat. Create it paused.
3. **The owner allows the schedule to read his private sources and switches it on.** In the app this is the schedule's private sources switch. It is an access decision, so only the owner makes it. Without it the run cannot read the memories.

## How it was measured

The prompt was run with the goals note and the memories connected, on a period of two real weeks. A script then checked every message the way a careful reader would:

- by code: how many insights, how long, and whether every quote in «» stands word for word in a record the run opened;
- by a judge model that sees the goals note and the pieces of the opened records nearest to each insight: which goal the insight names, whether every fact in it is supported, whether it says something new, whether it ends with one action or decision, and how many sentences carry nothing.

The first versions of the prompt wrote insights that read well and still failed the support check: one fact was real, and a second one (who had taken a task, how long a plan was) was the model's reading stated as a fact. Another named the wrong speaker, and another judged a working hour by a time zone the records did not hold. The second test, the rule about speakers and hours, and the final check in the prompt exist because of that.

| Prompt | Insights written | Kept by the checks |
| --- | --- | --- |
| first | 5 | 0 |
| second | 4 | 0 |
| this one | 4 | 4 |

The last row is two runs for each of two goals notes. Four is a small number: watch the first real runs before trusting it.

## How to check on a Home

After the first run, open each link in the message and find each quote in its record. An insight whose quote is not in the record is a fault of the prompt: report it and tighten the test it slipped through.
