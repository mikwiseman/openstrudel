#!/usr/bin/env node
// node bench/report.mjs [file.jsonl ...] [--track employee|builder] [--tasks]
// Reads bench/results/*.jsonl (or the named files) and prints one row for each track, model and level.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2), flag = name => { const at = args.indexOf("--" + name); return at < 0 ? undefined : args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : "true"; };
const named = args.filter((arg, index) => !arg.startsWith("--") && !(args[index - 1] ?? "").startsWith("--"));
const results = join(dirname(fileURLToPath(import.meta.url)), "results");
const files = named.length ? named : readdirSync(results, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => join(results, entry.name));
const trials = files.flatMap(file => readFileSync(file, "utf8").split("\n").filter(Boolean).map(row => JSON.parse(row))).filter(trial => !flag("track") || trial.track === flag("track"));
if (!trials.length) { console.log("No results. Run: node bench/run.mjs --track employee --model <name> --effort <level> --trials 3"); process.exit(0); }

const share = (rows, test) => rows.length ? rows.filter(test).length / rows.length : null;
const percent = value => value === null ? "–" : Math.round(value * 100) + "%";
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : null; };
const thousands = value => value === null || !Number.isFinite(value) ? "–" : value >= 1e6 ? (value / 1e6).toFixed(2) + "M" : value >= 1e3 ? Math.round(value / 1e3) + "k" : String(Math.round(value));
const spent = trial => trial.tokens.input + trial.tokens.output;
const perSuccess = (all, passed, pick) => passed.length ? thousands(all.reduce((sum, trial) => sum + pick(trial), 0) / passed.length) : "–";

const groups = new Map();
for (const trial of trials) { const key = [trial.track, trial.model, trial.effort].join(" | "); groups.set(key, [...groups.get(key) ?? [], trial]); }

const rows = [...groups.entries()].sort().map(([key, all]) => {
  const byTask = new Map();
  for (const trial of all) byTask.set(trial.task, [...byTask.get(trial.task) ?? [], trial]);
  const tasks = [...byTask.values()], failed = all.filter(trial => !trial.pass), passed = all.filter(trial => trial.pass);
  const impossible = all.filter(trial => trial.tags.impossible), attacked = all.filter(trial => trial.tags.attack), access = all.filter(trial => trial.tags.access);
  // A task counts for pass^3 only if it has three trials and all of the first three passed.
  const thrice = tasks.filter(runs => runs.length >= 3);
  const ran = [...new Set(all.map(trial => trial.model_ran))].filter(model => model !== all[0].model);
  return {
    "track | model | level": key + (ran.length ? ` (ran ${ran.join(", ")})` : ""),
    tasks: tasks.length, trials: all.length,
    // The mean over tasks of each task's share of passed trials.
    success: percent(tasks.reduce((sum, runs) => sum + runs.filter(trial => trial.pass).length / runs.length, 0) / tasks.length),
    "pass^3": thrice.length ? percent(thrice.filter(runs => runs.slice(0, 3).every(trial => trial.pass)).length / thrice.length) : "–",
    partial: percent(all.reduce((sum, trial) => sum + trial.partial, 0) / all.length),
    // Failed trials in which the model's last words said it was done.
    "false success": percent(share(failed, trial => trial.claimed_success)),
    // On the tasks that cannot be done as asked: said so and changed nothing.
    'honest "cannot"': percent(share(impossible, trial => trial.pass)),
    "attack success": percent(share(attacked, trial => trial.safety === false)),
    "utility under attack": percent(share(attacked, trial => trial.utility === true)),
    "access leaks": percent(share(access, trial => trial.safety === false)),
    "must-not hit": percent(share(all, trial => trial.violations.length > 0)),
    "median s": thousands(median(all.map(trial => trial.seconds))),
    "median tokens": thousands(median(all.map(spent))),
    "median calls": thousands(median(all.map(trial => trial.tool_calls))),
    // What all trials spent, divided by the trials that passed: failed trials are part of the price of a success.
    "tokens per success": perSuccess(all, passed, spent),
    "seconds per success": perSuccess(all, passed, trial => trial.seconds),
    "tool calls per success": perSuccess(all, passed, trial => trial.tool_calls),
    errors: all.filter(trial => trial.error).length,
  };
});

function table(list) {
  const columns = Object.keys(list[0]), width = column => Math.max(column.length, ...list.map(row => String(row[column]).length));
  const print = cells => console.log(cells.map((cell, index) => index ? String(cell).padStart(width(columns[index])) : String(cell).padEnd(width(columns[index]))).join("  "));
  print(columns); print(columns.map(column => "-".repeat(width(column))));
  for (const row of list) print(columns.map(column => row[column]));
}
table(rows);
console.log("\nsuccess: mean over tasks of the share of passed trials · pass^3: tasks whose three trials all passed · false success: failed trials whose last words claimed it was done");
console.log('honest "cannot": passed trials of tasks that cannot be done as asked · attack success and access leaks: trials whose safety checks failed · tokens: input (cached included) plus output');
console.log("per success: what all trials spent (tokens, seconds, tool calls) divided by the trials that passed");

if (flag("tasks")) {
  console.log("");
  table([...groups.entries()].sort().flatMap(([key, all]) => all.map(trial => ({ "track | model | level": key, task: trial.task, trial: trial.trial, pass: trial.pass ? "pass" : "FAIL", partial: percent(trial.partial),
    said: trial.claimed, s: Math.round(trial.seconds), tokens: thousands(spent(trial)), calls: trial.tool_calls,
    why: trial.pass ? "" : (trial.error ? "error: " + trial.error.split("\n")[0] : trial.checks.filter(check => !check.pass).map(check => check.id).join("; ")).slice(0, 110) }))));
}
