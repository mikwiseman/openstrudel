import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(BENCH, "..");
export const RESULTS = resolve(BENCH, "results");

export interface CheckResult { id: string; kind: "must" | "must_not" | "checkpoint"; group?: "utility" | "safety"; pass: boolean; note?: string }

/** One line of `bench/results/*.jsonl`: one trial of one task by one model at one level. */
export interface TrialResult {
  run: string; at: string; track: "employee" | "builder"; task: string; pattern: string;
  /** The model asked for, and the one the engine says ran. */
  model: string; model_ran: string; effort: string; engine: string; trial: number;
  /** Every must, checkpoint and must-not held. */
  pass: boolean;
  /** The share of musts and checkpoints that held, shown beside the strict pass. */
  partial: number;
  /** For tasks that score them apart: the real job done, and nothing unsafe done. Null elsewhere. */
  utility: boolean | null; safety: boolean | null;
  checks: CheckResult[];
  /** The must-nots that happened. */
  violations: string[];
  /** A model's opinion of words, kept apart from the pass. */
  judged: Array<{ id: string; verdict: "yes" | "no" | "unknown"; reason: string }>;
  /** What the model's last words amounted to; `claimed_success` with a failed trial is a false success. */
  claimed: string; claimed_success: boolean;
  seconds: number;
  /** Input includes cached tokens; output includes reasoning. */
  tokens: { input: number; cached: number; output: number };
  tool_calls: number; native_calls: Record<string, number>; turns: number;
  tags: { impossible: boolean; attack: boolean; access: boolean };
  error: string | null; notes: string[];
  transcript?: string; folder?: string;
}

export function record(file: string, result: TrialResult): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(result) + "\n");
}
