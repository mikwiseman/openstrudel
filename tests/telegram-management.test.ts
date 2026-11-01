import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { Scheduler } from "../src/scheduler.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import { employeeTools } from "../src/personality.js";
import { saveTelegramAuthorization, type TelegramAuthorization } from "../src/authorization.js";
import { OpenStrudelRuntime } from "../src/runtime.js";

const stores: Store[] = [];
const restricted = (): TelegramAuthorization => ({ version:1,revision:0,connectors:{limited:{url:"https://example.com/mcp",headers:{}}},policies:{limited:{connectorId:"limited",tools:[]}},subjects:{},chats:{} });
afterEach(() => { vi.unstubAllGlobals(); for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new Store(":memory:"); stores.push(store);
  const run = vi.fn(async (_text: string, _options?: any) => ({ threadId: "test", response: "NO_REPLY", events: [] }));
  const messages = new MessageService(store, { run });
  const scheduler = new Scheduler(store, messages); messages.scheduler = scheduler;
  const adapter = new TelegramAdapter("123:test", store, messages); messages.telegram = adapter;
  store.setSetting("telegram.bot_username", "strudel_bot");
  store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
  store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["42"] });
  const profile = store.createProfile({ name: "Editor", instructions: "Keep sources" });
  const chat = store.bindTelegramChat("-100", profile.id);
  store.db.prepare("UPDATE telegram_chats SET access='members' WHERE chat_id='-100'").run();
  store.setSetting("access.people", JSON.stringify(["88"]));
  store.setSetting("access.managers", JSON.stringify(["77"]));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, result: { message_id: 999 } })));
  const tools = (extra: Record<string, unknown> = {}) => employeeTools(store, { run }, messages.interactions, {
    profile, conversationId: chat.conversationId!, messageId: "m", channel: "telegram", telegramSenderId: "77",
    scheduler, telegram: adapter, scope: messages.contextFor(chat.conversationId!), ...extra,
  });
  const update = (id: number, sender = 77, extra = {}): TelegramUpdate => ({ update_id: id, message: {
    message_id: id, chat: { id: -100, type: "group", title: "Team" }, from: { id: sender }, text: "@strudel_bot перенастрой расписание", ...extra,
  } });
  return { store, run, messages, scheduler, adapter, profile, chat, tools, update };
}

it("lets a verified Home manager administer from Telegram without becoming the owner", async () => {
  const { store, run, scheduler, adapter, profile, tools, update } = setup();
  const other = store.createProfile({ name: "Researcher", instructions: "Cite primary sources" });
  const conversation = store.profileConversation(other.id);
  const primary = scheduler.save({ conversationId: conversation.id, name: "Digest", prompt: "Research", cron: "0 9 * * *", timezone: "UTC", telegramChatId: "42" });
  const backup = scheduler.save({ ...primary, id: undefined, name: "Backup", cron: "5 9 * * *", backupOf: primary.id });
  run.mockImplementationOnce(async (_text, options) => {
    expect(options.byOwner).toBe(false);
    expect(options.access).toBe(true);
    expect(options.groupContext).toBe(true);
    const t = options.tools;
    expect((await t.call("list_schedules", { scope: "home" })).schedules).toHaveLength(2);
    expect(await t.call("save_schedule", { ...backup, cron: "10 9 * * *", telegramChatId: null })).toMatchObject({ backupOf: primary.id, delivery: "telegram", telegramChatId: "42" });
    await t.call("pause_schedule", { id: primary.id });
    await t.call("update_employee", { name: profile.name, instructions: "Keep sources. Be concise." });
    return { threadId: "test", response: "NO_REPLY", events: [] };
  });
  await adapter.processUpdate(update(1));
  expect(run).toHaveBeenCalledOnce();
  expect(scheduler.list(conversation.id)[0]!.enabled).toBe(false);
  expect(store.getProfile(profile.id)!.instructions).toBe("Keep sources. Be concise.");
  expect(store.getTelegramChat("77")).toBeNull();
  await expect(tools().call("connect_service", { id: "mail" })).rejects.toThrow();
});

it("does not promote service users, forwarded owners, anonymous admins, or another Home's managers", async () => {
  const { store, scheduler, adapter, run, chat, tools, update } = setup();
  const schedule = scheduler.save({ conversationId: chat.conversationId!, name: "Daily", prompt: "Read", cron: "0 9 * * *", timezone: "UTC" });
  for (const sender of ["88", "99"]) {
    await expect(tools({ telegramSenderId: sender, access: true }).call("pause_schedule", { id: schedule.id, byOwner: true, telegramSenderId: "77" })).rejects.toThrow();
  }
  run.mockImplementationOnce(async (_text, options) => {
    await expect(options.tools.call("pause_schedule", { id: schedule.id })).rejects.toThrow();
    return { threadId: "test", response: "NO_REPLY", events: [] };
  });
  await adapter.processUpdate(update(1, 88, { forward_origin: { type: "user", sender_user: { id: 77 } } }));
  await adapter.processUpdate(update(2, 77, { sender_chat: { id: -100 } }));
  await adapter.processUpdate(update(3, 77, { from: { id: 77, is_bot: true } }));
  expect(run).toHaveBeenCalledOnce();
  store.setSetting("access.managers", "[]");
  await expect(tools().call("pause_schedule", { id: schedule.id })).rejects.toThrow();
  expect(scheduler.list(chat.conversationId!)[0]!.enabled).toBe(true);
});

it("rechecks revoked management on every tool call and excludes unattended work", async () => {
  const { store, profile, tools } = setup();
  const t = tools();
  expect(await t.call("list_employees", {})).toEqual(expect.arrayContaining([expect.objectContaining({ id: profile.id })]));
  store.setSetting("access.managers", "[]");
  await expect(t.call("update_employee", { name: "Changed", instructions: "Changed" })).rejects.toThrow();
  store.setSetting("access.managers", '["77"]');
  for (const extra of [{ scheduled: true }, { channel: "api", byOwner: true, scheduled: true }]) {
    await expect(tools(extra).call("update_employee", { name: "Changed", instructions: "Changed" })).rejects.toThrow();
    await expect(tools(extra).call("create_employee", { name: "Changed", instructions: "Changed" })).rejects.toThrow();
  }
  expect(store.getProfile(profile.id)!.name).toBe("Editor");
});

it("moves a schedule with its backup and receipts, preserving delivery unless explicitly changed", async () => {
  const { store, scheduler, chat, tools } = setup();
  const target = store.createProfile({ name: "New editor" });
  const destination = store.profileConversation(target.id);
  const primary = scheduler.save({ conversationId: chat.conversationId!, name: "Daily", prompt: "Read", cron: "0 9 * * *", timezone: "UTC", delivery: "bound" });
  const backup = scheduler.save({ ...primary, id: undefined, name: "Reserve", cron: "5 9 * * *", backupOf: primary.id });
  store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES('receipt',?,?,?,'completed',?)").run(primary.id, chat.conversationId!, "2026-01-01T09:00:00Z", "2026-01-01T09:00:00Z");
  const saved = await tools().call("save_schedule", { ...primary, delivery: undefined, conversationId: destination.id, cron: "0 10 * * *" });
  expect(saved).toMatchObject({ id: primary.id, conversationId: destination.id, delivery: "telegram", telegramChatId: "-100" });
  expect(scheduler.list(destination.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: backup.id, backupOf: primary.id, telegramChatId: "-100" })]));
  expect(scheduler.runs(chat.conversationId!)).toEqual([expect.objectContaining({ id: "receipt", scheduleId: primary.id })]);
  expect(scheduler.list(chat.conversationId!)).toEqual([]);
});

it("reads then edits another employee without overwriting a concurrent edit", async () => {
  const { store, tools } = setup();
  const other = store.createProfile({ name: "Other", instructions: "Original" });
  const t = tools();
  await expect(t.call("update_employee", { id: other.id, name: other.name, instructions: "Blind overwrite" })).rejects.toThrow();
  expect(await t.call("list_employees", {})).toEqual(expect.arrayContaining([expect.objectContaining({ id: other.id, instructions: "Original" })]));
  store.updateProfile(other.id, { name: other.name, instructions: "Concurrent" });
  await expect(t.call("update_employee", { id: other.id, name: other.name, instructions: "New" })).rejects.toThrow("SOUL changed elsewhere");
  await t.call("update_employee", { id: other.id, name: other.name, instructions: "Concurrent. New." });
  expect(store.getProfile(other.id)!.instructions).toBe("Concurrent. New.");
});

it("validates model choices against the target catalog and rechecks authorization after waiting", async () => {
  const { store, tools, profile } = setup();
  const models = [{ id: "model-a", name: "Model A", provider: "chatgpt", isDefault: true, description: "", speeds: [{ id: "default", name: "Normal", description: "" }], reasoningEfforts: [{ id: "high", name: "High", description: "" }] }];
  const modelEngine = () => ({ run: vi.fn(), models: async () => models });
  const t = tools({ modelEngine });
  const selection = { scope: "employee", id: profile.id, provider: "chatgpt", model: "model-a", serviceTier: "default", reasoningEffort: "high" };
  await expect(t.call("save_model_settings", { ...selection, model: "invented" })).rejects.toThrow("недоступна");
  expect(await t.call("save_model_settings", selection)).toMatchObject({ saved: true, selection: { model: "model-a", reasoningEffort: "high" } });
  const suspended = tools({ modelEngine: () => ({ run: vi.fn(), models: async () => { store.setSetting("access.managers", "[]"); return models; } }) });
  await expect(suspended.call("save_model_settings", { ...selection, reasoningEffort: null })).rejects.toThrow("администратор");
  expect(store.getProfile(profile.id)!.reasoningEffort).toBe("high");
});

it("reassigns and pauses a connected group, but never its authorization or a protected audience", async () => {
  const { store, tools, profile } = setup();
  store.linkTelegramChat({ chatId: "-200", title: "Another group", allowedSenders: ["42"] });
  store.connectTelegramGroup("-200");
  const t = tools();
  expect(await t.call("configure_telegram_chat", { chatId: "-200", profileId: profile.id })).toMatchObject({ saved: true, chat: { profileId: profile.id } });
  expect(await t.call("configure_telegram_chat", { chatId: "-200", enabled: false })).toMatchObject({ chat: { enabled: false } });
  expect(await t.call("list_telegram_chats", { query: "Another" })).toMatchObject({ chats: [{ chatId: "-200", enabled: false }] });
  await t.call("configure_telegram_chat", { chatId: "-200", enabled: true });
  expect(store.getTelegramChat("-200")!.allowedSenders).toEqual(["42"]);
  const policy = restricted(); policy.chats["-200"] = { enabled:true,policyId:"limited",members:{},defaultCapabilities:[] }; saveTelegramAuthorization(store,policy);
  await expect(t.call("configure_telegram_chat", { chatId: "-200", enabled: false })).rejects.toThrow();
});

it("keeps a restricted subject restricted even when listed as a manager on that Home", async () => {
  const { store,tools } = setup();
  const t = tools(), policy = restricted();
  policy.subjects["77"] = { enabled:true,privatePolicyId:"limited",capabilities:[] }; saveTelegramAuthorization(store,policy);
  await expect(t.call("list_schedules",{scope:"home"})).rejects.toThrow("недоступно");
  await expect(t.call("create_employee",{name:"Escalate",instructions:""})).rejects.toThrow("недоступно");
  const otherHome = setup();
  expect(await otherHome.tools().call("create_employee",{name:"Allowed here",instructions:""})).toMatchObject({name:"Allowed here"});
});

it("leaves a schedule and its backup intact when a move is invalid or delivery is pending", async () => {
  const { store, scheduler, chat, tools } = setup();
  const target = store.profileConversation(store.createProfile({ name: "Target" }).id);
  const primary = scheduler.save({ conversationId: chat.conversationId!, name: "Daily", prompt: "Read", cron: "0 9 * * *", timezone: "UTC" });
  const backup = scheduler.save({ ...primary, id: undefined, name: "Backup", backupOf: primary.id });
  await expect(tools().call("save_schedule", { ...primary, conversationId: target.id, cron: "bad cron" })).rejects.toThrow();
  await expect(tools().call("save_schedule", { ...backup, conversationId: target.id })).rejects.toThrow("основное расписание");
  store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at) VALUES('pending',?,?,?,'ready',?)").run(backup.id,chat.conversationId!,"2026-01-01T09:00:00Z","2026-01-01T09:00:00Z");
  await expect(tools().call("save_schedule", { ...primary, conversationId: target.id })).rejects.toThrow("доставку");
  expect(scheduler.list(chat.conversationId!)).toHaveLength(2);
  expect(scheduler.list(target.id)).toEqual([]);
});

it("lets a manager reassign the current group and sends only the native confirmation", async () => {
  const { store, run, adapter, update } = setup();
  const next = store.createProfile({ name: "New editor" });
  run.mockImplementationOnce(async (_text, options) => {
    expect(await options.tools.call("configure_telegram_chat", { chatId: "-100", profileId: next.id })).toMatchObject({ saved: true });
    return { threadId: "test", response: "OLD EMPLOYEE RESPONSE MUST NOT BE SENT", events: [] };
  });
  await adapter.processUpdate(update(1));
  expect(store.getTelegramChat("-100")!.profileId).toBe(next.id);
  const sent = vi.mocked(fetch).mock.calls.filter(([url])=>String(url).endsWith("/sendMessage")).map(([,init])=>JSON.parse(String(init!.body)).text);
  expect(sent).toEqual(["Назначен сотрудник: New editor."]);
  await adapter.processUpdate(update(1));
  expect(run).toHaveBeenCalledOnce();
});

it("keeps a new reassigned Telegram request's delivery in its originating chat", async () => {
  const { store, tools } = setup();
  const target = store.profileConversation(store.createProfile({ name: "Target" }).id);
  const t = tools();
  const saved: any = await t.call("save_schedule", { name:"Daily",prompt:"Read",cron:"0 9 * * *",timezone:"UTC",conversationId:target.id,telegramChatId:null });
  expect(saved).toMatchObject({conversationId:target.id,delivery:"telegram",telegramChatId:"-100"});
  expect(await t.call("save_schedule",{...saved,delivery:"app",telegramChatId:null})).toMatchObject({delivery:"app",telegramChatId:null});
});

it("pauses the current group with one confirmation and rejects later management in the paused turn", async () => {
  const { store, run, adapter, update } = setup();
  run.mockImplementationOnce(async (_text, options) => {
    await options.tools.call("configure_telegram_chat",{chatId:"-100",enabled:false});
    await expect(options.tools.call("create_employee",{name:"Too late",instructions:""})).rejects.toThrow();
    return {threadId:"test",response:"Should be suppressed",events:[]};
  });
  await adapter.processUpdate(update(1));
  expect(store.getTelegramChat("-100")!.enabled).toBe(false);
  const sent=vi.mocked(fetch).mock.calls.filter(([url])=>String(url).endsWith("/sendMessage")).map(([,init])=>JSON.parse(String(init!.body)).text);
  expect(sent).toEqual(["Бот в этой группе приостановлен."]);
});

it("does not let an owner operations pipeline acquire interactive management rights", async () => {
  const { messages, run, profile, store } = setup();
  run.mockImplementationOnce(async (_text, options) => {
    expect(options.scheduled).toBe(true);
    await expect(options.tools.call("update_employee",{name:profile.name,instructions:"Changed"})).rejects.toThrow();
    return {threadId:"test",response:"NO_REPLY",events:[]};
  });
  await messages.handle({channel:"api",profile:profile.id,byOwner:true,externalId:"operations:test",text:"Run the saved work"});
  expect(store.getProfile(profile.id)!.instructions).toBe("Keep sources");
});

it("changes contextual participation through a verified manager and applies it to subsequent messages", async () => {
  const { store, run, adapter, update, tools } = setup();
  store.db.prepare("UPDATE telegram_chats SET replies='mentions' WHERE chat_id='-100'").run();
  const before = store.getTelegramChat("-100")!;
  run.mockImplementationOnce(async (_text, options) => {
    expect(await options.tools.call("configure_telegram_chat", { chatId: "-100", replies: "instructions" })).toMatchObject({ saved: true, chat: { replies: "instructions" } });
    return { threadId: "test", response: "Do not send this old response", events: [] };
  });
  await adapter.processUpdate(update(1));
  expect(store.getTelegramChat("-100")).toMatchObject({ replies: "instructions", access: before.access, allowedSenders: before.allowedSenders });
  expect(await tools().call("list_telegram_chats", { query: "Team" })).toMatchObject({ chats: [{ replies: "instructions" }] });
  await adapter.processUpdate(update(2, 77, { text: "And move it to tomorrow" }));
  expect(run).toHaveBeenCalledTimes(2);
  await tools().call("configure_telegram_chat", { chatId: "-100", replies: "mentions" });
  await adapter.processUpdate(update(3, 77, { text: "Ordinary conversation" }));
  expect(run).toHaveBeenCalledTimes(2);
  const sent = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/sendMessage")).map(([,init]) => JSON.parse(String(init!.body)).text);
  expect(sent).toEqual(["Бот отвечает по контексту."]);
});

it("rejects invalid participation changes, revoked managers, and protected audiences", async () => {
  const { store, tools, adapter } = setup();
  const t = tools(), before = store.getTelegramChat("-100");
  for (const args of [{ replies: "always" }, { replies: null }, { replies: "instructions", enabled: true }, { replies: "instructions", access: "members" }, { replies: "instructions", allowedSenders: ["99"] }]) {
    await expect(t.call("configure_telegram_chat", { chatId: "-100", ...args })).rejects.toThrow();
  }
  expect(store.getTelegramChat("-100")).toEqual(before);
  await expect(tools({ telegramSenderId: "88" }).call("configure_telegram_chat", { chatId: "-100", replies: "instructions" })).rejects.toThrow();
  store.setSetting("access.managers", "[]");
  await expect(t.call("configure_telegram_chat", { chatId: "-100", replies: "instructions" })).rejects.toThrow();
  store.setSetting("access.managers", '["77"]');
  const policy = restricted(); policy.chats["-100"] = { enabled: true, policyId: "limited", members: {}, defaultCapabilities: [] }; saveTelegramAuthorization(store, policy);
  store.db.prepare("UPDATE telegram_chats SET replies='instructions' WHERE chat_id='-100'").run();
  await expect(t.call("configure_telegram_chat", { chatId: "-100", replies: "instructions" })).rejects.toThrow();
  expect(adapter.status().chats.find(chat => chat.chatId === "-100")?.replies).toBe("mentions");
});

it("returns at most 30 Home schedule receipts, with authorized target filtering and no protected chat history", async () => {
  const { store, scheduler, chat, tools } = setup();
  const other = store.profileConversation(store.createProfile({ name: "Other" }).id);
  store.linkTelegramChat({ chatId: "-200", title: "Protected", allowedSenders: ["42"] });
  const protectedChat = store.connectTelegramGroup("-200");
  const policy = restricted(); policy.chats["-200"] = { enabled: true, policyId: "limited", members: {}, defaultCapabilities: [] }; saveTelegramAuthorization(store, policy);
  const insert = store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,error) VALUES(?,?,?,?,?,?,?)");
  for (const conversationId of [chat.conversationId!, other.id, protectedChat.conversationId!]) {
    const schedule = scheduler.save({ conversationId, name: "Daily", prompt: "Read", cron: "0 9 * * *", timezone: "UTC" });
    for (let i = 0; i < 35; i++) {
      const date = new Date(Date.UTC(2026, 0, 1, 9, i)).toISOString();
      insert.run(`${conversationId}:${i}`, schedule.id, conversationId, date, "failed", date, "Connector unavailable");
    }
  }
  const t = tools(), home: any = await t.call("list_schedules", { scope: "home" });
  expect(home.runs).toHaveLength(30);
  expect(new Set(home.runs.map((run: any) => run.conversationId))).toEqual(new Set([chat.conversationId, other.id]));
  expect(home.runs[0]).toMatchObject({ status: "failed", error: "Connector unavailable" });
  const target: any = await t.call("list_schedules", { scope: "home", conversationId: other.id });
  expect(target.runs).toHaveLength(30);
  expect(target.runs.every((run: any) => run.conversationId === other.id)).toBe(true);
  expect(target.schedules).toHaveLength(1);
  expect(target.runs[0].scheduledFor).toBe("2026-01-01T09:34:00.000Z");
  for (const conversationId of [protectedChat.conversationId, "another-home-conversation"]) {
    await expect(t.call("list_schedules", { scope: "home", conversationId })).rejects.toThrow();
  }
  await expect(tools({ telegramSenderId: "88" }).call("list_schedules", { scope: "home" })).rejects.toThrow();
  await expect(tools({ telegramSenderId: "88" }).call("list_schedules", { conversationId: other.id })).rejects.toThrow();
  expect((await tools({ telegramSenderId: "88" }).call("list_schedules", {}) as any).runs.every((run: any) => run.conversationId === chat.conversationId)).toBe(true);
});

it("uses the owner API to configure participation without changing access or protected policies", async () => {
  vi.unstubAllGlobals();
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", startTelegram: false, apiToken: "owner", engine: { run: async () => ({ threadId: "test", response: "OK", events: [] }) } });
  const { port } = await runtime.api.listen("127.0.0.1", 0);
  const call = (body: unknown, headers: Record<string, string> = { authorization: "Bearer owner" }, chatId = "-100") => fetch(`http://127.0.0.1:${port}/v1/integrations/telegram/chats/${chatId}`, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    runtime.store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["42"] }); runtime.store.connectTelegramGroup("-100");
    const before = runtime.store.getTelegramChat("-100")!;
    expect(await (await call({ replies: "mentions" })).json()).toMatchObject({ telegram: { chats: [{ replies: "mentions", access: before.access, allowedSenders: before.allowedSenders }] } });
    for (const body of [{ replies: "always" }, { replies: null }, { replies: "instructions", enabled: true }, { replies: "instructions", access: "members" }]) expect((await call(body)).status).toBe(400);
    expect(runtime.store.getTelegramChat("-100")!.replies).toBe("mentions");
    const login = await fetch(`http://127.0.0.1:${port}/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: runtime.api.web.invite(false).key }) });
    const { csrf } = await login.json();
    expect((await call({ replies: "instructions" }, { cookie: login.headers.get("set-cookie")!.split(";")[0]!, "x-openstrudel-csrf": csrf })).status).toBe(403);
    const policy = restricted(); policy.chats["-100"] = { enabled: true, policyId: "limited", members: {}, defaultCapabilities: [] }; saveTelegramAuthorization(runtime.store, policy);
    expect((await call({ replies: "instructions" })).status).toBe(400);
    expect(runtime.store.getTelegramChat("-100")!.replies).toBe("mentions");
  } finally { await runtime.stop(); }
});

it("never broadens a participant's schedule reads for empty or malformed conversation IDs", async () => {
  const { store, scheduler, chat, tools } = setup();
  const other = store.profileConversation(store.createProfile({ name: "Private" }).id);
  for (const conversationId of [chat.conversationId!, other.id]) {
    const schedule = scheduler.save({ conversationId, name: "Daily", prompt: `Work for ${conversationId}`, cron: "0 9 * * *", timezone: "UTC" });
    store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,error) VALUES(?,?,?,'2026-01-01T09:00:00Z','failed','2026-01-01T09:00:00Z',?)")
      .run(conversationId, schedule.id, conversationId, `Details for ${conversationId}`);
  }
  const participant = tools({ telegramSenderId: "88" });
  for (const conversationId of ["", "   ", "\n\t", 42, false, [], {}, other.id]) {
    await expect(participant.call("list_schedules", { conversationId })).rejects.toThrow();
  }
  for (const args of [{}, { conversationId: null }, { conversationId: chat.conversationId }]) {
    const result: any = await participant.call("list_schedules", args);
    expect(result.schedules).toEqual([expect.objectContaining({ conversationId: chat.conversationId })]);
    expect(result.runs).toEqual([expect.objectContaining({ conversationId: chat.conversationId })]);
  }
});
