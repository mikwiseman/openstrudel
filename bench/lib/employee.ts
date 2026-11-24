import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { engineOf, makeAgent } from "./agents.js";
import { openHome, type Home } from "./home.js";
import { stance, View, type Check, type EmployeeTask, type Phase, type Step } from "./task.js";
import { removeFolder, type CheckResult, type TrialResult } from "./results.js";

export interface TrialOptions { run: string; trial: number; keep?: boolean; transcripts?: string; stepSeconds?: number; codexBin?: string;
  judge?: (question: string, text: string) => Promise<{ verdict: "yes" | "no" | "unknown"; reason: string }> }

const timeout = <T>(work: Promise<T>, seconds: number, what: string): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} took longer than ${seconds} seconds.`)), seconds * 1000);
  work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/** One trial of one task: a new Home in a new folder, the scripted user's steps, then the graders read what is left. */
export async function runEmployeeTrial(task: EmployeeTask, model: string, effort: string, options: TrialOptions): Promise<TrialResult> {
  const directory = mkdtempSync(join(tmpdir(), `strudelbench-${task.id}-`)), started = Date.now(), cwd = process.cwd();
  const agent = makeAgent(model, effort, directory, task.reference, { codexBin: options.codexBin });
  let home: Home | undefined, error: string | null = null, claim: string | undefined;
  const phases: Phase[] = [], checks: CheckResult[] = [], judgedResults: TrialResult["judged"] = [];
  try {
    home = await openHome(directory, agent.engine);
    agent.bind(home.memory);
    process.chdir(home.root);
    await task.setup?.(home);
    const baseline = home.snapshot(0), opened = home;
    phases.push({ label: "start", snapshot: baseline });
    const view = (phase = phases.at(-1)!) => new View(opened, agent.log, baseline, phase);
    const perform = async (step: Step): Promise<void> => {
      if (step.do === "say") return opened.say(step.who, step.where, step.text, step.extra);
      if (step.do === "press") {
        const card = step.card(view());
        if (card?.telegramMessageId != null) await opened.press(step.who, card.chatId, card.telegramMessageId, `c:${card.id}:${step.choice}`);
        return;
      }
      if (step.do === "clock") {
        const schedule = step.schedule(view());
        if (!schedule) return;
        const due = new Date(Date.parse(schedule.nextRunAt) + 30_000);
        await opened.tick(due);
        // The same minute again, and the next: an edition that already ran must not run or be delivered twice.
        if (step.again) { await opened.tick(due); await opened.tick(new Date(due.getTime() + 60_000)); }
        return;
      }
      if (step.do === "world") { await step.change(opened); return; }
      const rule = step.rules.find(candidate => candidate.when(view()));
      if (rule) await perform(rule.then);
    };
    for (const [index, step] of task.steps.entries()) {
      const label = step.label ?? `step${index + 1}`;
      opened.telegram.phase = label;
      try { await timeout(perform(step), options.stepSeconds ?? (engineOf(model) === "builtin" ? 30 : 600), `Step ${label}`); }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      phases.push({ label, snapshot: opened.snapshot(agent.log.calls.length) });
      if (error) break;
    }
    error ??= agent.log.turns.find(turn => turn.error)?.error ?? null;
    const at = (check: Check) => view(check.at ? phases.find(phase => phase.label === check.at) ?? phases.at(-1)! : phases.at(-1)!);
    for (const check of task.checks) {
      if (check.kind === "judged") {
        // Words are judged apart from the pass: a verdict of "unknown" is allowed and nothing here changes the score.
        const text = check.text!(at(check));
        judgedResults.push({ id: check.id, ...(options.judge ? await options.judge(check.question!, text).catch(failure => ({ verdict: "unknown" as const, reason: String(failure).slice(0, 200) })) : { verdict: "unknown" as const, reason: "no judge in this run" }) });
        continue;
      }
      let held = false, note: string | undefined;
      try { held = check.test!(at(check)) === true; } catch (failure) { note = "the check itself failed: " + (failure instanceof Error ? failure.message : String(failure)); }
      checks.push({ id: check.id, kind: check.kind, ...(check.group ? { group: check.group } : {}), pass: note ? false : check.kind === "must_not" ? !held : held, ...(note ? { note } : {}) });
    }
    // A task whose claim is made before its last step says where to read it.
    if (task.claim) claim = task.claim(view());
  } catch (failure) { error = failure instanceof Error ? failure.stack ?? failure.message : String(failure); }
  finally {
    process.chdir(cwd);
    await home?.stop().catch(() => undefined);
    await agent.close().catch(() => undefined);
  }
  const needed = checks.filter(check => check.kind !== "must_not"), group = (name: string) => { const own = checks.filter(check => check.group === name); return own.length ? own.every(check => check.pass) : null; };
  const said = claim ?? [...agent.log.turns].reverse().find(turn => turn.response && stance(turn.response) !== "silent")?.response;
  const sum = (pick: (turn: (typeof agent.log.turns)[number]) => number) => agent.log.turns.reduce((total, turn) => total + pick(turn), 0);
  const native: Record<string, number> = {};
  for (const turn of agent.log.turns) for (const [kind, count] of Object.entries(turn.native)) native[kind] = (native[kind] ?? 0) + count;
  const result: TrialResult = {
    run: options.run, at: new Date().toISOString(), track: "employee", task: task.id, pattern: task.pattern, model, model_ran: agent.log.modelRan ?? model, effort, engine: agent.version, trial: options.trial,
    // Without a single check that ran, nothing is proven: an empty trial never passes.
    pass: checks.length > 0 && checks.every(check => check.pass), partial: needed.length ? needed.filter(check => check.pass).length / needed.length : 0,
    utility: group("utility"), safety: group("safety"), checks, violations: checks.filter(check => check.kind === "must_not" && !check.pass).map(check => check.id), judged: judgedResults,
    claimed: stance(said), claimed_success: stance(said) === "done", seconds: (Date.now() - started) / 1000,
    tokens: { input: sum(turn => turn.tokens.input), cached: sum(turn => turn.tokens.cached), output: sum(turn => turn.tokens.output) },
    tool_calls: agent.log.calls.length + (home?.memory.calls.length ?? 0), native_calls: native, turns: agent.log.turns.length,
    tags: { impossible: task.impossible === true, attack: task.attack === true, access: task.access === true }, error, notes: agent.log.notes,
  };
  if (options.transcripts) {
    const path = join(options.transcripts, `${task.id}.${model}.${effort}.${options.trial}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ result, turns: agent.log.turns, calls: agent.log.calls, memory: home?.memory.calls ?? [], approvals: home?.approvals ?? [],
      telegram: home?.telegram.calls.filter(call => call.method !== "sendChatAction") ?? [], blocked: home?.telegram.blocked ?? [], phases }, null, 1));
    result.transcript = path;
  }
  if (!options.keep) removeFolder(directory); else result.folder = directory;
  return result;
}
