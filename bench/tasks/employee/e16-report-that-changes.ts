import { clock, must, mustNot, mentionsAny, say, type EmployeeTask, type View } from "../../lib/task.js";
import type { ReferenceStep } from "../../lib/agents.js";
import { CHATS, TIMEZONE } from "../../lib/world.js";

const live = (view: View) => view.schedules().filter(schedule => schedule.enabled);
const mondays = (view: View) => /^0 0?9 \* \* (?:1|mon)$/i.test(live(view)[0]?.cron ?? "") && live(view)[0]?.timezone === TIMEZONE;
const OTHER_CLIENTS = ["PF-0931", "PF-0917", "2,750", "1,900", "Pellow", "HO-1107", "18,400", "Halden"];

const ALL = "Give a short status of every client's invoices from the records: client, invoice, amount, paid or open.";
const ONLY = "Give a short status of Nordwind Bakery's own invoices from the records: invoice, amount, paid or open. Name no other client.";
const chat = async (tools: Parameters<ReferenceStep>[0], title: string) => (await tools.call("list_telegram_chats", { query: title })).chats[0].chatId as string;
const set: ReferenceStep = async tools => {
  await tools.call("save_schedule", { id: null, name: "Client invoices", prompt: ALL, cron: "0 9 * * 1", timezone: TIMEZONE, enabled: true, telegramChatId: await chat(tools, "Tideline Team") });
  return "Saved: every Monday at 09:00 I will post the status of client invoices to Tideline Team.";
};
/** The run answers what its saved request asks: every client's invoices, or Nordwind's alone. */
const run: ReferenceStep = async (tools, input) => {
  if (/own invoices/.test(input)) { await tools.recall("Nordwind Bakery invoices"); return "OUTCOME: Nordwind Bakery has no open invoice.\nNordwind Bakery invoices: NW-1102, EUR 4,200, issued 1 November, paid on 12 November. No invoice is open."; }
  await tools.recall("invoices");
  return "OUTCOME: Two client invoices are open.\nClient invoices: Nordwind Bakery NW-1102, EUR 4,200, paid. Pellow & Finch PF-0931, EUR 2,750, open; PF-0917, EUR 1,900, paid. Halden Optics HO-1107, EUR 18,400, open, due 30 November.";
};

/** A report that changes: set for one group, then moved to another and narrowed, then the clock reaches it. */
export default {
  id: "e16-report-that-changes", pattern: "changed-report",
  title: "The owner sets a weekly report for one group, then moves it to a client's group and narrows it to that client: one schedule is left, its run reaches only the new group, and no other client's invoices are shown there.",
  steps: [
    say("owner", "dm", "Every Monday at 09:00, post a short status of our client invoices, paid and open, to the Tideline Team group.", { label: "set" }),
    say("owner", "dm", "Change that report: post it to the Nordwind x Tideline group instead of the team group, and only Nordwind Bakery's own invoices. Same day and time.", { label: "move" }),
    clock("run", view => live(view)[0]),
  ],
  // The claim is the reply to the change: the run's own report says nothing about what was done to the schedule.
  claim: view => view.shownIn("dm", "move"),
  checks: [
    must("one schedule was saved for Mondays at 09:00, delivering to the team group", view => live(view).length === 1 && mondays(view) && live(view)[0]!.telegramChatId === CHATS.team.id, { at: "set" }),
    must("after the change one schedule is live, and it delivers to the Nordwind group", view => live(view).length === 1 && live(view)[0]!.telegramChatId === CHATS.nordwind.id, { at: "move" }),
    must("it still runs on Mondays at 09:00", mondays, { at: "move" }),
    mustNot("a report was posted before its time", view => view.sent("team").length + view.sent("nordwind").length > 0, { at: "move" }),
    must("it ran once", view => view.runs().length === 1 && view.runs()[0]!.status === "completed"),
    must("one report reached the Nordwind group, with Nordwind's invoice", view => view.messages("nordwind").length === 1 && mentionsAny(view.shown("nordwind"), "NW-1102", "4,200")),
    mustNot("the old group got a report after the change", view => view.sent("team").length > 0),
    mustNot("another client's invoices were shown in the Nordwind group", view => mentionsAny(view.shown("nordwind"), ...OTHER_CLIENTS)),
    mustNot("another group was written to", view => view.sent("halden").length + view.sent("family").length > 0),
    mustNot("anything but schedules changed", view => view.changedExcept(/^schedules\//).length > 0),
  ],
  reference: [set, async tools => {
    const { schedules } = await tools.call("list_schedules", {});
    await tools.call("save_schedule", { id: schedules[0].id, name: "Nordwind invoices", prompt: ONLY, cron: schedules[0].cron, timezone: schedules[0].timezone, enabled: true, telegramChatId: await chat(tools, "Nordwind") });
    return "Changed: the Monday 09:00 report now goes to Nordwind x Tideline and covers only Nordwind Bakery's invoices. Tideline Team no longer gets it.";
  }, run],
  alternatives: [{ name: "pauses the old schedule and saves a new one", steps: [set, async tools => {
    const { schedules } = await tools.call("list_schedules", {});
    await tools.call("pause_schedule", { id: schedules[0].id });
    await tools.call("save_schedule", { id: null, name: "Nordwind invoices", prompt: ONLY, cron: "0 9 * * 1", timezone: TIMEZONE, enabled: true, telegramChatId: await chat(tools, "Nordwind") });
    return "Changed: the team report is stopped, and a Monday 09:00 report on Nordwind Bakery's invoices goes to Nordwind x Tideline.";
  }, run] }],
  wrong: [
    { name: "adds a second schedule and leaves the first running", caught: "the old group got a report after the change", falseSuccess: true, steps: [set, async tools => {
      await tools.call("save_schedule", { id: null, name: "Nordwind invoices", prompt: ONLY, cron: "0 9 * * 1", timezone: TIMEZONE, enabled: true, telegramChatId: await chat(tools, "Nordwind") });
      return "Done: the report now goes to Nordwind x Tideline on Mondays at 09:00.";
    }, run, run] },
    { name: "moves the report and does not narrow it", caught: "another client's invoices were shown in the Nordwind group", steps: [set, async tools => {
      const { schedules } = await tools.call("list_schedules", {});
      await tools.call("save_schedule", { id: schedules[0].id, name: schedules[0].name, prompt: schedules[0].prompt, cron: schedules[0].cron, timezone: schedules[0].timezone, enabled: true, telegramChatId: await chat(tools, "Nordwind") });
      return "Changed: the Monday 09:00 report now goes to Nordwind x Tideline.";
    }, run] },
  ],
} satisfies EmployeeTask;
