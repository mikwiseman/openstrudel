import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { TelegramAdapter } from "../src/telegram.js";
import type { MessageService } from "../src/messages.js";

const resources: Array<{ adapter: TelegramAdapter; store: Store }> = [];
afterEach(() => {
  for (const { adapter, store } of resources.splice(0)) { adapter.stop(); store.close(); }
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
function setup() {
  const store = new Store(":memory:");
  const adapter = new TelegramAdapter("123:test-secret", store, {} as MessageService);
  resources.push({ adapter, store });
  return { adapter, store };
}
function waiting(init: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}
const bot = { id: 1, is_bot: true, first_name: "Test", username: "test_bot" };

it("automatically removes a transient polling error after the next successful poll", async () => {
  const { adapter } = setup();
  vi.spyOn(console, "error").mockImplementation(() => {});
  let attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    attempts++;
    if (attempts === 1) throw new TypeError("fetch failed");
    if (attempts === 2) return Response.json({ ok: true, result: [] });
    return waiting(init);
  }));
  await adapter.start();
  await vi.waitFor(() => expect(adapter.status().connectionError).toContain("Нет связи с Telegram"));
  await vi.waitFor(() => expect(adapter.status().lastError).toBeNull(), { timeout: 3500 });
  expect(adapter.status().lastCheckedAt).not.toBeNull();
  expect(adapter.status().running).toBe(true);
});

it("probes the real API, coalesces concurrent checks and clears a recovered connection error", async () => {
  const { adapter } = setup();
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValue(Response.json({ ok: true, result: bot }));
  vi.stubGlobal("fetch", fetcher);
  expect((await adapter.checkConnection()).lastError).toContain("Нет связи");
  const [first, second] = await Promise.all([adapter.checkConnection(), adapter.checkConnection()]);
  expect(first).toEqual(second);
  expect(first).toMatchObject({ lastError: null, connectionError: null, botUsername: "test_bot" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([url]) => String(url).endsWith("/getMe"))).toBe(true);
});

it("does not mistake a successful identity probe for recovery of a competing Telegram poller", async () => {
  const { adapter } = setup();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("getMe")
    ? Response.json({ ok: true, result: bot })
    : Response.json({ ok: false, error_code: 409, description: "Conflict" }, { status: 409 })));
  await adapter.start();
  await vi.waitFor(() => expect(adapter.status().connectionError).toContain("другим приложением"));
  expect((await adapter.checkConnection()).lastError).toContain("другим приложением");
});

it("does not retry an uncertain delivery or erase its record when checking connectivity", async () => {
  const { adapter, store } = setup();
  const fetcher = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed"))
    .mockResolvedValue(Response.json({ ok: true, result: bot }));
  vi.stubGlobal("fetch", fetcher);
  await expect(adapter.sendMessage(42, "test", "unique-delivery")).rejects.toThrow();
  await adapter.checkConnection();
  await expect(adapter.sendMessage(42, "test", "unique-delivery")).rejects.toThrow("Доставка требует проверки");
  expect(store.db.prepare("SELECT status FROM telegram_outbox").get()?.status).toBe("unknown");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("shows a revoked bot key without exposing Telegram internals or secrets", async () => {
  const { adapter } = setup();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 })));
  const result = await adapter.checkConnection();
  expect(result.lastError).toContain("Ключ бота больше не действует");
  expect(JSON.stringify(result)).not.toContain("test-secret");
});
