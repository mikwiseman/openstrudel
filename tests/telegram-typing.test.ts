import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { TelegramAdapter } from "../src/telegram.js";
import type { MessageService } from "../src/messages.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps typing alive during work and stops after the last overlapping reply", async () => {
  vi.useFakeTimers();
  const store = new Store(":memory:");
  store.setSetting("telegram.linked_chats", '["42"]');
  const finish: Array<() => void> = [];
  const handle = vi.fn(() => new Promise(resolve => finish.push(() => resolve({messageId:String(finish.length),text:"done"}))));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { calls.push(url.split("/").at(-1)!); return Response.json({ok:true,result:{message_id:123}}); }));
  const adapter = new TelegramAdapter("123:test", store, {handle,assertDelivery:vi.fn()} as unknown as MessageService);
  const message = (n:number) => ({update_id:n,message:{message_id:n,text:"hello",from:{id:42,is_bot:false},chat:{id:42,type:"private"}}});
  try {
    const first=adapter.processUpdate(message(1)), second=adapter.processUpdate(message(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter(c=>c==="sendChatAction")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.filter(c=>c==="sendChatAction")).toHaveLength(2);
    finish[0]!(); await first;
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls.filter(c=>c==="sendChatAction")).toHaveLength(3);
    finish[1]!(); await second;
    await vi.advanceTimersByTimeAsync(12000);
    expect(calls.filter(c=>c==="sendChatAction")).toHaveLength(3);
  } finally { adapter.stop(); store.close(); }
});

it("ignores typing transport failures and never sends typing to an unpaired stranger", async () => {
  const store = new Store(":memory:");
  store.setSetting("telegram.linked_chats", '["42"]');
  const calls:string[]=[];
  const handle=vi.fn(async()=>({messageId:"r",text:"done"}));
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>{const method=url.split("/").at(-1)!;calls.push(method);if(method==="sendChatAction")throw Error("offline");return Response.json({ok:true,result:{message_id:123}});}));
  const adapter=new TelegramAdapter("123:test",store,{handle,assertDelivery:vi.fn()} as unknown as MessageService);
  try {
    await adapter.processUpdate({update_id:1,message:{message_id:1,text:"hello",from:{id:99,is_bot:false},chat:{id:99,type:"private"}}});
    expect(calls).not.toContain("sendChatAction");
    await adapter.processUpdate({update_id:2,message:{message_id:2,text:"hello",from:{id:42,is_bot:false},chat:{id:42,type:"private"}}});
    expect(calls).toContain("sendChatAction");
    expect(calls).toContain("sendMessage");
    expect(handle).toHaveBeenCalledOnce();
  } finally {adapter.stop();store.close();}
});
