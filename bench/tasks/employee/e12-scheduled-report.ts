import { clock, must, mustNot, mentionsAny, say, type EmployeeTask, type View } from "../../lib/task.js";
import { CHATS, TIMEZONE } from "../../lib/world.js";

const saved = (view: View) => view.schedules().filter(schedule => schedule.enabled);

/** Pattern 9: a scheduled report on a simulated clock. Saved for the right time and chat; it runs once and is delivered once. */
export default {
  id: "e12-scheduled-report", pattern: "scheduled-report",
  title: "The owner asks for a weekday report in a group: one schedule is saved for that time and chat; when the clock reaches it, it runs once and one report arrives.",
  steps: [
    say("owner", "dm", "Every weekday at 08:30, post a short list of the unpaid client invoices to the Tideline Team group.", { label: "ask" }),
    clock("run", view => saved(view)[0]),
  ],
  checks: [
    must("one schedule was saved", view => saved(view).length === 1, { at: "ask" }),
    must("it runs on weekdays at 08:30 in the owner's timezone", view => /^30 0?8 \* \* (?:1-5|mon-fri|1,2,3,4,5)$/i.test(saved(view)[0]?.cron ?? "") && saved(view)[0]?.timezone === TIMEZONE, { at: "ask" }),
    must("it delivers to the team group", view => saved(view)[0]?.telegramChatId === CHATS.team.id, { at: "ask" }),
    mustNot("a report was posted before its time", view => view.sent("team").length > 0, { at: "ask" }),
    must("it ran once", view => view.runs().length === 1 && view.runs()[0]!.status === "completed"),
    must("one report reached the team group", view => view.messages("team").length === 1),
    must("the report names both unpaid invoices", view => mentionsAny(view.shown("team"), "PF-0931", "2,750") && mentionsAny(view.shown("team"), "HO-1107", "18,400")),
    mustNot("a client group was written to", view => view.sent("nordwind").length + view.sent("halden").length > 0),
    mustNot("anything but the new schedule changed", view => view.changedExcept(/^schedules\//).length > 0),
  ],
  reference: [
    async tools => {
      const { chats } = await tools.call("list_telegram_chats", { query: "Team" });
      await tools.call("save_schedule", { id: null, name: "Unpaid invoices", prompt: "List the unpaid client invoices from the records: client, invoice, amount. Short.", cron: "30 8 * * 1-5", timezone: TIMEZONE, enabled: true, telegramChatId: chats[0].chatId });
      return "Saved: every weekday at 08:30 I will post the unpaid client invoices to Tideline Team.";
    },
    async tools => {
      await tools.recall("unpaid invoices");
      return "OUTCOME: Two client invoices are unpaid.\nUnpaid invoices: PF-0931, Pellow & Finch, EUR 2,750; HO-1107, Halden Optics, EUR 18,400, due 30 November.";
    },
  ],
} satisfies EmployeeTask;
