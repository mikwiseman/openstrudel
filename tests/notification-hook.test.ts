import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { HttpApi } from "../src/server.js";
import { digest } from "../src/home.js";
import { homeRequest, requestJSON, resultJSON } from "../src/home-transport.js";
import { saveTelegramAuthorization } from "../src/authorization.js";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";

const nativeFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllGlobals(); });
async function setup(destinations: Record<string, unknown> = { chatId: "42" }) {
  const root = mkdtempSync(join(tmpdir(), "strudel-notification-"));
  const store = new Store(join(root, "db.sqlite"));
  store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
  store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: [] }); store.connectTelegramGroup("-100");
  store.setSetting("telegram.notification_hook", JSON.stringify({ ...destinations, tokenHash: digest("notification-secret") }));
  const engine = { run: vi.fn(async () => { throw new Error("Notifications must not run an agent"); }) };
  const messages = new MessageService(store, engine, root);
  const telegram = new TelegramAdapter("1:test", store, messages);
  const api = new HttpApi(store, messages, telegram, "owner-secret", undefined, engine, { mobileDirectory: join(root, "mobile"), mobilePort: 0 });
  const address = await api.listen("127.0.0.1", 0);
  const send = vi.fn(async () => Response.json({ ok: true, result: { message_id: 123 } }));
  vi.stubGlobal("fetch", send);
  const post = (body: unknown, key = "meeting-card:one:v1", token = "notification-secret") => nativeFetch(`http://127.0.0.1:${address.port}/hooks/telegram`, {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body),
  });
  cleanups.push(async () => { await api.close(); telegram.stop(); await messages.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, engine, send, api, post, base: `http://127.0.0.1:${address.port}` };
}

it("relays the supplied text once to the configured chat and records it without running AI", async () => {
  const { post, store, engine, send } = await setup();
  const body = { text: "Meeting ready", chatId: "999", sessionId: "one", summary: "Do not forward extra fields" };
  const first = await post(body); expect(first.status).toBe(200);
  const receipt = await first.json(); expect(receipt).toMatchObject({ sent: true, chatId: "42", status: "delivered" });
  expect((await post(body)).status).toBe(200); expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({ chat_id: "42", text: "Meeting ready" });
  expect(store.findMessageByExternal("telegram", "notification:" + digest("42\0meeting-card:one:v1"))?.text).toBe("Meeting ready");
  expect(engine.run).not.toHaveBeenCalled();
});

it("rejects missing or wrong credentials and never grants API access to a notification token", async () => {
  const { post, send, base, store } = await setup();
  for (const token of ["", "wrong", "owner-secret"]) expect((await post({ text: "No" }, "one", token)).status).toBe(401);
  expect((await nativeFetch(base + "/v1/profiles", { headers: { authorization: "Bearer notification-secret" } })).status).toBe(401);
  store.setSetting("telegram.notification_hook", "null");
  expect((await post({ text: "No" })).status).toBe(401);
  expect(send).not.toHaveBeenCalled();
});

it("rejects missing identity, empty text and changed content on a repeated identity", async () => {
  const { post, send } = await setup();
  expect((await post({ text: "No" }, "")).status).toBe(400);
  expect((await post({ text: "" })).status).toBe(400);
  expect((await post({ text: "Original" })).status).toBe(200);
  expect((await post({ text: "Replacement" })).status).toBe(409);
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not acknowledge or repeat an uncertain Telegram delivery", async () => {
  const { post, send } = await setup(); send.mockRejectedValue(new Error("connection lost"));
  for (const attempt of [1, 2]) {
    const response = await post({ text: "Once" }); expect(response.status, `attempt ${attempt}`).toBe(502);
    expect(await response.json()).toEqual({ error: "Доставка не подтверждена; проверьте Telegram перед новой отправкой." });
  }
  expect(send).toHaveBeenCalledTimes(1);
});

it("relays one notification to every listed chat once, each under its own identity", async () => {
  const { post, store, send } = await setup({ chatIds: ["42", "-100"] });
  const first = await post({ text: "Meeting ready" }); expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ sent: true, status: "delivered", chatId: "42", deliveries: [
    { sent: true, status: "delivered", chatId: "42", title: "Owner", telegramMessageIds: ["123"] },
    { sent: true, status: "delivered", chatId: "-100", title: "Team", telegramMessageIds: ["123"] }] });
  expect((await post({ text: "Meeting ready" })).status).toBe(200);
  expect(send.mock.calls.map(call => JSON.parse(String(call[1]?.body)).chat_id)).toEqual(["42", "-100"]);
  for (const chatId of ["42", "-100"]) expect(store.findMessageByExternal("telegram", "notification:" + digest(chatId + "\0meeting-card:one:v1"))?.text).toBe("Meeting ready");
});

it("keeps the single-chat receipt when one chat is listed", async () => {
  const { post } = await setup({ chatIds: ["42"] });
  const receipt = await (await post({ text: "Meeting ready" })).json();
  expect(Object.keys(receipt).sort()).toEqual(["chatId", "messageId", "sent", "status", "telegramMessageIds", "title"]);
  expect(receipt).toMatchObject({ sent: true, status: "delivered", chatId: "42", title: "Owner", telegramMessageIds: ["123"] });
});

it("uses chatIds and ignores chatId when the setting has both", async () => {
  const { post, send } = await setup({ chatId: "42", chatIds: ["-100"] });
  expect((await post({ text: "Meeting ready" })).status).toBe(200);
  expect(send.mock.calls.map(call => JSON.parse(String(call[1]?.body)).chat_id)).toEqual(["-100"]);
});

it("accepts 1 to 10 distinct chat ids", async () => {
  const { post, store, send } = await setup();
  const ids = Array.from({ length: 11 }, (_, index) => String(index + 1));
  const configure = (chatIds: unknown) => store.setSetting("telegram.notification_hook", JSON.stringify({ chatIds, tokenHash: digest("notification-secret") }));
  for (const chatIds of [[], ["42", "42"], ids, ["42", "team"], "42"]) { configure(chatIds); expect((await post({ text: "No" })).status, JSON.stringify(chatIds)).toBe(401); }
  // Ten unconnected chats pass the setting check and then fail as destinations.
  configure(ids.slice(0, 10)); expect((await post({ text: "No" })).status).toBe(400);
  expect(send).not.toHaveBeenCalled();
});

it("sends nothing unless every listed chat can receive it", async () => {
  const { post, store, send } = await setup({ chatIds: ["42", "-100"] });
  store.setSetting("telegram.paused.-100", "true");
  const paused = await post({ text: "Meeting ready" });
  expect(paused.status).toBe(400); expect(await paused.json()).toEqual({ error: "Бот больше не подключён к этому чату." });
  store.deleteSetting("telegram.paused.-100"); store.db.prepare("DELETE FROM telegram_chats WHERE chat_id='-100'").run();
  expect((await post({ text: "Meeting ready" })).status).toBe(400);
  expect(send).not.toHaveBeenCalled();
});

it("answers 409 for text changed on a later chat before checking or sending to any chat", async () => {
  const { post, store, send } = await setup({ chatIds: ["42"] });
  expect((await post({ text: "Original" })).status).toBe(200);
  store.setSetting("telegram.notification_hook", JSON.stringify({ chatIds: ["-100", "42"], tokenHash: digest("notification-secret") }));
  expect((await post({ text: "Changed" })).status).toBe(409);
  store.setSetting("telegram.paused.-100", "true");
  expect((await post({ text: "Changed" })).status).toBe(409);
  expect(send).toHaveBeenCalledTimes(1);
});

it("answers 502 with each chat's receipt and resends to none after a partly confirmed delivery", async () => {
  const { post, send } = await setup({ chatIds: ["42", "-100"] });
  send.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 123 } })).mockRejectedValueOnce(new Error("connection lost"));
  for (const attempt of [1, 2]) {
    const response = await post({ text: "Once" }); expect(response.status, `attempt ${attempt}`).toBe(502);
    expect(await response.json()).toMatchObject({ error: "Доставка не подтверждена; проверьте Telegram перед новой отправкой.", sent: false, status: "unknown", chatId: "42",
      deliveries: [{ chatId: "42", sent: true, status: "delivered" }, { chatId: "-100", sent: false, status: "unknown" }] });
  }
  expect((await post({ text: "Changed" })).status).toBe(409);
  expect(send).toHaveBeenCalledTimes(2);
});

it("reports a chat that Telegram refused as a partial delivery", async () => {
  const { post, send } = await setup({ chatIds: ["42", "-100"] });
  send.mockImplementation(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).chat_id === "-100"
    ? Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was kicked" }, { status: 403 })
    : Response.json({ ok: true, result: { message_id: 123 } }));
  const response = await post({ text: "Once" }); expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ sent: false, status: "partial", deliveries: [{ status: "delivered" }, { status: "not_sent" }] });
});

it("reports not_sent when Telegram refused every chat", async () => {
  const { post, send } = await setup({ chatIds: ["42", "-100"] });
  send.mockImplementation(async () => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was kicked" }, { status: 403 }));
  const response = await post({ text: "Once" }); expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ sent: false, status: "not_sent", deliveries: [{ status: "not_sent" }, { status: "not_sent" }] });
});

it("reports pending rather than partial while an earlier request is still sending to a chat", async () => {
  const { post, send } = await setup({ chatIds: ["42", "-100"] });
  let release!: () => void;
  send.mockImplementationOnce(async () => Response.json({ ok: true, result: { message_id: 123 } }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { release = () => resolve(Response.json({ ok: true, result: { message_id: 124 } })); }));
  const first = post({ text: "Once" });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  const repeat = await post({ text: "Once" }); expect(repeat.status).toBe(502);
  expect(await repeat.json()).toMatchObject({ sent: false, status: "pending", deliveries: [{ status: "delivered" }, { status: "pending" }] });
  release(); expect((await first).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(2);
});

it("reports a chat that stopped being available while an earlier chat was sent", async () => {
  const { post, store, send } = await setup({ chatIds: ["42", "-100"] });
  send.mockImplementationOnce(async () => { store.setSetting("telegram.paused.-100", "true"); return Response.json({ ok: true, result: { message_id: 123 } }); });
  const response = await post({ text: "Once" }); expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ sent: false, status: "partial", chatId: "42", deliveries: [{ chatId: "42", sent: true, status: "delivered" },
    { chatId: "-100", sent: false, status: "not_sent", error: "Бот больше не подключён к этому чату." }] });
  // The Home never tried that chat, so a repeat sends there and only there.
  store.deleteSetting("telegram.paused.-100");
  expect((await post({ text: "Once" })).status).toBe(200);
  expect(send.mock.calls.map(call => JSON.parse(String(call[1]?.body)).chat_id)).toEqual(["42", "-100"]);
});

it("keeps relaying to a group after Telegram upgrades it to a supergroup", async () => {
  // A setting can keep chatId for a Home that reads only that field, so both forms move.
  const { post, store, send } = await setup({ chatId: "-100", chatIds: ["42", "-100"] });
  store.migrateTelegramGroup("-100", "-100200");
  expect(JSON.parse(store.getSetting("telegram.notification_hook")!)).toEqual({ chatId: "-100200", chatIds: ["42", "-100200"], tokenHash: digest("notification-secret") });
  expect((await post({ text: "Meeting ready" })).status).toBe(200);
  expect(send.mock.calls.map(call => JSON.parse(String(call[1]?.body)).chat_id)).toEqual(["42", "-100200"]);
});

it("uses the same scoped authentication through the remote HTTPS listener", async () => {
  const { api, send } = await setup();
  const endpoint = await api.mobile.endpoint(); const url = new URL(endpoint.url); url.hostname = "127.0.0.1";
  const remote = { ...endpoint, url: url.toString() };
  const request = { method: "POST", body: requestJSON({ text: "Remote meeting" }) };
  expect((await homeRequest(remote, "/hooks/telegram", "wrong", request, 5000, { "idempotency-key": "remote:1" })).status).toBe(401);
  const response = await homeRequest(remote, "/hooks/telegram", "notification-secret", request, 5000, { "idempotency-key": "remote:1" });
  expect(response.status).toBe(200); expect(resultJSON(response).sent).toBe(true); expect(send).toHaveBeenCalledTimes(1);
});

// Narrow keys: each relays to one chat of its own list per request, and only a key may reach a protected group the policy keeps enabled.
const keys = (store: Store, list: unknown[], legacy: Record<string, unknown> = { chatId: "42" }) =>
  store.setSetting("telegram.notification_hook", JSON.stringify({ ...legacy, tokenHash: digest("notification-secret"), keys: list }));
const drafts = { id: "school-drafts", tokenHash: digest("drafts-secret"), chatIds: ["42"] };
const reports = { id: "school-reports", tokenHash: digest("reports-secret"), chatIds: ["-100", "-200"] };
const family = (enabled: boolean, revision: number) => ({ version: 1, revision,
  connectors: { school: { url: "https://school.example/mcp", headers: { Authorization: "Bearer school-secret" } } },
  policies: { family: { connectorId: "school", tools: [{ name: "family_report", capability: "report.read" }] },
    mentor: { connectorId: "school", tools: [{ name: "mentor_schedule", capability: "schedule.read" }] } },
  subjects: { "22": { enabled: true, privatePolicyId: "mentor", capabilities: ["schedule.read"] } },
  chats: { "-100": { enabled, policyId: "family", defaultCapabilities: ["report.read"], members: {} } } });
// The journal table appears with the first delivery attempt.
const journal = (store: Store) => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_deliveries'").get()
  ? store.db.prepare("SELECT caller,chat_id,idempotency_key,text_sha256,status,attempts FROM notification_deliveries ORDER BY created_at").all() : [];
const sentTo = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map(call => JSON.parse(String(call[1]?.body)).chat_id);

it("relays a narrow key's text to its one chat without running AI and journals the delivery", async () => {
  const { post, store, engine, send } = await setup(); keys(store, [drafts]);
  const first = await post({ text: "Черновик отчёта", summary: "ignored" }, "draft:lesson-1:v1", "drafts-secret");
  expect(first.status).toBe(200); expect(await first.json()).toMatchObject({ sent: true, status: "delivered", chatId: "42" });
  expect((await post({ text: "Черновик отчёта" }, "draft:lesson-1:v1", "drafts-secret")).status).toBe(200);
  expect(sentTo(send)).toEqual(["42"]); expect(engine.run).not.toHaveBeenCalled();
  expect(store.findMessageByExternal("telegram", "notification:" + digest("school-drafts\0" + "42\0draft:lesson-1:v1"))?.text).toBe("Черновик отчёта");
  expect(journal(store)).toEqual([{ caller: "school-drafts", chat_id: "42", idempotency_key: "draft:lesson-1:v1",
    text_sha256: createHash("sha256").update("Черновик отчёта").digest("hex"), status: "delivered", attempts: 2 }]);
});

it("makes a narrow key name one chat of its own list and never reach another chat", async () => {
  const { post, store, send } = await setup(); keys(store, [drafts, reports]);
  store.linkTelegramChat({ chatId: "-200", title: "Other family", allowedSenders: [] }); store.connectTelegramGroup("-200");
  expect((await post({ text: "Отчёт" }, "report:1:v1", "reports-secret")).status).toBe(400);
  for (const chatId of ["42", "-300", 100, ["-100"], "-0100"]) expect((await post({ text: "Отчёт", chatId }, "report:1:v1", "reports-secret")).status, JSON.stringify(chatId)).toBe(chatId === "42" || chatId === "-300" ? 403 : 400);
  expect((await post({ text: "Черновик", chatId: "-100" }, "draft:1:v1", "drafts-secret")).status).toBe(403);
  expect(send).not.toHaveBeenCalled();
  expect((await post({ text: "Отчёт", chatId: "-200" }, "report:1:v1", "reports-secret")).status).toBe(200);
  // The original credential keeps its own destination and still ignores a requested chat.
  expect((await post({ text: "Встреча", chatId: "-200" })).status).toBe(200);
  expect(sentTo(send)).toEqual(["-200", "42"]);
});

it("lets only a narrow key post to a protected group, and only while the policy keeps it enabled", async () => {
  const { post, store, send } = await setup();
  saveTelegramAuthorization(store, family(true, 0));
  keys(store, [reports, { id: "mentor-dm", tokenHash: digest("mentor-secret"), chatIds: ["22"] }], { chatIds: ["-100"] });
  store.linkTelegramChat({ chatId: "22", title: "Mentor", allowedSenders: [] });
  // The original credential never reaches a protected audience.
  const legacy = await post({ text: "Внешнее уведомление" }); expect(legacy.status).toBe(400);
  expect(await legacy.json()).toEqual({ error: "Отправка в чат с ограниченным доступом недоступна." });
  // Neither does a key listing a limited participant's private chat.
  expect((await post({ text: "Ученики" }, "dm:1", "mentor-secret")).status).toBe(403);
  expect(send).not.toHaveBeenCalled();
  const delivered = await post({ text: "Отчёт за неделю: https://wai.school/report/sasha-d12/3", chatId: "-100", linkPreview: true }, "report:3:v1", "reports-secret");
  expect(delivered.status).toBe(200); expect(await delivered.json()).toMatchObject({ sent: true, chatId: "-100" });
  expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({ chat_id: "-100", link_preview_options: { is_disabled: false } });
  saveTelegramAuthorization(store, family(false, 1));
  const closed = await post({ text: "Отчёт 4", chatId: "-100" }, "report:4:v1", "reports-secret"); expect(closed.status).toBe(403);
  expect(await closed.json()).toEqual({ error: "Этот чат сейчас закрыт для отправки." });
  expect(sentTo(send)).toEqual(["-100"]);
  expect((await post({ text: "Отчёт", chatId: "-100", silent: "yes" }, "report:5:v1", "reports-secret")).status).toBe(400);
});

it("keeps a key's request to one Telegram message", async () => {
  const { post, store, send } = await setup();
  saveTelegramAuthorization(store, family(true, 0)); keys(store, [reports]);
  const long = await post({ text: "Отчёт. ".repeat(1200), chatId: "-100" }, "report:long:v1", "reports-secret");
  expect(long.status).toBe(400); expect(await long.json()).toEqual({ error: "Текст ключа — одно сообщение Telegram, до 4096 знаков." });
  expect(send).not.toHaveBeenCalled(); expect(journal(store)).toEqual([]);
});

it("refuses a key revoked while its request body was still arriving", async () => {
  const { store, send, base } = await setup(); keys(store, [drafts, reports]);
  const url = new URL(base + "/hooks/telegram");
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: { authorization: "Bearer drafts-secret", "content-type": "application/json", "idempotency-key": "draft:slow:v1" } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on("error", reject);
    request.write('{"text":"Черно');
    setTimeout(() => { keys(store, [reports]); request.end('вик"}'); }, 50);
  });
  expect(status).toBe(401); expect(send).not.toHaveBeenCalled();
});

it("tells a key's sender whether an unconfirmed delivery may have arrived", async () => {
  const { post, store, send } = await setup(); keys(store, [drafts]);
  send.mockRejectedValueOnce(new Error("connection lost"));
  const lost = await post({ text: "Черновик" }, "draft:1:v1", "drafts-secret");
  expect(lost.status).toBe(502);
  expect(await lost.json()).toMatchObject({ error: "Доставка не подтверждена; проверьте Telegram перед новой отправкой.", sent: false, status: "unknown", chatId: "42" });
  // The same identity is never resent, and still says it may have arrived.
  expect(await (await post({ text: "Черновик" }, "draft:1:v1", "drafts-secret")).json()).toMatchObject({ sent: false, status: "unknown" });
  send.mockImplementationOnce(async () => Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }));
  const refused = await post({ text: "Черновик 2" }, "draft:2:v1", "drafts-secret");
  expect(refused.status).toBe(502);
  expect(await refused.json()).toMatchObject({ sent: false, status: "not_sent", chatId: "42" });
  expect(send).toHaveBeenCalledTimes(2);
  expect(journal(store)).toMatchObject([{ status: "unknown", attempts: 2 }, { status: "not_sent", attempts: 1 }]);
});

it("keeps each key's identities apart, repeats without resending and refuses changed text", async () => {
  const { post, store, send } = await setup();
  keys(store, [{ ...reports, chatIds: ["-100"] }, { id: "school-reminders", tokenHash: digest("reminders-secret"), chatIds: ["-100"] }]);
  expect((await post({ text: "Отчёт" }, "same-key", "reports-secret")).status).toBe(200);
  expect((await post({ text: "Отчёт" }, "same-key", "reports-secret")).status).toBe(200);
  expect((await post({ text: "Другой текст" }, "same-key", "reports-secret")).status).toBe(409);
  expect((await post({ text: "Напоминание" }, "same-key", "reminders-secret")).status).toBe(200);
  expect(sentTo(send)).toEqual(["-100", "-100"]);
});

it("limits a key's new deliveries per hour but still answers its repeats", async () => {
  const { post, store, send } = await setup(); keys(store, [{ ...drafts, maxPerHour: 2 }]);
  for (const key of ["d:1", "d:2"]) expect((await post({ text: key }, key, "drafts-secret")).status).toBe(200);
  const limited = await post({ text: "d:3" }, "d:3", "drafts-secret"); expect(limited.status).toBe(429);
  expect((await post({ text: "d:1" }, "d:1", "drafts-secret")).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(2);
  // Another key and the original credential have their own allowance.
  expect((await post({ text: "Встреча" })).status).toBe(200);
});

it("ignores malformed or ambiguous keys and leaves the original credential working", async () => {
  const { post, store, send } = await setup();
  for (const list of [[{ ...drafts, id: "Drafts" }], [{ ...drafts, id: "legacy" }], [{ ...drafts, chatIds: ["042"] }], [{ ...drafts, tokenHash: "x" }], [{ ...drafts, chatIds: [] }], [{ ...drafts, chatIds: ["42", "42"] }],
    [{ ...drafts, maxPerHour: 0 }], [drafts, { ...reports, tokenHash: drafts.tokenHash }], [drafts, { ...reports, id: drafts.id }],
    [{ ...drafts, tokenHash: digest("notification-secret") }], [drafts, null], Array.from({ length: 21 }, (_, i) => ({ ...drafts, id: "k" + i, tokenHash: digest("t" + i) }))]) {
    keys(store, list);
    expect((await post({ text: "Нет" }, "k:1", "drafts-secret")).status, JSON.stringify(list).slice(0, 80)).toBe(401);
  }
  store.setSetting("telegram.notification_hook", JSON.stringify({ tokenHash: digest("notification-secret"), chatId: "42", keys: "drafts" }));
  expect((await post({ text: "Нет" }, "k:1", "drafts-secret")).status).toBe(401);
  expect(send).not.toHaveBeenCalled();
  expect((await post({ text: "Встреча" })).status).toBe(200);
  // Keys alone, without the original credential, also work.
  store.setSetting("telegram.notification_hook", JSON.stringify({ keys: [drafts] }));
  expect((await post({ text: "Черновик" }, "k:2", "drafts-secret")).status).toBe(200);
  expect((await post({ text: "Встреча" }, "k:3")).status).toBe(401);
});

it("moves a narrow key to the supergroup when Telegram upgrades its group", async () => {
  const { post, store, send } = await setup(); keys(store, [drafts, { ...reports, chatIds: ["-100", "-200"] }]);
  store.migrateTelegramGroup("-100", "-100200");
  expect(JSON.parse(store.getSetting("telegram.notification_hook")!).keys).toEqual([drafts, { ...reports, chatIds: ["-100200", "-200"] }]);
  expect((await post({ text: "Отчёт", chatId: "-100200" }, "report:1:v1", "reports-secret")).status).toBe(200);
  expect(sentTo(send)).toEqual(["-100200"]);
});

it("accepts a narrow key through the remote HTTPS listener", async () => {
  const { api, store, send } = await setup(); keys(store, [drafts]);
  const endpoint = await api.mobile.endpoint(); const url = new URL(endpoint.url); url.hostname = "127.0.0.1";
  const response = await homeRequest({ ...endpoint, url: url.toString() }, "/hooks/telegram", "drafts-secret", { method: "POST", body: requestJSON({ text: "Черновик" }) }, 5000, { "idempotency-key": "remote:draft:1" });
  expect(response.status).toBe(200); expect(resultJSON(response).sent).toBe(true); expect(sentTo(send)).toEqual(["42"]);
});
