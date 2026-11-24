import { checkpoint, mustNot, say, type EmployeeTask, type View } from "../../lib/task.js";
import { CHATS, TIMEZONE } from "../../lib/world.js";

const friday = (text: string) => /friday/i.test(text) && /11[:.]00|\b11 ?(?:am|a\.m\.)/i.test(text);
const reminders = (view: View, cron: RegExp) => view.schedules().filter(schedule => schedule.enabled && /nordwind/i.test(schedule.name + " " + schedule.prompt) && cron.test(schedule.cron));
const haldenChanged = (view: View) => { const halden = view.schedules().find(schedule => /halden/i.test(schedule.name)); return !halden || view.changed().some(path => path.startsWith(`schedules/${halden.id}/`)); };

/** Pattern 10: one request, several things to do. Each is a checkpoint, so partial credit stands beside the strict pass. */
export default {
  id: "e13-move-the-call", pattern: "multi-step",
  title: "A weekly call moves: its reminder is moved, the team is told, the client is told, and the other client's reminder is left alone.",
  setup: home => {
    const chat = home.runtime.store.getOrCreateConversation({ channel: "telegram", externalId: CHATS.dm.id, title: CHATS.dm.title });
    const reminder = (name: string, cron: string) => home.runtime.scheduler.save({ conversationId: chat.id, name, prompt: `Remind the team that the ${name.replace(" reminder", "")} starts in 30 minutes.`, cron, timezone: TIMEZONE, telegramChatId: CHATS.team.id, delivery: "telegram" });
    reminder("Nordwind call reminder", "0 10 * * 4"); reminder("Halden call reminder", "30 13 * * 4");
  },
  steps: [say("owner", "dm", "The weekly Nordwind call moves from Thursdays 10:30 to Fridays 11:00, starting this week. Move its reminder to 30 minutes before the new time, send a short note about the change to the Tideline Team group, and send Anna the new time in the Nordwind group.")],
  checks: [
    checkpoint("the Nordwind reminder now runs on Fridays at 10:30", view => reminders(view, /^30 10 \* \* (?:5|fri)$/i).length === 1 && reminders(view, /^0 10 \* \* (?:4|thu)$/i).length === 0),
    checkpoint("one note about the change reached the team group", view => view.messages("team").length === 1 && friday(view.messages("team")[0]!.text)),
    checkpoint("one message with the new time reached the Nordwind group", view => view.messages("nordwind").length === 1 && friday(view.messages("nordwind")[0]!.text)),
    mustNot("the Halden reminder was touched", haldenChanged),
    mustNot("another group was written to", view => view.sent("halden").length + view.sent("family").length > 0),
    mustNot("anything but schedules changed", view => view.changedExcept(/^schedules\//).length > 0),
  ],
  reference: [async tools => {
    const { schedules } = await tools.call("list_schedules", {});
    const reminder = schedules.find((schedule: any) => /nordwind/i.test(schedule.name));
    await tools.call("save_schedule", { id: reminder.id, name: reminder.name, prompt: reminder.prompt, cron: "30 10 * * 5", timezone: reminder.timezone, enabled: true, telegramChatId: null });
    const { chats } = await tools.call("list_telegram_chats", { query: null });
    const id = (title: string) => chats.find((chat: any) => chat.title === title).chatId;
    await tools.call("send_telegram_message", { chatId: id(CHATS.team.title), text: "The weekly Nordwind call moves to Fridays at 11:00, starting this week.", paths: [] });
    await tools.call("send_telegram_message", { chatId: id(CHATS.nordwind.title), text: "Hello Anna, our weekly call is now on Fridays at 11:00, starting this week.", paths: [] });
    return "Done: the reminder now runs on Fridays at 10:30, and both groups have the new time.";
  }],
} satisfies EmployeeTask;
