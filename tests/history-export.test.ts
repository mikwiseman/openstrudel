import { expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeJsonLines } from "../src/history-export.js";

it("preserves the last complete source copy if reading its replacement fails", () => {
  const root = mkdtempSync(join(tmpdir(), "history-export-")), path = join(root, "history.jsonl");
  try {
    writeFileSync(path, '{"text":"old source"}\n', { mode: 0o600 });
    let closed = false;
    function* broken() {
      try { yield { text: "replacement" }; throw new Error("source unavailable"); }
      finally { closed = true; }
    }
    expect(() => writeJsonLines(path, broken())).toThrow("source unavailable");
    expect(closed).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('{"text":"old source"}\n');
    expect(existsSync(path + ".tmp")).toBe(false);
    expect(writeJsonLines(path, [{ text: "строка\nwith a newline" }, { text: "last" }])).toBe(2);
    expect(readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([{ text: "строка\nwith a newline" }, { text: "last" }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
