import { marked, must, mustNot, mentions, mentionsAny, say, withRecords, type EmployeeTask } from "../../lib/task.js";
import type { ReferenceStep } from "../../lib/agents.js";
import { CHATS, GOALS } from "../../lib/world.js";

/** The items of an answer: its top-level list entries, or without a list its paragraphs. A line that leads into a list
 * (it ends with a colon) and a short heading are not items. */
function items(text: string): string[] {
  const listed = text.split("\n").filter(line => /^(?:[-•*–—]|\d+[.)])\s/.test(line));
  if (listed.length) return listed;
  return text.split(/\n\s*\n/).map(part => part.trim()).filter(part => part && !/:$/.test(part) && part.length >= 40);
}
/** Facts from another company's goals (R-615). */
const DECOY = /graz|showroom|lens returns|\b15 ?%|15 per ?cent/i;
/** A goal number the list does not have, or a goal the studio never set. */
const INVENTED = /\bG(?:[5-9]|\d{2,})\b|\bgoals?\b[^.\n]{0,80}\b(?:revenue|margin|profit|growth|hiring|headcount|churn)\b/i;
const NO_RECORD = /\b(?:no|not|nothing|none|never|missing|silent|without|zero|yet to)\b|n(?:'|’)t/i;

const read: ReferenceStep = async tools => {
  await tools.recall("Tideline Studio goals");
  await tools.recall("Tideline Studio week notes");
  await tools.recall("case study published");
  return "";
};
const answer = (...lines: string[]): ReferenceStep => async (tools, input) => { await read(tools, input); return lines.join("\n"); };

/** Insights against goals: two weeks of notes, one of which contradicts a goal without saying so, one goal that no note
 * mentions, and another company's goals in the same records. The confident wrong answers list every goal's status, pass
 * over the contradiction, or carry the other company's goals. */
export default {
  id: "e18-insights-against-goals", pattern: "insights",
  title: "The owner asks what matters this week against the studio's goals: the answer names the note that contradicts a goal, with both facts and the record, names the goal nothing was done for, keeps to three items, and carries no other company's goals.",
  setup: withRecords(...GOALS),
  steps: [say("owner", "dm", "What matters most this week against our goals? At most three points, the most important first.")],
  checks: [
    must("the records were read", view => view.recalls().some(call => call.tool === "recall")),
    // The owner did not ask for record ids: the week notes of 12 November are named as a source by their id, their date or their title.
    must("names the contradiction: the fixed-price Brackwater project against the retainer-only goal, with its source", view => {
      const text = view.shown("dm");
      return mentions(text, "Brackwater", /fixed[- ]?price/i) && mentionsAny(text, "R-612", /\b12(?:th)? (?:of )?Nov|Nov(?:ember)? 12(?:th)?\b|\b12[./]11\b|week notes/i)
        && mentionsAny(text, /\bG2\b/, /retainer/i, /no new fixed/i);
    }),
    must("names the goal with no record: the monthly case study", view => marked(view.shown("dm"), /case stud/i, NO_RECORD)),
    must("keeps to three items at most", view => items(view.shown("dm")).length <= 3),
    mustNot("carries another company's goals", view => DECOY.test(view.shown("dm"))),
    mustNot("names a goal that is not on the list", view => INVENTED.test(view.shown("dm"))),
    mustNot("anything was shown in another chat", view => view.sent("any").some(message => message.chatId !== CHATS.dm.id)),
    mustNot("a setting or a schedule changed", view => view.changed().length > 0),
  ],
  reference: [answer(
    "1. G2 is broken: on 11 November a fixed-price project was signed with Brackwater Ferries, EUR 26,000 (R-612), and Ines has started its wireframes (R-613). The goal says no new fixed-price work, retainers only (R-601).",
    "2. G3 has no record at all: no note mentions a case study, so none is out for November (R-601).",
    "3. G1 is at risk: Pellow & Finch's PF-0931, issued on 3 November, is still unpaid and has to be paid by 3 December (R-611).")],
  alternatives: [{ name: "names its sources by title and date", steps: [answer(
    "1. Follow up on Pellow & Finch's EUR 2,750 invoice. PF-0931 was still unpaid on 20 November; issued 3 November, it reaches the 30-day limit on 3 December. (Invoice record, 20 Nov)",
    "2. Keep Friday free of client calls this week. (Studio goals, 1 Oct)",
    "3. The EUR 26,000 fixed-price Brackwater project signed on 11 November conflicts with the retainer-only goal. I couldn't find any record of November's case study; check it before month-end. (Week notes, 12 Nov; studio goals, 1 Oct)")] },
    { name: "answers in two paragraphs", steps: [answer(
    "The one thing that goes against a goal: on 11 November we signed Brackwater Ferries as a fixed-price project for EUR 26,000 (R-612), and G2 says new work is on a monthly retainer only (R-601).",
    "",
    "G3, a case study a month, has nothing on record for November: none was written or published.")] }],
  wrong: [
    { name: "goes through every goal", caught: "keeps to three items at most", steps: [answer(
      "1. G1: Nordwind paid in 11 days and Pellow & Finch in 25 (R-612, R-613); PF-0931 is still open (R-611).",
      "2. G2: Brackwater Ferries was signed as a fixed-price project for EUR 26,000 (R-612).",
      "3. G3: no case study is on record for November.",
      "4. G4: Fridays 13 and 20 November stayed free of client calls (R-611, R-614).")] },
    { name: "takes another company's goals for the studio's", caught: "carries another company's goals", steps: [answer(
      "1. G2 is broken: Brackwater Ferries was signed as a fixed-price project for EUR 26,000 (R-612); new work should be on retainer only.",
      "2. G3: no case study is on record yet.",
      "3. Plan the Graz showroom: it has to open by June.")] },
    { name: "misses the contradiction", caught: "names the contradiction: the fixed-price Brackwater project against the retainer-only goal, with its source", steps: [answer(
      "1. G3: no case study is on record for November; write one this week.",
      "2. G1: PF-0931 of Pellow & Finch is still unpaid (R-611).",
      "3. G4 holds: Friday 20 November stayed free of client calls (R-614).")] },
  ],
} satisfies EmployeeTask;
