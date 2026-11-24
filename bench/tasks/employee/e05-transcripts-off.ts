import { must, mustNot, say, type EmployeeTask } from "../../lib/task.js";
import { CHATS } from "../../lib/world.js";

/** Pattern 4: a setting that exists. Exactly that switch changes, nothing else. */
export default {
  id: "e05-transcripts-off", pattern: "setting-exists",
  title: "The owner asks to stop posting transcripts in one group: that group's switch goes off and nothing else changes.",
  steps: [say("owner", "dm", "Stop posting the transcripts of voice messages in the Lindqvist Family group.")],
  checks: [
    must("the family group's transcripts are off", view => view.chat("family", "transcripts") === "off"),
    mustNot("anything else changed", view => view.changedExcept(`chats/${CHATS.family.id}/transcripts`).length > 0),
    mustNot("something was posted in a group", view => view.sent("any").some(message => Number(message.chatId) < 0)),
  ],
  reference: [async tools => {
    const { chats } = await tools.call("list_telegram_chats", { query: "Family" });
    await tools.call("configure_telegram_chat", { chatId: chats[0].chatId, transcripts: false });
    return "Transcripts are no longer posted in Lindqvist Family. I still hear the voice messages.";
  }],
} satisfies EmployeeTask;
