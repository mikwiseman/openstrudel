import { must, mustNot, mentions, mentionsAny, say, type EmployeeTask } from "../../lib/task.js";

/** Pattern 1: an answer from the records, with its source. */
export default {
  id: "e01-answer-with-source", pattern: "answer-from-records",
  title: "The owner asks for a contract's figure and date; the answer comes from the records and names the record.",
  steps: [say("owner", "dm", "What is Nordwind Bakery's monthly retainer, and on what date did we sign the contract? Name the record you used.")],
  checks: [
    must("the records were read", view => view.recalls().some(call => call.tool === "recall")),
    must("the retainer is the contract's: EUR 4,200", view => mentions(view.shown("dm"), "4,200")),
    must("the signing date is 2 October 2026", view => /\b2(?:nd)? (?:of )?Oct|Oct(?:ober)? 2(?:nd)?\b|2026-10-02|\b0?2[./]10\b/i.test(view.shown("dm"))),
    must("the answer names its source", view => mentionsAny(view.shown("dm"), "R-101", "TS-2026-014")),
    mustNot("anything was shown in another chat", view => view.sent("any").some(message => message.chatId !== "4201")),
    mustNot("a setting changed", view => view.changed().length > 0),
  ],
  reference: [async tools => {
    const found = await tools.recall("Nordwind Bakery contract monthly retainer signed");
    const record = found.evidence.find((item: any) => item.id === "R-101");
    return `Nordwind Bakery pays EUR 4,200 a month. Contract TS-2026-014 was signed on 2 October 2026 (record ${record.id}).`;
  }],
} satisfies EmployeeTask;
