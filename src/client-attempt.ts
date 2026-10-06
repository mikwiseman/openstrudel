import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, link, unlink, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { HomeError } from "./home.js";

type Attempt = {
  version: 1; requestId: string; operation: string; home: string;
  deviceId: string | null; payloadHash: string; createdAt: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;

/** Persist identity before dispatch, without saving prompts, tokens or credentials. */
export async function recordClientAttempt(directory: string, input: {
  requestId?: string; operation: string; home: string; deviceId?: string; payload: unknown;
}): Promise<string> {
  if (input.requestId !== undefined && typeof input.requestId !== "string") throw new HomeError("request-id должен быть UUID.");
  const requestId = (input.requestId ?? randomUUID()).toLowerCase();
  if (!uuid.test(requestId)) throw new HomeError("После --request-id укажите UUID одной попытки.");
  const attempt: Attempt = { version: 1, requestId, operation: input.operation, home: input.home,
    deviceId: input.deviceId ?? null, payloadHash: createHash("sha256").update(JSON.stringify(canonical(input.payload))).digest("hex"), createdAt: new Date().toISOString() };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, "." + randomUUID()), filename = join(directory, requestId + ".json");
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(attempt)); await file.sync(); } finally { await file.close(); }
  try {
    try { await link(temporary, filename); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const previous = JSON.parse(await readFile(filename, "utf8")) as Attempt;
      if (previous.version !== 1 || previous.requestId !== requestId || previous.operation !== attempt.operation || previous.home !== attempt.home || previous.deviceId !== attempt.deviceId || previous.payloadHash !== attempt.payloadHash)
        throw new HomeError("Этот request-id уже относится к другой команде, устройству или содержимому. Для нового действия нужен новый UUID.", 409);
    }
    const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temporary); }
  return requestId;
}

export async function listClientAttempts(directory: string): Promise<Attempt[]> {
  let files: string[];
  try { files = await readdir(directory); } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  const attempts = await Promise.all(files.filter(f => uuid.test(f.slice(0, -5)) && f.endsWith(".json")).map(async f => JSON.parse(await readFile(join(directory, f), "utf8")) as Attempt));
  return attempts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
