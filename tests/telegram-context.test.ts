import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { employeeTools } from "../src/personality.js";
import { saveConversationModelSelection } from "../src/model-settings.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllGlobals(); });
function setup(replies: "mentions" | "instructions" = "mentions") {
  const root = mkdtempSync(join(tmpdir(), "strudel-context-"));
  const store = new Store(join(root, "test.sqlite"));
  store.setSetting("telegram.bot_username", "strudel_bot");
  store.linkTelegramChat({chatId:"-100",title:"Team",allowedSenders:["7"]});
  const chat = store.connectTelegramGroup("-100");
  if (replies === "mentions") store.db.prepare("UPDATE telegram_chats SET replies='mentions' WHERE chat_id='-100'").run();
  const run = vi.fn(async () => ({threadId:"test",response:"Answer",events:[]}));
  const messages = new MessageService(store, {run}, root);
  const adapter = new TelegramAdapter("123:test", store, messages);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/file/") ? new Response("proposal")
    : Response.json({ok:true,result:url.endsWith("getFile")?{file_path:"proposal.txt"}:{message_id:99}})));
  cleanups.push(async () => { adapter.stop(); await messages.close(); store.close(); rmSync(root,{recursive:true,force:true}); });
  const update = (id:number,text:string,from=7) => ({update_id:id,message:{message_id:id,from:{id:from,first_name:"Grisha"},chat:{id:-100,type:"group"},text}});
  return {store,chat,run,messages,adapter,update};
}

it("lets new groups answer unmentioned text and native voice while retaining contextual silence", async () => {
  const { store, chat, run, adapter, update } = setup("instructions");
  expect(store.getTelegramChat("-100")?.replies).toBe("instructions");
  adapter.transcribe = vi.fn(async () => 'Можешь ответить "Привет"?');
  run.mockResolvedValueOnce({ threadId: "test", response: "51", events: [] });
  run.mockResolvedValueOnce({ threadId: "test", response: "Привет", events: [] });
  run.mockResolvedValueOnce({ threadId: "test", response: "NO_REPLY", events: [] });
  await adapter.processUpdate(update(1, "Посчитай 17 × 3."));
  const voice = { ...update(2, ""), message: { ...update(2, "").message, voice: { file_id: "voice", file_size: 9501 } } };
  await adapter.processUpdate(voice);
  await adapter.processUpdate(voice); // Telegram redelivery must not answer twice.
  await adapter.processUpdate(update(3, "Гриша, встретимся у входа."));
  expect(adapter.transcribe).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(3);
  expect(run.mock.calls[1]![0]).toContain('Можешь ответить "Привет"?');
  expect(run.mock.calls[2]![1].profile).toContain("do not reply or take actions merely because you can read it");
  expect(store.db.prepare("SELECT context_only FROM messages WHERE external_id='-100:2'").get()?.context_only).toBe(0);
  const sent = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/sendMessage"))
    .map(([, init]) => JSON.parse(String(init!.body)).text);
  expect(sent).toEqual(["51", '📝 Можешь ответить "Привет"?', "Привет"]);
  expect(store.listMessages(chat.conversationId!).some(message => message.text === "NO_REPLY")).toBe(false);
});

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

it("gives an existing thread what a notification key delivered meanwhile, once", async () => {
  const {store,chat,run,adapter,update}=setup();
  await adapter.processUpdate(update(1,"@strudel_bot hello"));
  // A server delivery between turns, as notification-hook records it.
  store.addMessage({conversationId:chat.conversationId!,channel:"telegram",direction:"outbound",externalId:"notification:abc123",
    author:"Wolf from Baumanskaya",text:"Sasha · Lesson 4 · draft. No video yet."});
  await adapter.processUpdate(update(2,"@strudel_bot why is there no video?"));
  expect(run.mock.calls[1]![0]).toContain("Sasha · Lesson 4 · draft");
  await adapter.processUpdate(update(3,"@strudel_bot thanks"));
  expect(run.mock.calls[2]![0]).not.toContain("Sasha · Lesson 4 · draft");
  // The model's own replies are in its thread already and never come back as context.
  store.addMessage({conversationId:chat.conversationId!,channel:"telegram",direction:"outbound",text:"Own earlier answer"});
  await adapter.processUpdate(update(4,"@strudel_bot and now?"));
  expect(run.mock.calls[3]![0]).not.toContain("Own earlier answer");
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

it("tells the model which message a group reply targets, also one Home never stored", async () => {
  const { run, adapter, update } = setup("instructions");
  const reply = (id: number, target: Record<string, unknown>, quote?: string) => { const u = update(id, "Мне вот этот нравится");
    return { ...u, message: { ...u.message, reply_to_message: target, ...(quote ? { quote: { text: quote } } : {}) } }; };
  // An album the bot posted straight through the Bot API, outside Home's history.
  await adapter.processUpdate(reply(2392, { message_id: 2366, from: { id: 123, is_bot: true, username: "strudel_bot" }, caption: "01 · Loft Factory: Новорязанская, 26с1", photo: [{ file_id: "p" }] }));
  await adapter.processUpdate(reply(2393, { message_id: 50, from: { id: 9, first_name: "Darya" }, photo: [{ file_id: "p" }] }));
  await adapter.processUpdate(reply(2394, { message_id: 51, from: { id: 9, first_name: "Darya" }, document: { file_id: "d", file_name: "bbf.pdf" } }));
  await adapter.processUpdate(reply(2395, { message_id: 52, from: { id: 9, first_name: "Darya" }, text: "Варианты: 4 ноября или 17 ноября" }, "17 ноября"));
  const prompts = run.mock.calls.map(call => String(call[0]));
  expect(prompts[0]).toContain('"replyToAssistant":true,"replyTo":{"messageId":2366,"author":"assistant","text":"01 · Loft Factory: Новорязанская, 26с1"}');
  expect(prompts[1]).toContain('"replyTo":{"messageId":50,"author":"Darya","text":"[photo]"}');
  expect(prompts[2]).toContain('"replyTo":{"messageId":51,"author":"Darya","text":"[bbf.pdf]"}');
  expect(prompts[3]).toContain('"replyTo":{"messageId":52,"author":"Darya","text":"17 ноября"}');
  expect(run.mock.calls[0]![1].profile).toContain("replyTo is the exact message being answered");
});

it("threads a group answer to the message it answers and leaves private answers unthreaded", async () => {
  const { store, adapter, update } = setup("instructions");
  store.linkTelegramChat({ chatId: "7", title: "Owner", allowedSenders: ["7"] });
  await adapter.processUpdate(update(41, "@strudel_bot билеты есть?"));
  await adapter.processUpdate({ update_id: 42, message: { message_id: 42, from: { id: 7, first_name: "Mik" }, chat: { id: 7, type: "private" }, text: "Привет" } });
  const sent = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/sendMessage")).map(([, init]) => JSON.parse(String(init!.body)));
  expect(sent[0]).toMatchObject({ chat_id: -100, reply_parameters: { message_id: 41, allow_sending_without_reply: true } });
  expect(sent[1]!.chat_id).toBe(7);
  expect(sent[1]).not.toHaveProperty("reply_parameters");
});

/** Holds the first model turn open so later updates wait in the queue. */
function hold(run: ReturnType<typeof setup>["run"]) {
  let release!: () => void;
  run.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ threadId: "test", response: "NO_REPLY", events: [] }); }));
  return () => release();
}
const queued = (store: Store) => Number(store.db.prepare("SELECT count(*) n FROM messages WHERE status='queued'").get()!.n);

it("shows a queued group turn the newer messages that already arrived", async () => {
  const { store, run, adapter, update } = setup("instructions");
  const release = hold(run);
  const first = adapter.processUpdate(update(1, "@dzhuykova когда у нас Китай? 20?"));
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const rest = [adapter.processUpdate(update(2, "22/11", 9)), adapter.processUpdate(update(3, "18.11 ещё TechWeek"))];
  await vi.waitFor(() => expect(queued(store)).toBe(2));
  release(); await Promise.all([first, ...rest]);
  const [, second, third] = run.mock.calls.map(call => String(call[0]));
  expect(second).toContain("Newer messages in this chat");
  expect(second).toContain('{"author":"Grisha","text":"18.11 ещё TechWeek"}');
  expect(second).toContain("NO_REPLY");
  expect(third).not.toContain("Newer messages in this chat");
});

it("applies an edit to a request still waiting its turn, and never to an answered one", async () => {
  const { store, run, adapter, update } = setup("instructions");
  const release = hold(run);
  const first = adapter.processUpdate(update(1, "@strudel_bot билеты есть соответствующие?"));
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  const second = adapter.processUpdate(update(2, "в расписании"));
  await vi.waitFor(() => expect(queued(store)).toBe(1));
  await adapter.processUpdate({ update_id: 9, edited_message: update(2, "в продаже").message });
  release(); await Promise.all([first, second]);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]![0]).toContain("в продаже");
  expect(run.mock.calls[1]![0]).not.toContain("в расписании");
  await adapter.processUpdate({ update_id: 10, edited_message: update(1, "изменено потом").message });
  expect(store.findMessageByExternal("telegram", "-100:1")!.text).toBe("@strudel_bot билеты есть соответствующие?");
  expect(run).toHaveBeenCalledTimes(2);
  // Telegram sends edits only to a bot that asks for them.
  void adapter.start();
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/getUpdates"))).toBe(true));
  adapter.stop();
  const poll = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/getUpdates"))!;
  expect(JSON.parse(String(poll[1]!.body)).allowed_updates).toContain("edited_message");
});

it("gives a captionless group file as context, and keeps a private one a request", async () => {
  const { store, run, adapter, update } = setup("instructions");
  const file = (id: number, chat: { id: number; type: string }) => ({ update_id: id, message: { message_id: id, from: { id: 7, first_name: "Grisha" }, chat, document: { file_id: "file", file_name: "proposal.txt", mime_type: "text/plain" } } });
  await adapter.processUpdate(file(1, { id: -100, type: "group" }));
  const group = String(run.mock.calls[0]![0]);
  expect(group).toContain('"attachmentOnly":true');
  expect(group).toContain("proposal.txt");
  expect(group).not.toContain("Посмотри вложение");
  await adapter.processUpdate(update(2, "@strudel_bot что в файле?"));
  expect(String(run.mock.calls[1]![0])).not.toContain("attachmentOnly");
  store.linkTelegramChat({ chatId: "7", title: "Owner", allowedSenders: ["7"] });
  await adapter.processUpdate(file(3, { id: 7, type: "private" }));
  expect(String(run.mock.calls[2]![0])).toContain("Посмотри вложение.");
});

it("runs the owner's pipeline operations in a group like its schedules; everything else there stays live", async () => {
  const { chat, run, messages, adapter, update } = setup("instructions");
  const api = (externalId: string, byOwner?: boolean) => messages.handle({ channel: "api", conversationId: chat.conversationId!, text: "Срочная пачка новостей", externalId, byOwner });
  await api("operations:5b0c1d2e", true);
  await api("operations:forged");
  await api("app-message", true);
  await adapter.processUpdate(update(1, "operations: сделай"));
  expect(run.mock.calls.map(call => [call[1].groupContext, call[1].scheduled])).toEqual([[true, true], [true, false], [true, false], [true, false]]);
});

it("runs direct chats at Fast unless the owner turns it off; groups, schedules and a chosen chat model keep their speed", async () => {
  const { store, chat, run, messages, adapter, update } = setup("instructions");
  store.linkTelegramChat({ chatId: "7", title: "Owner", allowedSenders: ["7"] });
  const direct = (id: number) => ({ update_id: id, message: { message_id: id, from: { id: 7, first_name: "Grisha" }, chat: { id: 7, type: "private" }, text: "Привет" } });
  const app = store.primaryConversation().id;
  await adapter.processUpdate(direct(1));
  await messages.handle({ channel: "api", conversationId: app, text: "Привет", byOwner: true });
  await adapter.processUpdate(update(2, "@strudel_bot привет"));
  await messages.handle({ channel: "api", conversationId: app, text: "Утренний обзор", byOwner: true, scheduled: true });
  await messages.handle({ channel: "api", conversationId: chat.conversationId!, text: "Срочная пачка", externalId: "operations:1", byOwner: true });
  saveConversationModelSelection(store, app, { provider: "chatgpt", model: "chosen", serviceTier: "default" });
  await messages.handle({ channel: "api", conversationId: app, text: "Своя модель", byOwner: true });
  saveConversationModelSelection(store, app, { provider: null, model: null, serviceTier: null });
  store.setSetting("models.directFast", "false");
  await adapter.processUpdate(direct(3));
  expect(run.mock.calls.map(call => call[1].fast)).toEqual([true, true, false, false, false, false, false]);
});
