import { join } from "node:path";
import { BUILTIN, CLAUDE_MODELS, CODEX_MODELS, engineOf } from "./agents.js";
import { runEmployeeTrial } from "./employee.js";
import { RESULTS, record, type TrialResult } from "./results.js";
import { EMPLOYEE_TASKS } from "../tasks/employee/index.js";

export function flags(argv: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith("--")) found[argv[i]!.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
  return found;
}
export const line = (result: TrialResult) => `${result.pass ? "pass" : "FAIL"}  ${result.task.padEnd(26)} ${result.model_ran.padEnd(18)} ${result.effort.padEnd(6)} #${result.trial}  ${result.seconds.toFixed(0).padStart(4)}s  ${String(result.tokens.input + result.tokens.output).padStart(8)} tok  ${String(result.tool_calls).padStart(2)} calls  said:${result.claimed}`
  + (result.pass ? "" : "  ← " + (result.error ? "error: " + result.error.split("\n")[0]!.slice(0, 120) : result.checks.filter(check => !check.pass).map(check => check.id).join("; ").slice(0, 200)));

export async function main(argv: string[]): Promise<number> {
  const options = flags(argv), track = options.track ?? "employee", model = options.model, effort = options.effort ?? "low", trials = Number(options.trials ?? 1);
  const known = [...BUILTIN, ...CODEX_MODELS, ...CLAUDE_MODELS];
  if (!model || !known.includes(model) || !["employee", "builder"].includes(track) || !Number.isInteger(trials) || trials < 1) {
    console.error(`Usage: node bench/run.mjs --track employee|builder --model <name> --effort <level> --trials N [--only id,id] [--judge <codex model>] [--keep] [--codex-bin <path>|pinned] [--out <file>]\nModels: ${known.join(", ")}`);
    return 2;
  }
  const run = options.out ? options.out.replace(/^.*\//, "").replace(/\.jsonl$/, "") : new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + track + "-" + model + "-" + effort;
  const file = options.out ?? join(RESULTS, run + ".jsonl"), transcripts = join(RESULTS, "transcripts", run), only = options.only?.split(",").filter(Boolean);
  const judge = options.judge ? (await import("./judge.js")).makeJudge(options.judge, options["codex-bin"]) : undefined;
  let failed = 0;
  try {
    if (track === "employee") {
      const tasks = EMPLOYEE_TASKS.filter(task => !only || only.includes(task.id));
      for (const task of tasks) for (let trial = 1; trial <= trials; trial++) {
        const result = await runEmployeeTrial(task, model, effort, { run, trial, transcripts, keep: options.keep === "true", codexBin: options["codex-bin"], judge: judge?.ask });
        record(file, result); console.log(line(result));
        if (!result.pass) failed++;
      }
    } else {
      const { BUILDER_TASKS, runBuilderTrial } = await import("./builder.js");
      const tasks = BUILDER_TASKS.filter(task => !only || only.includes(task.id));
      for (const task of tasks) for (let trial = 1; trial <= trials; trial++) {
        const result = await runBuilderTrial(task, model, effort, { run, trial, transcripts, keep: options.keep === "true", codexBin: options["codex-bin"], native: options.native === "true" });
        record(file, result); console.log(line(result));
        if (!result.pass) failed++;
      }
    }
  } finally { await judge?.close(); }
  console.log(`\n${file}`);
  // A model's failures are results, not errors of the run.
  return engineOf(model) === "builtin" && model === "reference" && failed ? 1 : 0;
}
