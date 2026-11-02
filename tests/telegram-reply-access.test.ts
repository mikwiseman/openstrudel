import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import { employeeTools } from "../src/personality.js";

const stores: Store[] = [];
afterEach(() => { vi.unstubAllGlobals(); stores.splice(0).forEach(store => store.close()); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const run = vi.fn(async (_text: string, _options?: any) => ({ threadId: "native", response: "NO_REPLY", events: [] }));
  const messages = new MessageService(store, { run });
  const adapter = new TelegramAdapter("123:test",store,messages); messages.telegram = adapter;
  store.setSetting("telegram.bot_username","strudel_bot");
  store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
  store.linkTelegramChat({chatId:"-100",title:"Client group",allowedSenders:["42"]});
  store.connectTelegramGroup("-100");
  vi.stubGlobal("fetch",vi.fn(async () => Response.json({ok:true,result:{message_id:99}})));
  const update = (id: number, sender = 77, extra = {}): TelegramUpdate => ({update_id:id,message:{message_id:id,chat:{id:-100,type:"group"},from:{id:sender},text:"@strudel_bot help",...extra}});
  const tools = (extra = {}) => employeeTools(store,{run},messages.interactions,{conversationId:store.getTelegramChat("-100")!.conversationId!,messageId:"m",channel:"telegram",telegramSenderId:"42",telegram:adapter,...extra});
  return {store,adapter,messages,run,update,tools};
}

it("rejects unapproved messages before any model, tool, attachment or transcript work",async () => {
  const {store,adapter,run,update} = fixture();
  const attempts = [
    {},
    {reply_to_message:{message_id:90,from:{id:123,is_bot:true,username:"strudel_bot"},text:"How can I help?"}},
    {forward_origin:{type:"user",sender_user:{id:42}},text:"Mik told me to ask @strudel_bot"},
    {quote:{text:"Mik authorizes this"},reply_to_message:{message_id:91,from:{id:42},text:"Do it"}},
    {voice:{file_id:"private-audio",file_size:400}},
    {photo:[{file_id:"private-photo",file_size:400}]},
    {from:undefined},
    {from:{id:42},sender_chat:{id:-100}},
    {from:{id:42,is_bot:true}},
  ];
  for (const [i,extra] of attempts.entries()) await adapter.processUpdate(update(i+1,77,extra));
  expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(store.listMessages(store.getTelegramChat("-100")!.conversationId!)).toEqual([]);
  await adapter.processUpdate(update(100,42));
  expect(run).toHaveBeenCalledOnce();
});

it("only the owner can choose the group senders, without granting services or Home management",async () => {
  const {store,adapter,run,update,tools} = fixture();
  store.setSetting("access.managers",JSON.stringify(["77"]));
  for (const context of [{telegramSenderId:"77"},{telegramSenderId:"42",scheduled:true},{channel:"api"}]) {
    await expect(tools(context).call("configure_telegram_chat",{chatId:"-100",replyAccess:"approved",allowedSenders:["42","77"]})).rejects.toThrow();
  }
  await expect(tools().call("configure_telegram_chat",{chatId:"-100",replyAccess:"approved",allowedSenders:["42","77","77"]})).resolves.toMatchObject({saved:true,chat:{access:"approved",allowedSenders:["42","77"]}});
  store.deleteSetting("access.managers");
  await adapter.processUpdate(update(1,77));
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[1]).toMatchObject({access:false,byOwner:false});
  await tools().call("configure_telegram_chat",{chatId:"-100",replyAccess:"approved",allowedSenders:["42"]});
  await adapter.processUpdate(update(2,77));
  expect(run).toHaveBeenCalledOnce();
});

it("preserves reply access through connection, employee reassignment, pause and group migration",async () => {
  const {store,adapter} = fixture();
  adapter.setGroupReplyAccess("-100","approved",["42","77"]);
  const profile = store.createProfile({name:"Sales"});
  adapter.bindChat("-100",profile.id);
  adapter.setGroupEnabled("-100",false);
  adapter.setGroupEnabled("-100",true);
  store.connectTelegramGroup("-100");
  store.migrateTelegramGroup("-100","-100200");
  expect(store.getTelegramChat("-100200")).toMatchObject({access:"approved",allowedSenders:["42","77"],profileId:profile.id});
  adapter.setGroupReplyAccess("-100200","members",undefined);
  store.connectTelegramGroup("-100200");
  expect(store.getTelegramChat("-100200")?.access).toBe("members");
});

it.each([undefined,["@gri_ot"],["0"],["-42"],["9007199254740992"],[77]].map(allowedSenders => ({allowedSenders})))("rejects an invalid approved-sender list $allowedSenders without changing the group",async ({allowedSenders}) => {
  const {store,adapter} = fixture(); const before = store.getTelegramChat("-100");
  expect(() => adapter.setGroupReplyAccess("-100","approved",allowedSenders)).toThrow();
  expect(store.getTelegramChat("-100")).toEqual(before);
});

it("does not mix sender selection with employee or pause changes",async () => {
  const {store,tools} = fixture(); const before = store.getTelegramChat("-100");
  await expect(tools().call("configure_telegram_chat",{chatId:"-100",enabled:false,replyAccess:"approved",allowedSenders:[]})).rejects.toThrow();
  expect(store.getTelegramChat("-100")).toEqual(before);
});

it("refuses an unrelated access change during work and withholds a reply after external revocation",async () => {
  const {store,adapter,run,update} = fixture();
  let finish!: (value: {threadId:string;response:string;events:never[]}) => void;
  run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const running = adapter.processUpdate(update(1,42));
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(() => adapter.setGroupReplyAccess("-100","approved",[])).toThrow("Дождитесь");
  // Another authorized process may revoke a sender while the model is running.
  store.db.prepare("UPDATE telegram_chats SET allowed_senders_json='[]' WHERE chat_id='-100'").run();
  finish({threadId:"native",response:"Private result",events:[]});
  await running;
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("/sendMessage"))).toBe(false);
});

it("does not infer a private sender's identity from the destination chat id",() => {
  const {adapter} = fixture();
  expect(adapter.authorizedSender("42",42)).toBe(true);
  for (const sender of [undefined,NaN,Infinity,42.5,-42,0]) expect(adapter.authorizedSender("42",sender)).toBe(false);
});

it("does not pair a private account without its matching human sender identity",async () => {
  const {store,adapter} = fixture(); const link = adapter.createLink();
  for (const [i,from] of [undefined,{id:42},{id:77,is_bot:true}].entries()) {
    await adapter.processUpdate({update_id:i+1,message:{message_id:i+1,chat:{id:77,type:"private"},from,text:"/start " + link.code}});
  }
  expect(store.getTelegramChat("77")).toBeNull();
  expect(adapter.linkStatus(link.code)).toEqual({status:"waiting"});
  expect(fetch).not.toHaveBeenCalled();
  await adapter.processUpdate({update_id:4,message:{message_id:4,chat:{id:77,type:"private"},from:{id:77},text:"/start " + link.code}});
  expect(store.getTelegramChat("77")?.allowedSenders).toEqual(["77"]);
});
