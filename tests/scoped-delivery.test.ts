import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { saveTelegramAuthorization, telegramAuthorization } from "../src/authorization.js";

const resources: Array<{ store: Store; messages: MessageService; adapter: TelegramAdapter }> = [];
afterEach(async () => {
  for (const { store, messages, adapter } of resources.splice(0)) {
    adapter.stop(); await messages.close(); store.close();
  }
  vi.unstubAllGlobals();
});

it.each(["123", "-100"])("stops remaining Telegram chunks when %s access is revoked after the first send", async chatId => {
  const { store, messages, adapter, response, run } = fixture(chatId);
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/sendMessage")) {
      const body = JSON.parse(String(init.body)); sent.push(body.text);
      expect(String(body.chat_id)).toBe(chatId);
      // Generation already finished; changing policy can happen while Telegram
      // acknowledges a preceding chunk. No later chunk may use the old grant.
      expect(messages.hasActiveRuns).toBe(false);
      const next = telegramAuthorization(store);
      if (chatId.startsWith("-")) next.chats[chatId]!.enabled = false;
      else next.subjects[chatId]!.enabled = false;
      saveTelegramAuthorization(store, next);
    }
    return Response.json({ ok: true, result: { message_id: 50 } });
  }));
  await adapter.processUpdate(update(chatId));
  expect(run).toHaveBeenCalledOnce();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.length).toBeLessThan(response.length);
  expect(store.db.prepare("SELECT count(*) n FROM telegram_outbox WHERE status='delivered'").get()?.n).toBe(1);
  await adapter.processUpdate(update(chatId));
  expect(sent).toHaveLength(1);
});

it.each(["123", "-100"])("keeps ordinary multi-chunk delivery working for current %s grants", async chatId => {
  const { adapter, response } = fixture(chatId);
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/sendMessage")) sent.push(JSON.parse(String(init.body)).text);
    return Response.json({ ok: true, result: { message_id: 50 } });
  }));
  await adapter.processUpdate(update(chatId));
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.join("")).toBe(response);
});

function fixture(chatId: string) {
  const store = new Store(":memory:");
  store.setSetting("telegram.bot_username", "synthetic_bot");
  store.linkTelegramChat({ chatId: "123", title: "Synthetic mentor", allowedSenders: [] });
  store.linkTelegramChat({ chatId: "-100", title: "Synthetic family", allowedSenders: ["123"] });
  store.connectTelegramGroup("-100");
  saveTelegramAuthorization(store, { version: 1, revision: 0,
    connectors: { school: { url: "https://school.invalid/api/mcp/company", headers: {} } },
    policies: { school: { connectorId: "school", tools: [] } },
    subjects: { "123": { enabled: true, capabilities: [], privatePolicyId: "school" } },
    chats: { "-100": { enabled: true, policyId: "school", defaultCapabilities: [], members: {} } } });
  const response = "x".repeat(10000);
  const run = vi.fn(async () => ({ response }));
  const messages = new MessageService(store, { run: vi.fn() });
  messages.restrictedExecutor = { run, close: vi.fn() };
  const adapter = new TelegramAdapter("123:synthetic-token", store, messages);
  resources.push({ store, messages, adapter });
  return { store, messages, adapter, response, run, chatId };
}

function update(chatId: string) {
  return { update_id: 1, message: { message_id: 1, chat: { id: Number(chatId), type: chatId.startsWith("-") ? "group" : "private" }, from: { id: 123 }, text: "@synthetic_bot Покажи расписание" } };
}
