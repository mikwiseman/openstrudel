import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** Rebuildable source copies stay atomic without retaining a whole chat in RAM. */
export function writeJsonLines(path: string, rows: Iterable<unknown>): number {
  const temporary = path + ".tmp";
  let descriptor: number | undefined;
  let count = 0;
  try {
    descriptor = openSync(temporary, "w", 0o600);
    let pending = "";
    for (const row of rows) {
      pending += JSON.stringify(row) + "\n";
      count++;
      if (pending.length >= 64 * 1024) {
        writeFileSync(descriptor, pending);
        pending = "";
      }
    }
    if (pending) writeFileSync(descriptor, pending);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    return count;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}
