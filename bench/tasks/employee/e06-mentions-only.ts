import { must, mustNot, say, type EmployeeTask } from "../../lib/task.js";
import { CHATS } from "../../lib/world.js";

/** Pattern 4: a setting that exists, in another group and of another kind. */
export default {
  id: "e06-mentions-only", pattern: "setting-exists",
  title: "The owner asks a group to be answered only on a mention: that group's reply mode changes and nothing else does.",
  steps: [say("owner", "dm", "In the Tideline Team group, answer only when someone mentions you.")],
  checks: [
    must("the team group answers only a mention", view => view.chat("team", "replies") === "mentions"),
    mustNot("anything else changed", view => view.changedExcept(`chats/${CHATS.team.id}/replies`).length > 0),
    mustNot("something was posted in a group", view => view.sent("any").some(message => Number(message.chatId) < 0)),
  ],
  reference: [async tools => {
    const { chats } = await tools.call("list_telegram_chats", { query: "Team" });
    await tools.call("configure_telegram_chat", { chatId: chats[0].chatId, replies: "mentions" });
    return "In Tideline Team I now answer only a mention or a reply to my message.";
  }],
} satisfies EmployeeTask;
