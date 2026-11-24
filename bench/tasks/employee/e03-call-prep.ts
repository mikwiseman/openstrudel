import { bare, must, mustNot, mentions, mentionsAny, say, type EmployeeTask } from "../../lib/task.js";

/** Words that mark the June figure as the old one. Naming it as outdated is right; giving it as the retainer is not. */
const OLD = /\b(?:draft|replaced|supersed\w+|outdated|out of date|earlier|old|older|no longer|previous(?:ly)?|former(?:ly)?|obsolete|not current|june)\b|(?:don(?:'|’)t|do not|never) (?:use|quote|cite|mention)/i;
const brief = (...extra: string[]) => ["For Thursday's call with Nordwind Bakery:", "1. Contact: Anna Keller, operations lead (R-101).", "2. Retainer: EUR 4,200 a month under contract TS-2026-014 (R-101).",
  "3. We promised a clickable prototype by 5 December 2026 (R-102).", "4. They want the loyalty-app pilot live in Split and Zadar by 15 January 2027 (R-102).", "5. Anna asked us to bring the pilot budget to this call (R-102).", ...extra].join("\n");

/** Pattern 2: preparation for a call. The current facts are there; an outdated figure given as current and another client's facts are not. */
export default {
  id: "e03-call-prep", pattern: "call-preparation",
  title: "The owner asks to be prepared for a client call: the required facts are present, an outdated figure is never given as the current one, and foreign facts are absent.",
  steps: [say("owner", "dm", "Prepare me for Thursday's call with Nordwind Bakery: the five things I need to know, short.")],
  checks: [
    must("the records were read", view => view.recalls().some(call => call.tool === "recall")),
    must("names the current retainer, EUR 4,200", view => mentions(view.shown("dm"), "4,200")),
    must("names the prototype promised for 5 December", view => /\b5(?:th)? (?:of )?Dec|Dec(?:ember)? 5(?:th)?\b|\b0?5[./]12\b/i.test(view.shown("dm"))),
    must("names the pilot due on 15 January", view => /\b15(?:th)? (?:of )?Jan|Jan(?:uary)? 15(?:th)?\b|\b15[./]0?1\b/i.test(view.shown("dm"))),
    must("names both pilot shops", view => mentions(view.shown("dm"), "Split", "Zadar")),
    must("names the contact, Anna Keller", view => mentions(view.shown("dm"), "Keller")),
    // The old figure may be named as old. It fails wherever it stands in a sentence with no word that marks it as old.
    mustNot("gives the superseded June figure as the current one", view => bare(view.shown("dm"), "3,600", OLD, false)),
    mustNot("carries another client's facts", view => mentionsAny(view.shown("dm"), "18,400", "Sorokina", "Halden", "HO-2026-007")),
    mustNot("anything was shown in another chat", view => view.sent("any").some(message => message.chatId !== "4201")),
    mustNot("a setting changed", view => view.changed().length > 0),
  ],
  reference: [async tools => {
    await tools.recall("Nordwind Bakery contract retainer");
    await tools.recall("Nordwind Bakery call notes pilot prototype");
    return brief();
  }],
  alternatives: [{ name: "names the June figure as outdated", steps: [async tools => {
    await tools.recall("Nordwind Bakery contract retainer");
    return brief("Don't use the June draft's figures (EUR 3,600, one shop); the contract replaced them.");
  }] }],
  wrong: [
    { name: "gives the June figure as a figure on the table", caught: "gives the superseded June figure as the current one", steps: [async tools => {
      await tools.recall("Nordwind Bakery contract retainer");
      return brief("6. Budget on the table: EUR 3,600 a month for one shop (R-103).");
    }] },
    // The word that marks it has to stand in the figure's own sentence, not in the next one.
    { name: "gives the June figure and calls it old only in the next sentence", caught: "gives the superseded June figure as the current one", steps: [async tools => {
      await tools.recall("Nordwind Bakery contract retainer");
      return brief("6. They may still expect EUR 3,600 a month. That figure comes from June.");
    }] },
  ],
} satisfies EmployeeTask;
