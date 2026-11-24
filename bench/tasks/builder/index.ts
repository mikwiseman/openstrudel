import b171 from "./b171-group-switches.js";
import b173 from "./b173-signed-out-once.js";
import b176 from "./b176-cause-words.js";
import b900 from "./b900-contradicts-a-test.js";

/** A builder task: a problem as a user reports it, the commit before the fix, and tests the agent never sees. */
export interface BuilderTask {
  id: string; pattern: string; title: string;
  /** The merged pull request it was mined from. */
  pr?: number;
  /** Where the agent starts: the commit the fix was merged onto. */
  base: string;
  /** The merge commit: the reference patch, and where the hidden tests are read from. Absent when nothing is to be fixed. */
  fix?: string;
  /** The problem, in the reporter's words, with no file names. */
  statement: string;
  runner: "vitest" | "xcodebuild";
  /** Test files of the fix, copied into the folder only after the agent has stopped. */
  hidden_tests: string[];
  /** Titles of the tests that fail before the fix and must pass after it. */
  fail_to_pass: string[];
  /** Neighbouring test files: every other test in them, and in the hidden files, passed before and must still pass. */
  pass_to_pass: string[];
  /** Tests in those files that do not pass before the fix for reasons of their own, and are not counted. */
  not_required?: string[];
  /** Paths the agent was told not to change. */
  leave_untouched?: string[];
  /** For a request that cannot be done as written: what the final message has to say. */
  says?: RegExp[];
  /** What the reference solution says when it finishes. */
  reference_message: string;
  native?: { scheme: string; only: string[] };
}

export const BUILDER_TASKS: BuilderTask[] = [b171, b173, b176, b900];
