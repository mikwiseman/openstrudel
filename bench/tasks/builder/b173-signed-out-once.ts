import type { BuilderTask } from "./index.js";

/** Pull request 173: a signed-out model account is said once, and a failure's cause is named for the apps. */
export default {
  id: "b173-signed-out-once", pattern: "builder-fix", pr: 173,
  title: "A signed-out model account raises one card and one line, not one per schedule, and a failing schedule carries its cause as a code.",
  base: "806e2963f9eb03c1529a5c136e63cd5da7d7fbb3", fix: "d82f04e16d24a2bc22b338e33966e118ff0161cd",
  statement: `Reported by the owner of a Home with several scheduled employees.

When the model account gets signed out, every schedule fails on its own. I get a separate "did not come" card and a notice for every schedule, every hour, and the group that waits for the editions is told again each time. One cause should be said once.

What must be true afterwards:
- While scheduled runs fail because the model account needs a sign-in, the owner has exactly one open card for it, of kind failed, with the title «Нужен вход в аккаунт модели» and a reason that names the employees that are stopped, each once: «Не работают: News и Sales.» The card's content carries the cause as a code: code "sign_in". It is shown once in the owner's private Telegram chat, and these failures add no separate notice to the main chat.
- A Telegram chat that waits for an employee's editions hears it once for the whole outage, in one line with nothing to press, with that employee's name: «News не работает: нужен вход в аккаунт модели. Владелец знает; всё вернётся само.» Later failed runs of the same outage, also on the next day and of another schedule of the same employee, add nothing there.
- When a scheduled run works again, the card closes by itself. A later outage is news again: a new card, and the waiting chat is told again.
- The apps need the cause of a failing schedule as a code, so that they can word it in their own language. In the schedule overview (the list of recurring schedules, each with failure { since, reason }), failure gains code: null when the failed run recorded no error text, "limit" when the model's limit ran out (for example the error «Закончился лимит модели.»), "sign_in" when the account needs a sign-in, and otherwise the Home's existing problem code for that error.

Existing behaviour and the existing tests must keep working.`,
  runner: "vitest",
  hidden_tests: ["tests/cards.test.ts", "tests/statistics.test.ts"],
  fail_to_pass: [
    "says a signed-out model account once: one card for the owner that names who is stopped, one line in a chat that waits, closed when it works again",
    "lists every recurring schedule with its chat and this week's runs and cost, for the owner only",
  ],
  pass_to_pass: ["tests/scheduler.test.ts", "tests/operations.test.ts"],
  // Fails on this machine before and after the fix, and on current main: it depends on the local speech setup.
  not_required: ["closes the Telegram voice incident only after recognition succeeds, even if the following task fails"],
  reference_message: "Fixed: a signed-out account now raises one card that names the stopped employees and one line in a waiting chat, it closes when a run works again, and a failing schedule carries its cause as a code. The cards and statistics tests pass.",
} satisfies BuilderTask;
