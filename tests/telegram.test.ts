import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { TelegramAdapter } from "../src/telegram.js";
import type { MessageService } from "../src/messages.js";

const stores: Store[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const store of stores.splice(0)) store.close(); });

describe("Telegram ownership and delivery", () => {
  it("ignores strangers and binds an explicitly paired chat to Home", async () => {
    const store = new Store(":memory:"); stores.push(store);
    const handle = vi.fn(async () => ({ conversationId: "home", messageId: "reply", text: "done" }));
    const adapter = new TelegramAdapter("123:test", store, { handle, assertDelivery: vi.fn() } as unknown as MessageService);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url); return Response.json({ ok: true, result: {} }); }));
    await adapter.processUpdate({ update_id: 1, message: { message_id: 1, text: "read my files", chat: { id: 42, type: "private" } } });
    expect(handle).not.toHaveBeenCalled();
    const pairing = adapter.createLink();
    await adapter.processUpdate({ update_id: 2, message: { message_id: 2, text: "/start " + pairing.code, chat: { id: 42, type: "private" } } });
    await adapter.processUpdate({ update_id: 3, message: { message_id: 3, text: "hello", chat: { id: 42, type: "private" } } });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ text: "hello", conversationId: store.getOrCreateConversation({ channel: "telegram", externalId: "42" }).id }));
    expect(adapter.status().linkedChats).toEqual(["42"]);
    expect(calls.filter(url => !url.endsWith("/sendChatAction"))).toHaveLength(3);
    adapter.stop();
  });

  it("splits long replies within Telegram limits", async () => {
    const store = new Store(":memory:"); stores.push(store);
    const chunks: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => { chunks.push(JSON.parse(String(init.body)).text); return Response.json({ ok: true, result: {} }); }));
    const adapter = new TelegramAdapter("123:test", store, {} as MessageService);
    await adapter.sendMessage(42, "🙂".repeat(5000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 4096)).toBe(true);
    expect(chunks.join("")).toBe("🙂".repeat(5000));
  });
});

it("accepts a callback while the original Telegram turn is waiting", async () => {
  const { MessageService } = await import("../src/messages.js");
  const store = new Store(":memory:"); stores.push(store);
  store.setSetting("telegram.linked_chats", JSON.stringify(["42"]));
  const messages = new MessageService(store, { async run(_input, options) {
    const answer = await options!.onRequest!("item/commandExecution/requestApproval", { command: "a test action" }) as { decision: string };
    return { threadId: "telegram-thread", response: answer.decision, events: [] };
  } });
  const sent: Array<{ method: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ method: url.split("/").at(-1)!, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true, result: { message_id: 88 } });
  }));
  const adapter = new TelegramAdapter("123:test", store, messages);
  const turn = adapter.processUpdate({ update_id: 10, message: { message_id: 9, text: "test", chat: { id: 42 } } });
  await vi.waitFor(() => expect(sent.some(s => s.body.reply_markup)).toBe(true));
  const card = sent.find(s => s.body.reply_markup)!.body;
  const no = card.reply_markup.inline_keyboard[1][0].callback_data;
  await adapter.processUpdate({ update_id: 11, callback_query: { id: "wrong", data: no, message: { message_id: 88, chat: { id: 43 } } } });
  expect(messages.interactions.list(store.getOrCreateConversation({ channel: "telegram", externalId: "42" }).id)).toHaveLength(1);
  await adapter.processUpdate({ update_id: 12, callback_query: { id: "right", data: no, message: { message_id: 88, chat: { id: 42 } } } });
  await turn;
  expect(sent.some(s => s.method === "sendMessage" && s.body.text === "decline")).toBe(true);
  await messages.close();
});

it('clears completed approval controls durably after restart, retries network failures and leaves live requests alone',async()=>{
 const {MessageService}=await import('../src/messages.js');
 const store=new Store(':memory:');stores.push(store);
 const messages=new MessageService(store,{run:vi.fn()});
 const adapter=new TelegramAdapter('123:test',store,messages);
 store.db.prepare('INSERT INTO telegram_interactions VALUES(?,?,?,?)').run('123','42',88,'from-before-restart');
 store.db.prepare('INSERT INTO telegram_interactions VALUES(?,?,?,?)').run('999','42',89,'other-bot');
 const pending=messages.interactions.ask({conversationId:'c',messageId:'m',title:'Confirm',questions:[{id:'a',question:'Allow?',options:['No']}]}).catch(()=>{});
 const card=messages.interactions.list('c')[0];
 store.db.prepare('INSERT INTO telegram_interactions VALUES(?,?,?,?)').run('123','42',90,card.id);
 const fetcher=vi.fn(async()=>Response.json({ok:true,result:true})).mockRejectedValueOnce(new Error('offline'));vi.stubGlobal('fetch',fetcher);
 await adapter.cleanupInteractions();
 expect(store.db.prepare('SELECT COUNT(*) AS n FROM telegram_interactions').get()?.n).toBe(3);
 await adapter.cleanupInteractions();
 expect(store.db.prepare('SELECT message_id FROM telegram_interactions ORDER BY message_id').all().map(x=>x.message_id)).toEqual([89,90]);
 expect(fetcher).toHaveBeenCalledTimes(2);
 expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({chat_id:'42',message_id:88,reply_markup:{inline_keyboard:[]}});
 await messages.interactions.answer(card.id,'c',{a:'No'});await pending;await adapter.cleanupInteractions();
 expect(store.db.prepare('SELECT message_id FROM telegram_interactions').all().map(x=>x.message_id)).toEqual([89]);
 await messages.close();
});
