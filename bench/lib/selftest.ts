import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEmployeeTrial } from "./employee.js";
import { flags, line } from "./run.js";
import { EMPLOYEE_TASKS } from "../tasks/employee/index.js";

/** The graders are proven before any model is run: an agent that does nothing scores nothing, one that always refuses or
 * always asks passes only what a refusal or a question rightly answers, and every task's reference solution passes. */
export async function selftest(argv: string[]): Promise<number> {
  const options = flags(argv), track = options.track, problems: string[] = [];
  const transcripts = options.keep === "true" ? mkdtempSync(join(tmpdir(), "strudelbench-selftest-")) : undefined;
  const expect = (holds: boolean, problem: string) => { if (!holds) problems.push(problem); };
  if (!track || track === "employee") {
    const passed: Record<string, string[]> = { null: [], refuse: [], ask: [], reference: [] };
    for (const task of EMPLOYEE_TASKS) for (const agent of Object.keys(passed)) {
      const result = await runEmployeeTrial(task, agent, "none", { run: "selftest", trial: 1, transcripts });
      if (result.pass) passed[agent]!.push(task.id);
      if (options.verbose === "true" || agent === "reference" && !result.pass) console.log(line(result));
      if (agent === "reference") expect(result.pass, `${task.id}: the reference solution fails (${result.error ?? result.checks.filter(check => !check.pass).map(check => check.id).join("; ")}). A task whose reference fails is a broken task.`);
      if (agent === "null") expect(!result.pass && result.partial < 1, `${task.id}: an agent that does nothing passes.`);
      if (agent === "null") expect(!result.claimed_success, `${task.id}: an agent that says nothing is counted as claiming success.`);
      if (agent === "refuse") expect(result.pass === (task.impossible === true), `${task.id}: an agent that always refuses ${result.pass ? "passes a task that needs work" : "fails a task whose right answer is a refusal"}.`);
      if (agent === "ask") expect(!result.pass, `${task.id}: an agent that always asks a general question passes.`);
    }
    const total = EMPLOYEE_TASKS.length, impossible = EMPLOYEE_TASKS.filter(task => task.impossible).length;
    console.log(`employee: ${total} tasks`);
    console.log(`  null agent        ${passed.null!.length}/${total} (must be 0)`);
    console.log(`  always refuses    ${passed.refuse!.length}/${total} (bound: the ${impossible} tasks whose right answer is "cannot")`);
    console.log(`  always asks       ${passed.ask!.length}/${total} (must be 0)`);
    console.log(`  reference         ${passed.reference!.length}/${total} (must be ${total})`);
  }
  if (!track || track === "builder") {
    const { builderSelftest } = await import("./builder.js");
    problems.push(...await builderSelftest({ native: options.native === "true", verbose: options.verbose === "true" }));
  }
  if (transcripts) console.log("transcripts: " + transcripts);
  for (const problem of problems) console.error("PROBLEM  " + problem);
  console.log(problems.length ? `self-test FAILED: ${problems.length} problem(s)` : "self-test passed");
  return problems.length ? 1 : 0;
}
