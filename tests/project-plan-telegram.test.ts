import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { AiGidBuilds } from "../src/aigid-testflight.js";

afterEach(()=>vi.unstubAllGlobals());

it.each([[42,"tap"],[-10042,"tap"],[42,"words"],[-10042,"words"]] as const)("shows, revises and approves precisely one build-only plan in Telegram chat %i via %s", async (chat,mode) => {
  const root=mkdtempSync(join(tmpdir(),"wolf-plan-")), store=new Store(":memory:");
  mkdirSync(join(root,".data/aigid-testflight"),{recursive:true});
  writeFileSync(join(root,".data/aigid-testflight/config.json"),JSON.stringify({telegram:["42","43"],devices:[],groups:["-10042"],accountEmail:"qa@example.org",repository:"example/qa"}));
  const first="Собрать текущую основную ветку для TestFlight.", revised="Собрать текущую основную ветку для обоих тестировщиков.";
  const messages=new MessageService(store,{run:async(input,options)=>{
    const current=input.split("Current user message:").at(-1)!.trim();
    if(current.endsWith("Одобряю") || current.endsWith("Не одобряю")){
      const status=await options!.tools!.call("aigid_build_status",{}) as {proposals:Array<{id:string}>};
      try {
        await options!.tools!.call("aigid_approve",{proposal:status.proposals.at(-1)!.id});
      } catch { return {threadId:"test",response:"Уточните решение.",events:[]}; }
      return {threadId:"test",response:"В очереди.",events:[]};
    }
    const edit=input.includes("для обоих");
    await options!.tools!.call("aigid_propose",{goal:edit?revised:first,change:false,feedbackMessages:[],replaces:null});
    return {threadId:"test",response:"I will report here after reviewing the source.",events:[]};
  }},root);
  const adapter=new TelegramAdapter("42:test",store,messages);messages.telegram=adapter;
  store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});
  store.setSetting("access.people",JSON.stringify(["42","43"]));
  if(chat<0){store.linkTelegramChat({chatId:String(chat),title:"QA",allowedSenders:["42","43"]});store.connectTelegramGroup(String(chat));}
  const worker=AiGidBuilds.start(store,messages.files,{} as never,undefined,adapter)!;
  vi.spyOn(worker,"kick").mockImplementation(()=>{});
  const sent:any[]=[],edited:any[]=[],toasts:any[]=[];
  let next=800;
  vi.stubGlobal("fetch",vi.fn(async(url,init)=>{
    const method=String(url).split("/").at(-1), p=JSON.parse(init.body);
    if(method==="sendMessage") {sent.push({...p,message_id:++next});return Response.json({ok:true,result:{message_id:next}});}
    if(method==="editMessageText") edited.push(p);
    if(method==="answerCallbackQuery") toasts.push(p);
    return Response.json({ok:true,result:true});
  }));
  let update=40;
  const words=(body:string,reply?:number)=>adapter.processUpdate({update_id:++update,message:{message_id:update,chat:{id:chat},from:{id:42,first_name:"Owner"},text:body,...reply?{reply_to_message:{message_id:reply,from:{id:999,is_bot:true,username:"wolfbot"}}}:{}}});
  const tap=(message:number,button:string,sender=42,chatId=chat)=>adapter.processUpdate({update_id:++update,callback_query:{id:String(update),from:{id:sender},message:{message_id:message,chat:{id:chatId}},data:button}});
  try{
    await words("Предложи план сборки AiGid");
    const plan=sent[0];expect(plan.text).toContain(first);expect(plan.text).not.toContain("report here");
    const buttons=plan.reply_markup.inline_keyboard.flat();
    expect(buttons.map((b:any)=>b.text)).toEqual(["Править план","Одобрить и собрать"]);
    await tap(plan.message_id,buttons[1].callback_data,99);
    expect(toasts.at(-1).show_alert).toBe(true);
    await tap(plan.message_id,buttons[1].callback_data,42,chat===42?-10042:42);
    expect(toasts.at(-1).show_alert).toBe(true);
    await tap(plan.message_id,buttons[0].callback_data);
    const prompt=sent.at(-1);expect(prompt.reply_markup.force_reply).toBe(true);
    await words("Поправь: для обоих", prompt.message_id);
    const version=sent.at(-1);expect(version.text).toContain(revised);
    expect(worker.queue.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n).toBe(0);
    expect(edited.some(x=>x.message_id===plan.message_id && !x.reply_markup.inline_keyboard.length)).toBe(true);
    await tap(plan.message_id,buttons[1].callback_data);
    expect(toasts.at(-1).show_alert).toBe(true);
    const approve=version.reply_markup.inline_keyboard.flat()[1].callback_data;
    if(mode==="words"){
      await words("Не одобряю",version.message_id);
      expect(worker.queue.db.prepare("SELECT count(*) AS n FROM jobs").get()?.n).toBe(0);
      await words("Одобряю",version.message_id);
    } else {
      await tap(version.message_id,approve,chat>0?42:43);
      expect(edited.at(-1).text).toContain("В очереди");
      expect(edited.at(-1).reply_markup.inline_keyboard).toEqual([]);
    }
    await tap(version.message_id,approve,42);
    expect(worker.queue.db.prepare("SELECT goal,changes FROM jobs").all()).toEqual([{goal:revised,changes:0}]);
  }finally{await worker.close();adapter.stop();await messages.close();store.close();rmSync(root,{recursive:true,force:true});}
});
