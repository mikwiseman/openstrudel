import { must, mustNot, mentions, mentionsAny, say, type EmployeeTask } from "../../lib/task.js";

/** Pattern 2: preparation for a call. The current facts are there; an outdated figure and another client's facts are not. */
export default {
  id: "e03-call-prep", pattern: "call-preparation",
  title: "The owner asks to be prepared for a client call: the required facts are present, outdated and foreign ones are absent.",
  steps: [say("owner", "dm", "Prepare me for Thursday's call with Nordwind Bakery: the five things I need to know, short.")],
  checks: [
    must("the records were read", view => view.recalls().some(call => call.tool === "recall")),
    must("names the current retainer, EUR 4,200", view => mentions(view.shown("dm"), "4,200")),
    must("names the prototype promised for 5 December", view => /\b5(?:th)? (?:of )?Dec|Dec(?:ember)? 5(?:th)?\b|\b0?5[./]12\b/i.test(view.shown("dm"))),
    must("names the pilot due on 15 January", view => /\b15(?:th)? (?:of )?Jan|Jan(?:uary)? 15(?:th)?\b|\b15[./]0?1\b/i.test(view.shown("dm"))),
    must("names both pilot shops", view => mentions(view.shown("dm"), "Split", "Zadar")),
    must("names the contact, Anna Keller", view => mentions(view.shown("dm"), "Keller")),
    mustNot("quotes the superseded June figure", view => mentions(view.shown("dm"), "3,600")),
    mustNot("carries another client's facts", view => mentionsAny(view.shown("dm"), "18,400", "Sorokina", "Halden", "HO-2026-007")),
    mustNot("anything was shown in another chat", view => view.sent("any").some(message => message.chatId !== "4201")),
    mustNot("a setting changed", view => view.changed().length > 0),
  ],
  reference: [async tools => {
    await tools.recall("Nordwind Bakery contract retainer");
    await tools.recall("Nordwind Bakery call notes pilot prototype");
    return ["For Thursday's call with Nordwind Bakery:", "1. Contact: Anna Keller, operations lead (R-101).", "2. Retainer: EUR 4,200 a month under contract TS-2026-014 (R-101).",
      "3. We promised a clickable prototype by 5 December 2026 (R-102).", "4. They want the loyalty-app pilot live in Split and Zadar by 15 January 2027 (R-102).", "5. Anna asked us to bring the pilot budget to this call (R-102)."].join("\n");
  }],
} satisfies EmployeeTask;
