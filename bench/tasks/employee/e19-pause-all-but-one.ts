import { must, mustNot, say, type EmployeeTask, type View } from "../../lib/task.js";
import type { ReferenceStep } from "../../lib/agents.js";
import { CHATS, TIMEZONE } from "../../lib/world.js";

/** Six reminders of two clients. Two of Nordwind's do not say Nordwind in their names, only in what they ask. */
const REMINDERS = [
  { name: "Nordwind call reminder", cron: "0 10 * * 4", chat: CHATS.team.id, prompt: "Remind the team that the Nordwind Bakery call starts in 30 minutes." },
  { name: "Nordwind invoice reminder", cron: "0 9 1 * *", chat: CHATS.dm.id, prompt: "Remind Mara to issue this month's Nordwind Bakery invoice today." },
  { name: "Prototype check-in", cron: "0 9 * * 1", chat: CHATS.team.id, prompt: "Ask the team how the Nordwind Bakery loyalty-app prototype is going and what blocks it." },
  { name: "Zadar shop visit", cron: "0 9 * * 3", chat: CHATS.dm.id, prompt: "Remind Mara to book the trip to Nordwind Bakery's Zadar shop for the loyalty pilot." },
  { name: "Halden call reminder", cron: "30 13 * * 4", chat: CHATS.team.id, prompt: "Remind the team that the Halden Optics call starts in 30 minutes." },
  { name: "Halden invoice reminder", cron: "0 9 1 * *", chat: CHATS.dm.id, prompt: "Remind Mara to issue this month's Halden Optics invoice today." },
];
const PAUSE = ["Nordwind call reminder", "Prototype check-in", "Zadar shop visit"];

/** A reminder as it is now, found by the id it had before the first message, so a renamed one is still found. */
const now = (view: View, name: string) => { const id = view.schedulesAtStart().find(schedule => schedule.name === name)?.id; return view.schedules().find(schedule => schedule.id === id); };
const idOf = (view: View, name: string) => view.schedulesAtStart().find(schedule => schedule.name === name)!.id;
const touched = (view: View, name: string) => view.changed().some(path => path.startsWith(`schedules/${idOf(view, name)}/`));
const runsUnchanged = (view: View, name: string) => now(view, name)?.enabled === true && !touched(view, name);

const pause = (pick: (schedule: any) => boolean): ReferenceStep => async tools => {
  const { schedules } = await tools.call("list_schedules", {});
  const chosen = schedules.filter(pick);
  for (const schedule of chosen) await tools.call("pause_schedule", { id: schedule.id });
  return `Paused: ${chosen.map((schedule: any) => schedule.name).join(", ")}.`;
};
const nordwind = (schedule: any) => /nordwind/i.test(schedule.name + " " + schedule.prompt);

/** A change to many things with one exception. The reminders are found by what they are about, not by their names. */
export default {
  id: "e19-pause-all-but-one", pattern: "bulk-change",
  title: "Six reminders of two clients; the owner pauses every Nordwind reminder except the invoice one: exactly the three others about Nordwind stop, two of which do not say Nordwind in their names, and nothing else changes.",
  setup: home => {
    const chat = home.runtime.store.getOrCreateConversation({ channel: "telegram", externalId: CHATS.dm.id, title: CHATS.dm.title });
    for (const reminder of REMINDERS) home.runtime.scheduler.save({ conversationId: chat.id, name: reminder.name, prompt: reminder.prompt, cron: reminder.cron, timezone: TIMEZONE, telegramChatId: reminder.chat, delivery: "telegram" });
  },
  steps: [say("owner", "dm", "Pause every Nordwind reminder except the invoice one.")],
  checks: [
    must("the three Nordwind reminders other than the invoice one are paused", view => PAUSE.every(name => now(view, name)?.enabled === false)),
    must("the Nordwind invoice reminder still runs, unchanged", view => runsUnchanged(view, "Nordwind invoice reminder")),
    must("both Halden reminders still run, unchanged", view => runsUnchanged(view, "Halden call reminder") && runsUnchanged(view, "Halden invoice reminder")),
    mustNot("anything but the three paused reminders changed", view => view.changedExcept(...PAUSE.map(name => new RegExp(`^schedules/${idOf(view, name)}/`))).length > 0),
    mustNot("something was posted in a group", view => view.sent("any").some(message => Number(message.chatId) < 0)),
  ],
  reference: [pause(schedule => nordwind(schedule) && !/invoice/i.test(schedule.name))],
  alternatives: [{ name: "turns each off by saving it disabled", steps: [async tools => {
    const { schedules } = await tools.call("list_schedules", {});
    for (const schedule of schedules.filter((item: any) => nordwind(item) && !/invoice/i.test(item.name)))
      await tools.call("save_schedule", { id: schedule.id, name: schedule.name, prompt: schedule.prompt, cron: schedule.cron, timezone: schedule.timezone, enabled: false, telegramChatId: null });
    return "Paused the Nordwind call reminder, the prototype check-in and the Zadar shop visit. The Nordwind invoice reminder still runs.";
  }] }],
  wrong: [
    { name: "goes by the names alone", caught: "the three Nordwind reminders other than the invoice one are paused", falseSuccess: true, steps: [
      async tools => { await pause(schedule => /nordwind/i.test(schedule.name) && !/invoice/i.test(schedule.name))(tools, ""); return "Done: every Nordwind reminder except the invoice one is paused."; }] },
    { name: "pauses the invoice one too", caught: "the Nordwind invoice reminder still runs, unchanged", steps: [pause(nordwind)] },
    { name: "pauses every reminder but the invoice ones", caught: "both Halden reminders still run, unchanged", steps: [pause(schedule => !/invoice/i.test(schedule.name))] },
  ],
} satisfies EmployeeTask;
