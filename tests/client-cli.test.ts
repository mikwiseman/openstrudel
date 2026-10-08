import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recordClientAttempt, listClientAttempts } from "../src/client-attempt.js";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { MockCodexEngine } from "../src/codex.js";
import { hostingOrigin } from "../src/hosting-origin.js";

describe("CLI recovery after a lost response", () => {
  it("keeps Telegram group links distinct from personal pairing, including older devices", async () => {
    const root = await mkdtemp(join(tmpdir(), "strudel-cli-telegram-"));
    const requests: { path: string; body: Record<string, string> }[] = [];
    let legacy = false;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push({ path: req.url!, body });
      const query = body.kind === "group" && !legacy ? "startgroup" : "start";
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ code: "fixture", expiresAt: "2026-10-08T12:00:00Z", url: `https://t.me/test_bot?${query}=fixture` }));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const config = join(root, "connection.json");
    await writeFile(config, JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}`, token: "synthetic-owner" }), { mode: 0o600 });
    const cli = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "telegram", ...args], { cwd: root, env: { ...process.env, OPENSTRUDEL_CLIENT_CONFIG: config }, stdio: "pipe" });
      let out = "", err = ""; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b); child.once("error", reject); child.once("exit", code => resolve({ code, out, err })); child.stdin.end();
    });
    try {
      const pair = await cli(["pair"]); expect(pair.code, pair.err).toBe(0);
      expect(requests.at(-1)?.body).toEqual({});
      const group = await cli(["group", "editor", "--device", "remote"]); expect(group.code, group.err).toBe(0);
      expect(JSON.parse(group.out).url).toContain("?startgroup=");
      expect(requests.at(-1)).toEqual({ path: "/v1/integrations/telegram/link?deviceId=remote", body: { kind: "group", profileId: "editor" } });
      legacy = true;
      const old = await cli(["group", "editor"]); expect(old.code).toBe(1); expect(old.out).not.toContain("https://t.me/"); expect(old.err).toContain("Обновите OpenStrudel");
    } finally { await new Promise<void>(done => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
  });

  it("does not publish store credentials, redirects or executable URLs as a Home destination", () => {
    for (const value of ["javascript:alert(1)", "http://public.example", "https://user:secret@store.example", "https://store.example/path", "https://store.example?key=secret", "https://store.example#key=secret"]) expect(hostingOrigin(value)).toBeUndefined();
    expect(hostingOrigin("https://store.example/")).toBe("https://store.example");
    expect(hostingOrigin(undefined)).toBeUndefined();
  });
  it("rolls back agent creation when its durable receipt cannot be saved", async () => {
    const root = await mkdtemp(join(tmpdir(), "strudel-cli-atomic-"));
    const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: ":memory:", apiToken: "test-owner", engine: new MockCodexEngine(), startTelegram: false });
    const address = await runtime.api.listen("127.0.0.1", 0);
    const create = () => fetch(`http://127.0.0.1:${address.port}/v1/profiles`, { method: "POST", headers: { authorization: "Bearer test-owner", "content-type": "application/json" }, body: JSON.stringify({ name: "Durable", creationId: "76cdf637-b79b-437c-8c13-1872f71235b7" }) });
    try {
      runtime.store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON settings WHEN NEW.key LIKE 'employee.creation.%' BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END;");
      expect((await create()).ok).toBe(false); expect(runtime.store.listProfiles()).toHaveLength(0);
      runtime.store.db.exec("DROP TRIGGER fail_receipt");
      expect((await create()).ok).toBe(true); expect((await create()).ok).toBe(true);
      expect(runtime.store.listProfiles()).toHaveLength(1);
    } finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
  });
  it("reserves a private stable identity before dispatch and rejects changed content or destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "strudel-attempt-"));
    try {
      const input = { requestId: randomUUID(), home: "home-one", operation: "message", payload: { text: "private fixture prompt", profile: "one" } };
      const ids = await Promise.all([recordClientAttempt(directory, input), recordClientAttempt(directory, { ...input, payload: { profile: "one", text: "private fixture prompt" } })]);
      expect(ids).toEqual([input.requestId, input.requestId]);
      const filename = join(directory, input.requestId + ".json"), saved = await readFile(filename, "utf8");
      expect(saved).not.toContain("private fixture prompt"); expect((await stat(filename)).mode & 0o777).toBe(0o600);
      for (const changes of [{ payload: { text: "different" } }, { home: "another-home" }, { deviceId: "another-device" }, { operation: "agents create" }])
        await expect(recordClientAttempt(directory, { ...input, ...changes })).rejects.toThrow("другой команде");
      expect(await listClientAttempts(directory)).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("starts a new CLI process after losing accepted replies without duplicating an agent or message", async () => {
    const root = await mkdtemp(join(tmpdir(), "strudel-cli-reply-"));
    const runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: ":memory:", apiToken: "synthetic-cli-owner", engine: new MockCodexEngine(), startTelegram: false });
    const address = await runtime.api.listen("127.0.0.1", 0), base = `http://127.0.0.1:${address.port}`;
    let loseNext = true, writes = 0;
    const proxy = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        if (req.method === "POST") writes++;
        const response = await fetch(base + req.url, { method: req.method, headers: { authorization: "Bearer synthetic-cli-owner", "content-type": "application/json", "idempotency-key": String(req.headers["idempotency-key"] ?? "") }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (loseNext && req.method === "POST") { loseNext = false; res.destroy(); return; }
        res.writeHead(response.status, { "content-type": "application/json" }).end(bytes);
      } catch { res.destroy(); }
    });
    await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
    const config = join(root, "connection.json");
    await writeFile(config, JSON.stringify({ url: `http://127.0.0.1:${(proxy.address() as any).port}`, homeId: runtime.api.home.state.id, token: "synthetic-cli-owner" }), { mode: 0o600 });
    const cli = (args: string[], input = "") => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...args], { cwd: root, env: { ...process.env, OPENSTRUDEL_CLIENT_CONFIG: config }, stdio: "pipe" });
      let out = "", err = ""; child.stdout.on("data", b => out += b); child.stderr.on("data", b => err += b); child.once("error", reject); child.once("exit", code => resolve({ code, out, err })); child.stdin.end(input);
    });
    try {
      const input = JSON.stringify({ name: "One CLI agent", instructions: "Only a synthetic fixture" });
      const lost = await cli(["agents", "create", "--json"], input);
      expect(lost.code).toBe(1); const id = lost.err.match(/request-id: ([0-9a-f-]{36})/)?.[1]; expect(id).toBeTruthy();
      const repeated = await cli(["agents", "create", "--json", "--request-id", id!], input);
      expect(repeated.code, repeated.err).toBe(0); const profile = JSON.parse(repeated.out).profile;
      expect(runtime.store.listProfiles()).toHaveLength(1);
      const changed = await cli(["agents", "create", "--request-id", id!], JSON.stringify({ name: "Different" }));
      expect(changed.code).toBe(1); expect(writes).toBe(2);
      loseNext = true;
      const lostMessage = await cli(["message", "--agent", profile.id, "A synthetic message"]);
      expect(lostMessage.code).toBe(1); const messageId = lostMessage.err.match(/request-id: ([0-9a-f-]{36})/)?.[1]; expect(messageId).toBeTruthy();
      const secondMessage = await cli(["message", "--json", "--agent", profile.id, "--request-id", messageId!, "A synthetic message"]);
      expect(secondMessage.code, secondMessage.err).toBe(0);
      const messages = runtime.store.listMessages(runtime.store.profileConversation(profile.id).id);
      expect(messages.filter(m => m.direction === "inbound")).toHaveLength(1);
      expect(messages.filter(m => m.direction === "outbound")).toHaveLength(1);
      const attempts = await cli(["home", "attempts", "--json"]);
      expect(JSON.parse(attempts.out).attempts).toHaveLength(2);
      expect(attempts.out).not.toContain("A synthetic message"); expect(attempts.out).not.toContain("synthetic-cli-owner");
    } finally {
      await new Promise<void>(done => proxy.close(() => done())); await runtime.stop(); await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
