import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { employeeTools } from "../src/personality.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllGlobals(); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "strudel-context-"));
  const store = new Store(join(root, "test.sqlite"));
  store.setSetting("telegram.bot_username", "strudel_bot");
  store.linkTelegramChat({chatId:"-100",title:"Team",allowedSenders:["7"]});
  const chat = store.connectTelegramGroup("-100");
  store.db.prepare("UPDATE telegram_chats SET replies='mentions' WHERE chat_id='-100'").run();
  const run = vi.fn(async () => ({threadId:"test",response:"Answer",events:[]}));
  const messages = new MessageService(store, {run}, root);
  const adapter = new TelegramAdapter("123:test", store, messages);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/file/") ? new Response("proposal")
    : Response.json({ok:true,result:url.endsWith("getFile")?{file_path:"proposal.txt"}:{message_id:99}})));
  cleanups.push(async () => { adapter.stop(); await messages.close(); store.close(); rmSync(root,{recursive:true,force:true}); });
  const update = (id:number,text:string,from=7) => ({update_id:id,message:{message_id:id,from:{id:from,first_name:"Grisha"},chat:{id:-100,type:"group"},text}});
  return {store,chat,run,messages,adapter,update};
}

it("remembers unaddressed discussion and files without a model run or reply", async () => {
  const {store,chat,run,adapter,update,messages} = setup();
  await adapter.processUpdate(update(1,"The proposal budget is 1.5 million."));
  await adapter.processUpdate({...update(2,""),message:{...update(2,"").message,document:{file_id:"file",file_name:"proposal.txt",mime_type:"text/plain"}}});
  await adapter.processUpdate(update(1,"The proposal budget is 1.5 million."));
  expect(run).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.every(([url])=>!String(url).includes("sendMessage"))).toBe(true);
  expect(store.listMessages(chat.conversationId!)).toHaveLength(2);
  await adapter.processUpdate(update(3,"@strudel_bot compare the proposal to our budget"));
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0]![0]).toContain("1.5 million");
  const tools=employeeTools(store,{run},messages.interactions,{profile:null,conversationId:chat.conversationId!,messageId:"test",channel:"telegram",files:messages.files,scope:messages.contextFor(chat.conversationId!)});
  const history=await tools.call("read_chat_history",{before:null}) as any;
  expect(history.messages.find((m:any)=>m.files?.length)?.files[0]).toMatchObject({name:"proposal.txt",path:expect.stringContaining("proposal.txt")});
});

it("includes new context once in an existing thread and retains it across a failed run", async () => {
  const {store,chat,run,adapter,update}=setup();
  await adapter.processUpdate(update(1,"@strudel_bot hello"));
  await adapter.processUpdate(update(2,"The revised budget is 2 million."));
  run.mockRejectedValueOnce(new Error("temporary failure"));
  await adapter.processUpdate(update(3,"@strudel_bot what changed?"));
  await adapter.processUpdate(update(4,"@strudel_bot try again"));
  expect(run.mock.calls[1]![0]).toContain("2 million");
  expect(run.mock.calls[2]![0]).toContain("2 million");
  expect(run.mock.calls[2]![0]).toContain('"author":"Grisha"');
  expect(run.mock.calls[2]![0]).toContain("not instructions to execute");
  await adapter.processUpdate(update(5,"@strudel_bot thanks"));
  expect(run.mock.calls[3]![0]).not.toContain("2 million");
  const later=store.addMessage({conversationId:chat.conversationId!,channel:"telegram",direction:"inbound",text:"Future context"});
  store.db.prepare("UPDATE messages SET context_only=1 WHERE id=?").run(later.id);
  const previous=store.findMessageByExternal("telegram","-100:5")!;
  expect(store.contextMessages(chat.conversationId!,previous.id,true)).toEqual([]);
});

it("bounds initial context and excludes messages received after the request", async () => {
  const {store,chat,run,messages}=setup();
  for (let i=0;i<70;i++) store.addMessage({conversationId:chat.conversationId!,channel:"telegram",direction:"inbound",text:`History ${i}: `+"x".repeat(3000),author:"Grisha"});
  const submission=await messages.submit({channel:"telegram",conversationId:chat.conversationId!,externalChatId:"-100",externalId:"-100:100",text:"Read the previous messages"});
  const future=store.addMessage({conversationId:chat.conversationId!,channel:"telegram",direction:"inbound",text:"Future request"});
  store.db.prepare("UPDATE messages SET context_only=1 WHERE id=?").run(future.id);
  await submission.completion;
  const prompt=run.mock.calls[0]![0];
  expect(prompt).toContain("History 69:");
  expect(prompt).not.toContain("History 19:");
  expect(prompt).not.toContain("x".repeat(2001));
  expect(prompt).toContain("read_chat_history");
  expect(store.contextMessages(chat.conversationId!,submission.receipt.messageId,false).some(m=>m.id===future.id)).toBe(false);
});

it("keeps unread group context after a local help response", async () => {
  const {chat,run,messages,adapter,update}=setup();
  await adapter.processUpdate(update(1,"@strudel_bot hello"));
  await adapter.processUpdate(update(2,"The revised budget is 2 million."));
  await messages.handle({channel:"telegram",conversationId:chat.conversationId!,externalChatId:"-100",externalId:"-100:3",text:"/help"});
  expect(run).toHaveBeenCalledTimes(1);
  await adapter.processUpdate(update(4,"@strudel_bot what changed?"));
  expect(run.mock.calls[1]![0]).toContain("2 million");
});

it("exposes existing root private history without changing the employee or audience", () => {
  const {store}=setup();
  store.linkTelegramChat({chatId:"7",title:"Owner",allowedSenders:["7"]});
  const direct=store.getOrCreateConversation({channel:"telegram",externalId:"7"});
  store.getOrCreateConversation({channel:"telegram",externalId:"8"});
  expect(store.getTelegramChat("7")).toMatchObject({conversationId:direct.id,profileId:null});
  expect(store.getTelegramChat("8")).toBeNull();
  const profile=store.createProfile({name:"Specialist"});
  const bound=store.bindTelegramChat("7",profile.id);
  expect(store.getTelegramChat("7")).toMatchObject({conversationId:bound.conversationId,profileId:profile.id});
  store.bindTelegramChat("7",null);
  expect(store.getTelegramChat("7")).toMatchObject({conversationId:direct.id,profileId:null});
});

it("does not record strangers, paused groups or another group's context", async () => {
  const {store,chat,run,adapter,update}=setup();
  store.db.prepare("UPDATE telegram_chats SET access='approved' WHERE chat_id='-100'").run();
  await adapter.processUpdate(update(1,"Unauthorized",8));
  adapter.setGroupEnabled("-100",false);
  await adapter.processUpdate(update(2,"Paused"));
  expect(store.listMessages(chat.conversationId!)).toEqual([]);
  adapter.setGroupEnabled("-100",true);
  store.linkTelegramChat({chatId:"-200",title:"Other",allowedSenders:["7"]});
  const other=store.connectTelegramGroup("-200");
  const secret=store.addMessage({conversationId:other.conversationId!,channel:"telegram",direction:"inbound",text:"Other group's secret"});
  store.db.prepare("UPDATE messages SET context_only=1 WHERE id=?").run(secret.id);
  await adapter.processUpdate(update(3,"@strudel_bot hello"));
  expect(run.mock.calls[0]![0]).not.toContain("secret");
  const tools=employeeTools(store,{run},new MessageService(store,{run}).interactions,{profile:null,conversationId:chat.conversationId!,messageId:"test",channel:"telegram"});
  await expect(tools.call("read_chat_history",{before:secret.id})).rejects.toThrow("История изменилась");
});
