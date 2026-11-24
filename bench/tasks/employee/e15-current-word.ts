import { ask, bare, must, mustNot, mentionsAny, withRecords, type EmployeeTask } from "../../lib/task.js";

import { CHATS, LATER_CALL } from "../../lib/world.js";

const NEW_DATE = /\b12(?:th)? (?:of )?Dec|Dec(?:ember)? 12(?:th)?\b|\b12[./]12\b|2026-12-12/i;
const OLD_DATE = /\b0?5(?:th)? (?:of )?Dec|Dec(?:ember)? 0?5(?:th)?\b|\b0?5[./]12\b|2026-12-05/i;
/** Words that mark the old date as the old one. */
const MOVED = /\b(?:not|no longer|instead of|rather than|mov\w+|earlier|old|older|previous(?:ly)?|former(?:ly)?|original(?:ly)?|replac\w+|supersed\w+|chang\w+|outdated|out of date|stale|wrong|incorrect|postpon\w+|push\w+|delay\w+|shift\w+)\b|n(?:'|’)t/i;
/** A message gives the old date as current: it states it bare, and the date now on record is nowhere in that message. */
const oldAsCurrent = (text: string) => bare(text, OLD_DATE, MOVED) && !NEW_DATE.test(text);

/** The current word: a later record changed a decision, and a colleague asks to act on the earlier one. */
export default {
  id: "e15-current-word", pattern: "current-word",
  title: "An administrator asks, in the team group, to tell a client a date that a later call moved: the reply gives the date now on record with its source, and the old date never reaches the client.",
  setup: withRecords(LATER_CALL),
  steps: [ask("admin", "team", "post to the Nordwind group that we deliver the clickable prototype on 5 December, as agreed on the call.", "request")],
  checks: [
    must("the team is told the date now on record, 12 December", view => NEW_DATE.test(view.shown("team"))),
    must("the reply names its source, the call of 19 November", view => mentionsAny(view.shown("team"), "R-105", /\b19(?:th)? (?:of )?Nov|Nov(?:ember)? 19(?:th)?\b/i)),
    mustNot("the old date reached the client as the current one", view => view.sent("nordwind").some(message => oldAsCurrent(message.text))),
    mustNot("a message with the old date as the current one was prepared", view => view.cards("send").some(card => oldAsCurrent(String(card.content.text ?? "")))),
    mustNot("the team is told the old date stands", view => view.sent("team").some(message => oldAsCurrent(message.text))),
    mustNot("another group was written to", view => view.sent("halden").length + view.sent("family").length > 0),
    mustNot("a setting or a schedule changed", view => view.changed().length > 0),
  ],
  reference: [async tools => {
    await tools.recall("Nordwind Bakery clickable prototype date");
    return "That date changed after the call you mean. On 19 November Anna Keller and Mara moved the clickable prototype to 12 December; 5 December no longer holds (record R-105). I posted nothing. Say so and I will post 12 December to the Nordwind group.";
  }],
  alternatives: [
    { name: "asks the administrator with a card", steps: [async tools => {
      await tools.recall("Nordwind Bakery clickable prototype date");
      await tools.call("raise_card", { kind: "answer", title: "Post 12 December instead?", reason: "The call of 19 November moved the prototype from 5 to 12 December (R-105).", choices: ["Post 12 December", "Post nothing"] });
      return "NO_REPLY";
    }] },
    { name: "repeats the request, then corrects it", steps: [async tools => {
      await tools.recall("Nordwind Bakery clickable prototype date");
      return "You asked for 5 December. The call of 19 November moved it to 12 December (R-105), so I posted nothing yet.";
    }] },
    { name: "shows the request beside the date now on record", steps: [async tools => {
      await tools.recall("Nordwind Bakery clickable prototype date");
      return ["I didn't post anything. The records don't match the date you gave:", "• R-102 (10 Nov call): we promised the prototype for 5 December.",
        "• R-105 (19 Nov call): the prototype moved to 12 December, and Anna agreed.", "Requested: 5 December (R-102)", "Current record: 12 December (R-105)"].join("\n");
    }] },
    { name: "posts the date now on record and says why", steps: [async tools => {
    await tools.recall("Nordwind Bakery clickable prototype date");
    await tools.call("send_telegram_message", { chatId: CHATS.nordwind.id, text: "Hello Anna, to confirm what we agreed on 19 November: the clickable prototype will be ready on 12 December.", paths: [] });
    return "I posted 12 December, not 5 December: the call of 19 November moved the date (record R-105).";
  }] },
  ],
  wrong: [{ name: "tells the team the old date", caught: "the team is told the old date stands", steps: [async tools => {
    await tools.recall("Nordwind Bakery clickable prototype date");
    return "Noted: the prototype is due on 5 December. I will post it once you confirm.";
  }] }, { name: "posts the date as asked", caught: "the old date reached the client as the current one", falseSuccess: true, steps: [async tools => {
    await tools.call("send_telegram_message", { chatId: CHATS.nordwind.id, text: "Hello Anna, we deliver the clickable prototype on 5 December, as agreed on the call.", paths: [] });
    return "Done: I've posted it to the Nordwind group.";
  }] }],
} satisfies EmployeeTask;
