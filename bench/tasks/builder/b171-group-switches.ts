import type { BuilderTask } from "./index.js";

/** Pull request 171: a per-group transcript switch, and administrators managing groups from Telegram. */
export default {
  id: "b171-group-switches", pattern: "builder-fix", pr: 171,
  title: "A group gets a real switch for posted transcripts, and a Home administrator manages groups from Telegram as the owner does.",
  base: "032b15ad82201f9b921b16b66c623d94347e8ce7", fix: "a111559b3676b452046b0df31695aa919c562e3e",
  statement: `Two problems with Telegram groups, reported by the owner of a Home.

1. In our family group the bot posts the text of every voice and video message ("📝 …"). We want to switch that off for one group. Today the assistant can only save a text rule about it, and the posts keep coming. Give every connected group a real switch for posted transcripts, on by default. With it off the bot must still hear the recording and act on it; it only stops posting the "📝" message. The same request should also be able to choose when a group is answered: every message, or only a mention or a reply to the bot. That mode exists already but cannot be changed from Telegram.

2. I made a colleague an administrator of the Home (the access.managers list), but from Telegram they still cannot manage groups: choosing who a group answers is refused for anyone but me. And in a group that an administrator connected, my own messages and the other administrator's are ignored, because we are not on that group's list.

What must be true afterwards:
- The configure_telegram_chat tool accepts two more settings, still exactly one setting in a call: transcripts (a boolean) and replies ("all" or "mentions"). Its result returns the chat, whose transcripts field reads "on" or "off"; a chat that was never switched reads "on". replies "all" is stored as the existing "instructions" mode and "mentions" as "mentions".
- list_telegram_chats shows an administrator each chat's replies ("all" or "mentions") and transcripts.
- A Home administrator may use configure_telegram_chat for all of this, including replyAccess with allowedSenders, exactly as the owner may. A person who has only service access, a scheduled run, and an app turn that is not the owner's still may not. Choosing a group's senders never adds an administrator or gives anyone service access.
- In an ordinary group the Home's owner and its administrators are always heard, whoever connected the group and whatever its list says. Nobody else gains anything. An administrator who stops being one while an answer is being written does not receive that answer, and is not heard afterwards unless the group's list names them.

Existing behaviour and the existing tests must keep working.`,
  runner: "vitest",
  hidden_tests: ["tests/telegram-management.test.ts", "tests/telegram-reply-access.test.ts"],
  fail_to_pass: [
    "switches a group's posted transcripts off on an administrator's request, and still hears the voice",
    "lets an administrator choose whether a group is answered always or only when addressed, and reads the switches back",
    "gives a Home administrator the owner's say over who a group answers",
    "only the owner and administrators choose the group senders, without granting services or Home management",
    "withholds a reply from an administrator who stopped being one while the model was running",
    "always hears the Home's owner and administrators in their own groups, and nobody else",
  ],
  pass_to_pass: ["tests/telegram-groups.test.ts", "tests/telegram-tools.test.ts", "tests/home-rules.test.ts"],
  reference_message: "Fixed: a group now has a transcripts switch and a reply mode that configure_telegram_chat can set, and Home administrators manage groups as the owner does. The Telegram tests pass.",
} satisfies BuilderTask;
