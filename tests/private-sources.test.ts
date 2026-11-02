import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Scheduler } from "../src/scheduler.js";
import { MessageService } from "../src/messages.js";
import { MockCodexEngine } from "../src/codex.js";
import { privateSourceAudience, privateSourceSchedule, privateSourceTools, unipileSettings } from "../src/private-sources.js";
import { UnipileAdapter } from "../src/unipile.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";

const stores: Store[] = [];
let sequence = 0;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const s of stores.splice(0)) s.close(); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const conversation = store.primaryConversation();
  const context: TelegramToolContext = { conversationId: conversation.id, messageId: "owner-request", channel: "api", byOwner: true, scope: "personal" };
  const messages = new MessageService(store, new MockCodexEngine()), scheduler = new Scheduler(store, messages);
  unipileSettings(store, true, { accounts: [{ accountId: "acc_owner", provider: "linkedin", providerUserId: "owner-id" }] });
  const schedule = () => scheduler.save({ conversationId: conversation.id, name: "Private focus", prompt: "Read only, return here", cron: "0 7 * * *", timezone: "Europe/Moscow", delivery: "app" });
  const running = (id: string, runId = "actual-run") => {
    const inbound = store.addMessage({ conversationId: conversation.id, channel: "api", direction: "inbound", text: "Scheduled request", externalId: "schedule:" + runId });
    store.db.prepare("UPDATE messages SET status='running' WHERE id=?").run(inbound.id);
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,private_source_fingerprint) VALUES(?,?,?,?,?,?,?)")
      .run(runId, id, conversation.id, new Date(Date.now() + sequence++).toISOString(), "running", new Date().toISOString(), store.getSetting("private_sources.schedule." + id));
    return { ...context, messageId: inbound.id, scheduled: true, byOwner: false, scheduleTelegramChatId: null };
  };
  return { store, conversation, context, messages, scheduler, schedule, running };
}

describe("private message source audience", () => {
  it("exposes read tools only to the current main private owner, not a manager, group or employee", () => {
    const f = fixture();
    expect(privateSourceAudience(f.store, f.context)).toBe(true);
    expect(privateSourceTools(f.store, "/unused", f.context).definitions.map(t => t.name)).toEqual(["unipile_accounts", "unipile_read"]);
    for (const patch of [{ byOwner: false }, { access: false }, { scope: "group-one" }, { scheduled: true }, { channel: "telegram" as const, telegramSenderId: "77" }])
      expect(privateSourceTools(f.store, "/unused", { ...f.context, ...patch }).definitions).toEqual([]);
    const employee = f.store.createProfile({ name: "Employee" });
    expect(privateSourceAudience(f.store, { ...f.context, conversationId: f.store.profileConversation(employee.id).id })).toBe(false);
    f.store.linkTelegramChat({ chatId: "-100", title: "Group", allowedSenders: ["42"] });
    f.store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id='-100'").run(f.context.conversationId);
    expect(privateSourceAudience(f.store, f.context)).toBe(false);
  });

  it("rechecks the exact paired owner DM and revocation", () => {
    const f = fixture();
    const conversation = f.store.getOrCreateConversation({ channel: "telegram", externalId: "42" });
    f.store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
    const context = { ...f.context, conversationId: conversation.id, channel: "telegram" as const, telegramSenderId: "42" };
    expect(privateSourceAudience(f.store, context)).toBe(true);
    f.store.setSetting("telegram.paused.42", "true");
    expect(privateSourceAudience(f.store, context)).toBe(false);
    f.store.deleteSetting("telegram.paused.42");
    f.store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: [] });
    expect(privateSourceAudience(f.store, context)).toBe(false);
  });

  it("requires a current owner-approved fingerprint and real running scheduler record, never a message flag", () => {
    const f = fixture(), schedule = f.schedule(), early = f.running(schedule.id,"unapproved-run");
    expect(privateSourceAudience(f.store, early)).toBe(false);
    expect(() => privateSourceSchedule(f.store, false, f.conversation.id, schedule.id)).toThrow("owner");
    const before = privateSourceSchedule(f.store, true, f.conversation.id, schedule.id);
    expect(before.enabled).toBe(false);
    expect(() => privateSourceSchedule(f.store, true, f.conversation.id, schedule.id, { enabled: true, fingerprint: "old" })).toThrow("changed");
    privateSourceSchedule(f.store, true, f.conversation.id, schedule.id, { enabled: true, fingerprint: before.fingerprint });
    // A grant made while a run is already in flight applies to future runs only.
    expect(privateSourceAudience(f.store, early)).toBe(false);
    const context = f.running(schedule.id);
    expect(privateSourceAudience(f.store, context)).toBe(true);
    expect(privateSourceAudience(f.store, { ...context, messageId: "fabricated" })).toBe(false);
    expect(privateSourceAudience(f.store, { ...context, scheduleTelegramChatId: "-100" })).toBe(false);
    f.store.db.prepare("UPDATE schedule_runs SET status='completed' WHERE id='actual-run'").run();
    expect(privateSourceAudience(f.store, context)).toBe(false);
  });

  it.each(["prompt", "name", "timezone", "cron", "conversation_id", "delivery", "telegram_chat_id", "enabled"])("invalidates a scheduled grant after %s changes", field => {
    const f = fixture(), schedule = f.schedule();
    const state = privateSourceSchedule(f.store, true, f.conversation.id, schedule.id);
    privateSourceSchedule(f.store, true, f.conversation.id, schedule.id, { enabled: true, fingerprint: state.fingerprint });
    const context = f.running(schedule.id); expect(privateSourceAudience(f.store, context)).toBe(true);
    const value = field === "enabled" ? 0 : field === "conversation_id" ? f.store.getOrCreateConversation({ channel: "api", externalId: "other" }).id : "changed";
    f.store.db.prepare(`UPDATE schedules SET ${field}=? WHERE id=?`).run(value, schedule.id);
    expect(privateSourceAudience(f.store, context)).toBe(false);
  });

  it("allows an exact paired owner destination, never another person or group", () => {
    const f = fixture();
    f.store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
    f.store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["42"] });
    const s = f.schedule();
    f.store.db.prepare("UPDATE schedules SET delivery='telegram',telegram_chat_id='42' WHERE id=?").run(s.id);
    const state = privateSourceSchedule(f.store, true, f.conversation.id, s.id);
    privateSourceSchedule(f.store, true, f.conversation.id, s.id, { enabled: true, fingerprint: state.fingerprint });
    expect(privateSourceAudience(f.store, { ...f.running(s.id), scheduleTelegramChatId: "42" })).toBe(true);
    f.store.db.prepare("UPDATE schedules SET telegram_chat_id='-100' WHERE id=?").run(s.id);
    expect(() => privateSourceSchedule(f.store, true, f.conversation.id, s.id)).toThrow("private");
  });

  it("does not return fetched source bodies after authorization changes while awaiting the provider", async () => {
    const f = fixture(); let resolve!: (value: any) => void;
    vi.spyOn(UnipileAdapter.prototype, "accounts").mockImplementation(() => new Promise(done => { resolve = done; }));
    const tools = privateSourceTools(f.store, "/unused", f.context);
    const pending = tools.call("unipile_accounts", {});
    const rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    f.context.byOwner = false;
    resolve({ accounts: [{ private: "must not return" }] });
    await rejected;
  });

  it.each(["work", "group-shared-workspace"])("rechecks the live %s source scope before returning a fetched body", async scope => {
    const f = fixture(); let resolve!: (value: any) => void;
    vi.spyOn(UnipileAdapter.prototype, "accounts").mockImplementation(() => new Promise(done => { resolve = done; }));
    const tools = privateSourceTools(f.store, "/unused", f.context);
    const pending = tools.call("unipile_accounts", {}), rejected = expect(pending).rejects.toMatchObject({ status: 403 });
    f.store.setSetting("conversation.context." + f.conversation.id, scope);
    expect(f.messages.contextFor(f.conversation.id)).toBe(scope);
    expect(f.context.scope).toBe("personal"); // The running tool still has its old context.
    resolve({ accounts: [{ private: "must not return" }] });
    await rejected;
    expect(privateSourceTools(f.store, "/unused", f.context).definitions).toEqual([]);
    expect(() => privateSourceSchedule(f.store, true, f.conversation.id, f.schedule().id)).toThrow("private");
  });

  it("binds a recurring grant to the current private audience as well as its schedule", () => {
    const f = fixture(), schedule = f.schedule();
    const before = privateSourceSchedule(f.store, true, f.conversation.id, schedule.id);
    privateSourceSchedule(f.store, true, f.conversation.id, schedule.id, { enabled: true, fingerprint: before.fingerprint });
    const context = f.running(schedule.id); expect(privateSourceAudience(f.store, context)).toBe(true);
    f.store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
    f.store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id='42'").run(f.conversation.id);
    expect(f.messages.contextFor(f.conversation.id)).toBe("personal");
    const changed = privateSourceSchedule(f.store, true, f.conversation.id, schedule.id);
    expect(changed.fingerprint).not.toBe(before.fingerprint); expect(changed.enabled).toBe(false);
    expect(privateSourceAudience(f.store, context)).toBe(false);
  });

  it("rejects one-time grants before the real scheduler disarms and executes them", async () => {
    const at = new Date("2026-11-03T07:00:00.000Z"); vi.useFakeTimers(); vi.setSystemTime(at);
    const f = fixture(), root = mkdtempSync(join(tmpdir(), "strudel-private-once-"));
    const accountRead = vi.spyOn(UnipileAdapter.prototype, "accounts"); let seen: string[] = [];
    const messages = new MessageService(f.store, { async run(_text, options) {
      seen = options!.tools!.definitions.map(tool => tool.name);
      return { threadId: "synthetic-once", response: "No private-source access was granted.", events: [] };
    } }, root);
    const scheduler = new Scheduler(f.store, messages); messages.scheduler = scheduler;
    try {
      const schedule = scheduler.save({ conversationId: f.conversation.id, name: "One-time read", prompt: "Read private sources",
        cron: "@once 2026-11-03T07:01:00.000Z", timezone: "UTC", delivery: "app" }, at);
      for (const input of [undefined, { enabled: true, fingerprint: "unknown" }]) {
        expect(() => privateSourceSchedule(f.store, true, f.conversation.id, schedule.id, input)).toThrow("recurring private brief");
        try { privateSourceSchedule(f.store, true, f.conversation.id, schedule.id, input); } catch (error) { expect(error).toMatchObject({ status: 400 }); }
      }
      expect(f.store.getSetting("private_sources.schedule." + schedule.id)).toBeNull();
      vi.setSystemTime(new Date("2026-11-03T07:01:00.000Z"));
      await scheduler.tick(new Date()); await scheduler.idle();
      expect(scheduler.list(f.conversation.id).find(s => s.id === schedule.id)?.enabled).toBe(false);
      expect(scheduler.runs(f.conversation.id)).toHaveLength(1);
      expect(seen).not.toContain("unipile_accounts"); expect(seen).not.toContain("unipile_read"); expect(accountRead).not.toHaveBeenCalled();
    } finally { scheduler.stop(); await messages.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("validates explicit account settings and clears access without accepting permission fields", () => {
    const f = fixture();
    expect(() => unipileSettings(f.store, false)).toThrow("owner");
    expect(() => unipileSettings(f.store, true, { accounts: [], byOwner: true })).toThrow("only");
    expect(() => unipileSettings(f.store, true, { accounts: [{ accountId: "acc_owner", provider: "linkedin" }] })).toThrow("identity");
    expect(unipileSettings(f.store, true, { accounts: [] })).toEqual({ accounts: [], configured: false });
    expect(privateSourceTools(f.store, "/unused", f.context).definitions).toEqual([]);
  });
});
