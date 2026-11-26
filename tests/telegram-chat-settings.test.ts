import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";

const stores: Store[]=[];
afterEach(()=>{vi.unstubAllGlobals(); for (const store of stores.splice(0)) store.close();});

function fixture() {
  const store=new Store(":memory:"); stores.push(store);
  const run=vi.fn(async()=>({threadId:"qa",response:"NO_REPLY",events:[]}));
  const messages=new MessageService(store,{run}), adapter=new TelegramAdapter("42:test",store,messages);
  messages.telegram=adapter;
  store.setSetting("telegram.bot_username","wolfbot");
  store.setSetting("telegram.groupReplyPeople",JSON.stringify(["42","43"]));
  for (const id of ["42","43","99"]) store.linkTelegramChat({chatId:id,title:"Private",allowedSenders:[id]});
  for (const id of ["-100","-200"]) {
    store.linkTelegramChat({chatId:id,title:"Group",allowedSenders:["42","43","99"]});
    store.connectTelegramGroup(id);
  }
  const sent:any[]=[], edits:any[]=[], answers:any[]=[];
  let next=500,update=0;
  vi.stubGlobal("fetch",vi.fn(async(url,init)=>{
    const method=String(url).split("/").at(-1),body=JSON.parse(init.body);
    if(method==="sendMessage"){sent.push({...body,message_id:++next});return Response.json({ok:true,result:{message_id:next}});}
    if(method==="editMessageText") edits.push(body);
    if(method==="answerCallbackQuery") answers.push(body);
    return Response.json({ok:true,result:true});
  }));
  const words=(chat:number,sender:number,text:string,extra:Record<string,unknown>={})=>
    adapter.processUpdate({update_id:++update,message:{message_id:update,chat:{id:chat,type:chat<0?"supergroup":"private"},from:{id:sender},text,...extra}});
  const tap=async(chat:number,sender:number,panel:number,data:string,extra:Record<string,unknown>={})=>{
    const event={update_id:++update,callback_query:{id:String(update),from:{id:sender},data,message:{message_id:panel,chat:{id:chat,type:chat<0?"supergroup":"private"}},...extra}} as TelegramUpdate;
    await adapter.processUpdate(event); return event;
  };
  return {store,adapter,run,sent,edits,answers,words,tap};
}

it("saves group replies in place and accepts presses only on the real panel from authorized people",async()=>{
  const {store,adapter,run,sent,edits,answers,words,tap}=fixture();
  await words(-100,42,"/settings@wolfbot\n\nSent by an AI assistant.");
  expect(sent).toHaveLength(1);
  const panel=sent[0], buttons=panel.reply_markup.inline_keyboard.flat();
  expect(panel.text).toContain("Replies in this group");
  const mentions=buttons.find((b:any)=>b.text.includes("Mentions"));
  const automatic=buttons.find((b:any)=>b.text.includes("Automatic"));
  expect(mentions).toBeDefined(); expect(automatic).toBeDefined();
  await tap(-200,43,panel.message_id,mentions.callback_data);
  await tap(-100,43,panel.message_id+3,mentions.callback_data);
  await tap(-100,99,panel.message_id,mentions.callback_data);
  await tap(-100,43,panel.message_id,mentions.callback_data,{from:{id:43,is_bot:true}});
  expect(edits).toHaveLength(0); expect(answers.filter(x=>x.show_alert)).toHaveLength(4);
  const previous=await tap(-100,43,panel.message_id,mentions.callback_data);
  expect(edits.at(-1).message_id).toBe(panel.message_id);
  expect(edits.at(-1).text).toContain("Mention Wolf");
  expect(edits.at(-1).reply_markup.inline_keyboard.flat().find((b:any)=>b.text.includes("Mentions")).text).toContain("✓");
  await words(-200,43,"/settings"); expect(sent.at(-1).text).not.toContain("Mention Wolf");
  store.setSetting("telegram.groupReplyPeople",JSON.stringify(["42"]));
  const edited=edits.length;await tap(-100,43,panel.message_id,automatic.callback_data);
  expect(edits).toHaveLength(edited);expect(answers.at(-1).show_alert).toBe(true);
  await tap(-100,42,panel.message_id,automatic.callback_data);
  const after=edits.length;
  await adapter.processUpdate(previous);
  expect(edits).toHaveLength(after);expect(adapter.groupReplyMode("-100",42)).toBe("all");
  expect(edits.at(-1).text).not.toContain("Mention Wolf");expect(run).not.toHaveBeenCalled();
});

it("pauses only the caller’s DM and can reopen /settings and resume in Russian",async()=>{
  const {run,sent,edits,words,tap}=fixture();
  await words(42,42,"/settings\n\n__Отправлено AI-помощником.__",{from:{id:42,language_code:"ru"}});
  expect(sent).toHaveLength(1);
  const panel=sent[0],buttons=panel.reply_markup.inline_keyboard.flat();
  expect(panel.text).toContain("Ответы в личном чате");
  await tap(42,42,panel.message_id,buttons.find((b:any)=>b.text.includes("Пауза")).callback_data);
  expect(edits.at(-1).text).toContain("приостановлены");
  await words(42,42,"Hello");expect(run).not.toHaveBeenCalled();
  await words(43,43,"Hello");expect(run).toHaveBeenCalledTimes(1);
  await words(42,42,"/settings");const current=sent.at(-1);
  expect(current.text).toContain("paused");
  await tap(42,42,current.message_id,current.reply_markup.inline_keyboard.flat().find((b:any)=>b.text.includes("On")).callback_data);
  await words(42,42,"Hello");expect(run).toHaveBeenCalledTimes(2);
});

it("ignores forwarded, bot, forged private, wrong-bot and unauthorized commands",async()=>{
  const {sent,run,words}=fixture();
  await words(-100,42,"/settings",{forward_origin:{type:"user"}});
  await words(-100,42,"/settings",{from:{id:42,is_bot:true}});
  await words(-100,42,"/settings@otherbot");
  await words(42,43,"/settings");
  await words(-100,99,"/settings");
  expect(sent).toHaveLength(0);expect(run).not.toHaveBeenCalled();
});

it("answers an explicit anonymous group command with a personal-profile hint and no controls",async()=>{
  const {sent,run,words}=fixture();
  const anon={sender_chat:{id:-100},from:{id:1087968824,is_bot:true,first_name:"Group"}};
  await words(-100,42,"/settings",anon);
  expect(sent).toHaveLength(1);expect(sent[0].text).toMatch(/personal Telegram profile/i);
  expect(sent[0].reply_markup).toBeUndefined();
  await words(-100,42,"/settings\n\nPlease change the project.",anon);
  await words(-100,42,"/settings",{...anon,forward_from:{id:42}});
  await words(-100,42,"hello",anon);
  await words(-100,42,"/settings",{...anon,sender_chat:{id:-200}});
  expect(sent).toHaveLength(1);expect(run).not.toHaveBeenCalled();
});
