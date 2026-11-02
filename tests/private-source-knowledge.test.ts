import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { privateSourceSchedule } from "../src/private-sources.js";
import type { CodexEngine } from "../src/types.js";

const now = new Date("2026-11-03T07:00:00.000Z");
const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { f.scheduler.stop(); await f.messages.close(); f.store.close(); rmSync(f.root, { recursive: true, force: true }); }
  vi.useRealTimers(); vi.restoreAllMocks();
});
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const root = mkdtempSync(join(tmpdir(), "private-knowledge-")), store = new Store(":memory:");
  const run = vi.fn<CodexEngine["run"]>().mockResolvedValue({ threadId: "synthetic", response: "Read-only result", events: [] });
  const messages = new MessageService(store, { run }, root), scheduler = new Scheduler(store, messages);
  messages.scheduler = scheduler;
  const conversationId = store.primaryConversation().id;
  const employee = store.createProfile({ name: "Source employee", instructions: "Keep sources" });
  const sourceChat = store.profileConversation(employee.id);
  const source = store.addMessage({ conversationId: sourceChat.id, channel: "api", direction: "inbound", text: "SYNTHETIC_PRIVATE_SOURCE" });
  const save = (id = conversationId) => scheduler.save({ conversationId: id, name: "Private brief", prompt: "Find relevant evidence", cron: "* * * * *", timezone: "UTC", delivery: "app" }, new Date(now.getTime() - 60_000));
  const approve = (id: string) => {
    const current = privateSourceSchedule(store, true, conversationId, id);
    return privateSourceSchedule(store, true, conversationId, id, { enabled: true, fingerprint: current.fingerprint });
  };
  const tick = async () => { await scheduler.tick(now); await scheduler.idle(); };
  const f = { root, store, run, messages, scheduler, conversationId, sourceChat, source, save, approve, tick };
  fixtures.push(f); return f;
}
const noCatalogue = (f: ReturnType<typeof fixture>) => {
  expect(f.run).toHaveBeenCalled();
  for (const [input, options] of f.run.mock.calls) {
    expect(options?.readPaths).toBeUndefined(); expect(options?.privateSourceAccess).toBeUndefined();
    expect(input).not.toContain("catalog.json"); expect(input).not.toContain("SYNTHETIC_PRIVATE_SOURCE");
  }
  expect(existsSync(join(f.root, ".data/owner-knowledge"))).toBe(false);
};

it("reuses the bounded catalogue for an actually running approved private brief without owner or management authority", async () => {
  const f = fixture(), schedule = f.save(); f.approve(schedule.id);
  f.run.mockImplementation(async (input, options) => {
    expect(options).toMatchObject({ scheduled: true, byOwner: false, privateSourceAccess: true, access: true });
    expect(options?.project).toBeUndefined(); expect(input).toContain("catalog.json"); expect(input).not.toContain("SYNTHETIC_PRIVATE_SOURCE");
    const directory = join(f.root, ".data/owner-knowledge"); expect(options?.readPaths).toContain(directory);
    const catalog = JSON.parse(readFileSync(join(directory, "catalog.json"), "utf8"));
    const retained = catalog.sources.find((s: any) => s.conversationId === f.sourceChat.id);
    const rows = readFileSync(retained.history, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toContainEqual(expect.objectContaining({ id: f.source.id, date: f.source.createdAt, text: "SYNTHETIC_PRIVATE_SOURCE" }));
    const names = options!.tools!.definitions.map(t => t.name);
    for (const name of ["read_model_settings", "save_model_settings", "configure_telegram_chat", "bind_employee_project", "list_projects"]) expect(names).not.toContain(name);
    await expect(options!.tools!.call("list_schedules", { scope: "home" })).rejects.toThrow("администратор");
    await expect(options!.tools!.call("save_schedule", {})).rejects.toThrow("cannot create or modify schedules");
    await expect(options!.tools!.call("create_employee", {})).rejects.toThrow("Автоматическое поручение");
    return { threadId: "synthetic", response: "Read-only result", events: [] };
  });
  await f.tick(); expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("completed");
});

it.each(["unapproved", "employee", "group", "operations", "fabricated"])("does not grant a catalogue to %s work", async kind => {
  const f = fixture();
  if (kind === "operations" || kind === "fabricated") {
    await f.messages.handle({ channel: "api", conversationId: f.conversationId, text: "Find evidence", byOwner: true,
      externalId: kind === "operations" ? "operations:synthetic" : "schedule:invented", scheduled: kind === "fabricated",
      ...{ privateSourceAccess: true } }); // A forged request field is deliberately ignored.
  } else {
    if (kind === "group") f.store.setSetting("conversation.context." + f.conversationId, "group-synthetic");
    const destination = kind === "employee" ? f.store.profileConversation(f.store.createProfile({ name: "Scheduled employee" }).id).id : f.conversationId;
    f.save(destination); await f.tick();
  }
  noCatalogue(f);
});

it.each(["grant", "scope", "prompt", "audience"])("rechecks %s after scheduler admission, before building the catalogue", async change => {
  const f = fixture(), schedule = f.save(); f.approve(schedule.id);
  vi.spyOn(f.messages.projects, "begin").mockImplementationOnce(async () => {
    if (change === "grant") f.store.deleteSetting("private_sources.schedule." + schedule.id);
    if (change === "scope") f.store.setSetting("conversation.context." + f.conversationId, "group-changed");
    if (change === "prompt") f.store.db.prepare("UPDATE schedules SET prompt='Changed' WHERE id=?").run(schedule.id);
    if (change === "audience") {
      f.store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["42"] });
      f.store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id='-100'").run(f.conversationId);
    }
    return undefined;
  });
  await f.tick(); noCatalogue(f); expect(f.scheduler.runs(f.conversationId)[0]?.status).toBe("failed");
});

it("does not acquire knowledge from approval after the run was claimed", async () => {
  const f = fixture(), schedule = f.save();
  vi.spyOn(f.messages.projects, "begin").mockImplementationOnce(async () => { f.approve(schedule.id); return undefined; });
  await f.tick(); noCatalogue(f);
  expect(f.store.db.prepare("SELECT private_source_fingerprint FROM schedule_runs").get()?.private_source_fingerprint).toBeNull();
});

it("keeps native source paths out of a non-Codex provider's approved brief", async () => {
  const f = fixture(), schedule = f.save(); f.approve(schedule.id);
  f.store.setSetting("models.main", JSON.stringify({ provider: "grok", model: "grok-4", serviceTier: "default" }));
  await f.tick(); noCatalogue(f);
});
