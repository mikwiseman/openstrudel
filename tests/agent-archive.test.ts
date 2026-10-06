import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { request as httpsRequest } from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { AgentArchives, encodeArchive, decodeArchive, type AgentArchive } from "../src/agent-archive.js";
import { OpenStrudelRuntime } from "../src/runtime.js";

const fixtures: { root: string; runtime: OpenStrudelRuntime }[] = [];
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "strudel-transfer-"));
  let turns = 0;
  const runtime = new OpenStrudelRuntime({ dbPath: resolve(root, "data.sqlite"), rootDirectory: root, startTelegram: false,
    engine: { async run(text, options) { turns++; return { threadId: "new-thread", response: options?.profile + "\n" + text, events: [] }; } } });
  const archive = new AgentArchives(runtime.store, runtime.messages);
  fixtures.push({ root, runtime });
  return { root, ...runtime, runtime, archive, turns: () => turns };
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.runtime.stop(); rmSync(f.root, { recursive: true, force: true }); } });

function populated() {
  const f = fixture(), s = f.store;
  const employee = s.createProfile({ name: "Редактор", instructions: "Сохраняй мой голос.", capabilities: ["research"], model: "gpt-5", tokenLimit: 12345, domain: "work", purpose: "Мой журнал" });
  const colleague = s.createProfile({ name: "Коллега", domain: "work" });
  // This fixture represents a team created before individual agent workspaces.
  s.deleteSetting("employee.context." + employee.id);
  s.deleteSetting("employee.context." + colleague.id);
  s.setSetting("main.soul", "Главный помощник");
  for (const name of ["api.local_token", "telegram.bot_token", "codex.auth.mode"]) s.setSetting(name, "DO_NOT_EXPORT_SECRET");
  s.setSetting("mobile.tokens", '["DO_NOT_EXPORT_SECRET"]');
  const chat = s.profileConversation(employee.id);
  s.setConversationThread(chat.id, "DO_NOT_EXPORT_THREAD");
  const file = f.messages.files.put(chat.id, "work", { name: "План.txt", mimeType: "text/plain", contentBase64: Buffer.from("Мой план").toString("base64") });
  const first = s.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: "Прочитай план", attachments: [file] });
  const reply = s.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "Готово", replyToId: first.id });
  s.addMessage({ conversationId: s.primaryConversation().id, channel: "api", direction: "outbound", text: "Главная история" });
  const pending = s.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: "Не повторять это действие" });
  s.setMessageStatus(pending.id, "running");
  writeFileSync(resolve(f.messages.files.workspace("work"), "MEMORY.md"), "Память редактора");
  const configDir = resolve(f.root, ".data/contexts/work"); mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "config.toml"), '[apps.calendar]\nenabled = true\n[mcp_servers.private]\nenv = { TOKEN = "DO_NOT_EXPORT_SECRET" }');
  s.linkTelegramChat({ chatId: "-12345", title: "Группа", allowedSenders: ["123"] });
  const group = s.bindTelegramChat("-12345", employee.id);
  const groupChat = s.getTelegramChat("-12345")!.conversationId!;
  const groupContext = f.messages.contextFor(groupChat);
  mkdirSync(f.messages.files.workspace(groupContext), { recursive: true });
  writeFileSync(resolve(f.messages.files.workspace(groupContext), "GROUP.md"), "Групповой контекст");
  s.addMessage({ conversationId: groupChat, channel: "telegram", direction: "inbound", text: "Групповая история", author: "Участник" });
  const schedule = f.scheduler.save({ conversationId: chat.id, name: "Утро", prompt: "Собери обзор", cron: "0 9 * * *", timezone: "Europe/Moscow", telegramChatId: "-12345", delivery: "telegram" });
  f.scheduler.save({ conversationId: chat.id, name: "Резерв", prompt: "Собери обзор", cron: "0 10 * * *", timezone: "Europe/Moscow", backupOf: schedule.id });
  s.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,message_id) VALUES(?,?,?,?,?,?,?)")
    .run("run-1", schedule.id, chat.id, "2026-10-05T09:00:00Z", "ready", "2026-10-05T09:00:00Z", reply.id);
  return { ...f, employee, chat, file, group };
}

describe("additive team transfer", () => {
  it("preserves characters when importing with new IDs, including older archives", () => {
    const source = fixture(), target = fixture();
    const agent = source.store.createProfile({ name: "Образ", appearance: { version: 1, kind: "curl", tone: 6 } });
    const archive = source.archive.export();
    target.archive.import(archive, target.archive.preview(archive).planToken);
    const imported = target.store.getProfile("Образ")!;
    expect(imported.id).not.toBe(agent.id);
    expect(imported.appearance).toEqual(agent.appearance);
    delete archive.profiles.find(p => p.id === agent.id)!.appearance;
    const decoded = decodeArchive(Buffer.from(JSON.stringify(archive)));
    const olderTarget = fixture();
    olderTarget.archive.import(decoded, olderTarget.archive.preview(decoded).planToken);
    expect(olderTarget.store.getProfile("Образ")!.appearance).toBeDefined();
    const invalid = structuredClone(archive);
    (invalid.profiles[0] as any).appearance = { version: 1, kind: "external", tone: 0 };
    expect(() => target.archive.preview(decodeArchive(Buffer.from(JSON.stringify(invalid))))).toThrow();
    expect(target.store.listProfiles()).toHaveLength(2);
  });
  it("keeps new agents isolated through export and additive import", () => {
    const source = fixture(), target = fixture();
    const first = source.store.createProfile({ name: "One", domain: "work" });
    const second = source.store.createProfile({ name: "Two", domain: "work" });
    for (const agent of [first, second]) {
      const chat = source.store.profileConversation(agent.id), context = source.messages.contextFor(chat.id);
      const directory = source.messages.files.workspace(context); mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, "MEMORY.md"), agent.name);
    }
    const archive = source.archive.export();
    target.archive.import(archive, target.archive.preview(archive).planToken);
    const contexts = ["One", "Two"].map(name => {
      const chat = target.store.profileConversation(target.store.getProfile(name)!.id);
      const context = target.messages.contextFor(chat.id);
      expect(readFileSync(resolve(target.messages.files.workspace(context), "MEMORY.md"), "utf8")).toBe(name);
      return context;
    });
    expect(contexts[0]).not.toBe(contexts[1]);
  });
  it("compresses files for transfer and accepts both compressed and original JSON copies", () => {
    const source = populated(), archive = source.archive.export();
    const bytes = encodeArchive(archive);
    expect(bytes[0]).toBe(0x1f);
    expect(decodeArchive(bytes)).toEqual(archive);
    expect(decodeArchive(Buffer.from(JSON.stringify(archive)))).toEqual(archive);
    expect(() => decodeArchive(bytes.subarray(0, 20))).toThrow("повреждён");
  });
  it("preserves empty folders and executable files without running them", () => {
    const source = populated(), target = fixture();
    const workspace = source.messages.files.workspace("work");
    mkdirSync(resolve(workspace, "empty"));
    writeFileSync(resolve(workspace, "helper.sh"), "#!/bin/sh\necho should-not-run\n", { mode: 0o700 });
    const archive = source.archive.export();
    target.archive.import(archive, target.archive.preview(archive).planToken);
    const chat = target.store.profileConversation(target.store.getProfile("Редактор")!.id);
    const restored = target.messages.files.workspace(target.messages.contextFor(chat.id));
    expect(statSync(resolve(restored, "empty")).isDirectory()).toBe(true);
    expect(statSync(resolve(restored, "helper.sh")).mode & 0o777).toBe(0o700);
    expect(target.turns()).toBe(0);
  });

  it("waits for active work to finish before making a snapshot", async () => {
    const source = fixture();
    let finish!: () => void;
    const done = new Promise<void>(resolve => finish = resolve);
    source.engine.run = async () => { await done; return { threadId: "t", response: "Done", events: [] }; };
    const submission = await source.messages.submit({ channel: "api", text: "Wait" });
    expect(() => source.archive.export()).toThrow("ещё работают");
    finish(); await submission.completion;
    expect(source.archive.export().messages).toHaveLength(2);
  });

  it("round-trips every profile field, history, files and paused schedules without touching the existing team or credentials", async () => {
    const source = populated(), destination = fixture();
    const existing = destination.store.createProfile({ name: "Редактор", instructions: "Existing personality" });
    destination.store.setSetting("main.soul", "My existing main assistant");
    const workspace = destination.messages.files.workspace("work"); mkdirSync(workspace, { recursive: true });
    writeFileSync(resolve(workspace, "MEMORY.md"), "Existing memory");
    const archive = source.archive.export();
    expect(JSON.stringify(archive)).not.toMatch(/DO_NOT_EXPORT_(SECRET|THREAD)/);
    const preview = destination.archive.preview(archive);
    expect(preview.employees[0]?.importedName).toBe("OpenStrudel (импорт)");
    expect(preview.employees.find(e => e.name === "Редактор")?.importedName).toBe("Редактор (импорт)");
    expect(preview.counts).toMatchObject({ employees: 3, schedules: 2, messages: 5 });
    expect(preview.connections).toEqual(["calendar", "private"]);
    expect(destination.store.listProfiles()).toHaveLength(1); // preview has no side effects
    const result = destination.archive.import(archive, preview.planToken);
    expect(result.profileIds).toHaveLength(3);
    expect(destination.store.getProfile(existing.id)?.instructions).toBe("Existing personality");
    expect(destination.store.getSetting("main.soul")).toBe("My existing main assistant");
    expect(readFileSync(resolve(workspace, "MEMORY.md"), "utf8")).toBe("Existing memory");
    const editor = destination.store.getProfile("Редактор (импорт)")!;
    expect(editor).toMatchObject({ instructions: source.employee.instructions, capabilities: ["research"], model: "gpt-5", tokenLimit: 12345, purpose: "Мой журнал", domain: "work" });
    expect(editor.id).not.toBe(source.employee.id);
    const chat = destination.store.profileConversation(editor.id), context = destination.messages.contextFor(chat.id);
    expect(context).toMatch(/^import-[a-f0-9]{32}$/);
    const colleagueChat = destination.store.profileConversation(destination.store.getProfile("Коллега")!.id);
    expect(destination.messages.contextFor(colleagueChat.id)).toBe(context);
    expect(readFileSync(resolve(destination.messages.files.workspace(context), "MEMORY.md"), "utf8")).toBe("Память редактора");
    expect(chat.codexThreadId).toBeNull();
    const messages = destination.store.listMessages(chat.id);
    expect(messages.map(m => m.text)).toEqual(["Прочитай план", "Готово", "Не повторять это действие"]);
    expect(messages[1]?.replyToId).toBe(messages[0]?.id);
    expect(messages[2]?.status).toBe("failed");
    const attachment = destination.messages.files.get(messages[0]!.attachments![0]!.id)!;
    expect(attachment.id).not.toBe(source.file.id);
    expect(readFileSync(attachment.path, "utf8")).toBe("Мой план");
    const schedules = destination.scheduler.list(chat.id);
    expect(schedules.every(s => !s.enabled && s.delivery === "app" && !s.telegramChatId)).toBe(true);
    expect(schedules[1]?.backupOf).toBe(schedules[0]?.id);
    const importedGroup = destination.store.listConversations().find(c => c.title === "Группа")!;
    expect(destination.messages.contextFor(importedGroup.id)).toMatch(/^group-[a-f0-9]{64}$/);
    expect(destination.messages.contextFor(importedGroup.id)).not.toBe(source.messages.contextFor(source.store.getTelegramChat("-12345")!.conversationId!));
    expect(destination.store.telegramChats()).toEqual([]);
    expect(destination.scheduler.runs(chat.id)[0]?.status).toBe("imported");
    await destination.scheduler.tick(new Date("2027-01-01"));
    expect(destination.turns()).toBe(0); // no agents or deliveries triggered by transfer
    expect(() => destination.archive.export()).not.toThrow(); // imported teams stay portable
    await destination.messages.handle({ channel: "api", profile: editor.id, text: "Продолжим" });
    const answer = destination.store.listMessages(chat.id).at(-1)!.text;
    expect(answer).toContain("Workspace restored from an export");
    expect(answer).toContain("Imported conversation archive");
    expect(answer).toContain("Сохраняй мой голос");
  });

  it("makes retries and re-import after a restart idempotent, rejecting changed content under an old archive ID", () => {
    const source = populated(), target = fixture(), archive = source.archive.export();
    const first = target.archive.import(archive, target.archive.preview(archive).planToken);
    const reopened = new AgentArchives(target.store, target.messages);
    const second = reopened.import(archive, "lost-response");
    expect(second.profileIds).toEqual(first.profileIds);
    expect(second.preview.alreadyImported).toBe(true);
    expect(target.store.listProfiles()).toHaveLength(3);
    archive.profiles[0]!.instructions += "modified";
    expect(() => reopened.preview(archive)).toThrow("изменено");
  });

  it("rejects a stale preview instead of silently assigning different names", () => {
    const source = populated(), target = fixture(), archive = source.archive.export();
    const preview = target.archive.preview(archive);
    target.store.createProfile({ name: "Редактор" });
    expect(() => target.archive.import(archive, preview.planToken)).toThrow("Состав команды изменился");
    expect(target.store.listProfiles()).toHaveLength(1);
  });

  it.each(["../../outside", "/etc/passwd", "file/../../escape", "C:\\temp\\file", "file\u0000.txt", "a//b", "a/./b"])("rejects unsafe file path %s before writing anything", path => {
    const source = populated(), target = fixture(), archive = source.archive.export();
    archive.workspaces.find(w => w.files.length)!.files[0]!.path = path;
    expect(() => target.archive.preview(archive)).toThrow();
    expect(target.store.listProfiles()).toHaveLength(0);
  });

  it.each(["version", "reference", "duplicate", "checksum", "caseCollision", "backupCycle", "crossChatFile", "base64", "fileAsDirectory"])("rejects corrupt %s without partially importing", field => {
    const source = populated(), target = fixture(), archive = source.archive.export();
    const work = archive.workspaces.find(w => w.files.length)!;
    switch (field) {
      case "version": (archive as any).version = 99; break;
      case "reference": archive.messages[0]!.replyToId = "missing"; break;
      case "duplicate": archive.profiles.push(archive.profiles[0]!); break;
      case "checksum": work.files[0]!.sha256 = "0".repeat(64); break;
      case "caseCollision": work.files.push({ ...work.files[0]!, path: work.files[0]!.path.toUpperCase() }); break;
      case "backupCycle": archive.schedules[0]!.backupOf = archive.schedules[1]!.id; break;
      case "crossChatFile": archive.attachments[0]!.conversationId = archive.conversations.find(c => c.profileId === "main")!.id; break;
      case "base64": work.files[0]!.content = "?"; break;
      case "fileAsDirectory": work.files.push({ ...work.files[0]!, path: work.files[0]!.path + "/child" }); break;
    }
    expect(() => target.archive.import(archive, "bad")).toThrow();
    expect(target.store.listProfiles()).toEqual([]);
    expect(target.store.listConversations()).toEqual([]);
  });

  it("rolls back rows and new folders if disk/database installation fails", () => {
    const source = populated(), target = fixture(), archive = source.archive.export();
    target.store.db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'simulated disk full'); END");
    expect(() => target.archive.import(archive, target.archive.preview(archive).planToken)).toThrow("simulated disk full");
    expect(target.store.listProfiles()).toEqual([]);
    expect(target.store.listConversations()).toEqual([]);
    expect(readdirSync(resolve(target.root, ".data/workspace"))).toEqual([]);
    expect(target.store.getSetting("agents.import." + archive.id)).toBeNull();
  });

  it("refuses symlinks and missing attachments instead of reporting an incomplete successful export", () => {
    const source = populated();
    const path = resolve(source.messages.files.workspace("work"), "secret-link");
    symlinkSync(resolve(source.root, "data.sqlite"), path);
    expect(() => source.archive.export()).toThrow("символическая ссылка");
    rmSync(path);
    rmSync(source.messages.files.get(source.file.id)!.path);
    expect(() => source.archive.export()).toThrow("повреждён");
  });

  it("serves the file only to authenticated owners and exposes imported extra chats", async () => {
    const source = populated();
    const address = await source.api.listen("127.0.0.1", 0), base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(base + "/v1/agents/archive");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(".openstrudel");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const encoded = Buffer.from(await response.arrayBuffer());
    const archive = decodeArchive(encoded);
    for (const body of ["{broken", "[]"]) {
      const invalid = await fetch(base + "/v1/agents/archive/preview", { method: "POST", body });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error).toContain("Не удалось прочитать файл");
    }
    const preview = await (await fetch(base + "/v1/agents/archive/preview", { method: "POST", body: encoded })).json();
    expect((await fetch(base + "/v1/agents/archive/import?plan=" + preview.planToken, { method: "POST", body: encoded })).status).toBe(200);
    const profiles = await (await fetch(base + "/v1/profiles")).json();
    expect(profiles.importedConversations).toHaveLength(1);
    Object.assign((source.api.mobile as any).options, { directory: resolve(source.root, "mobile"), port: 0, host: "127.0.0.1", hostname: "127.0.0.1" });
    const request = (path: string, token?: string, method = "GET") => new Promise<{ status: number; body: any }>((done, reject) => {
      const req = httpsRequest({ hostname: "127.0.0.1", port: source.api.mobile.port!, path, method, rejectUnauthorized: false, headers: token ? { authorization: "Bearer " + token } : {} }, res => {
        const parts: Buffer[] = []; res.on("data", chunk => parts.push(chunk)); res.on("end", () => { const body = Buffer.concat(parts); done({ status: res.statusCode!, body: res.headers["content-type"]?.includes("+gzip") ? decodeArchive(body) : JSON.parse(body.toString()) }); });
      }); req.on("error", reject); req.end();
    });
    const invite = new URL((await source.api.mobile.invite(false)).url);
    const phone = await request("/pair", invite.searchParams.get("key")!, "POST");
    expect((await request("/v1/agents/archive", phone.body.token)).status).toBe(403);
    expect((await request("/v1/agents/archive/preview", phone.body.token, "POST")).status).toBe(403);
    expect((await request("/v1/agents/archive")).status).toBe(401);
    const ownerInvite = new URL((await source.api.mobile.invite(true)).url);
    const owner = await request("/pair", ownerInvite.searchParams.get("key")!, "POST");
    expect((await request("/v1/agents/archive", owner.body.token)).status).toBe(200);
  });
});
