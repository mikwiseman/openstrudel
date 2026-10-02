import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {afterEach,expect,it,vi} from "vitest";
import {OpenStrudelRuntime} from "../src/runtime.js";
afterEach(()=>vi.unstubAllGlobals());
it("keeps Telegram documents and generated replies in the same employee chat",async()=>{
  const root=mkdtempSync(resolve(tmpdir(),"strudel-telegram-files-"));
  const received:{path?:string;bytes?:string}={};
  const runtime=new OpenStrudelRuntime({rootDirectory:root,dbPath:":memory:",startTelegram:false,engine:{async run(input,options){
    const file=runtime.store.listMessages(runtime.store.profileConversation(employee.id).id)[0]!.attachments![0]!;
    received.bytes=readFileSync(runtime.messages.files.get(file.id)!.path,"utf8");
    received.path=input;
    const directory=resolve(root,".data/workspace/work");mkdirSync(directory,{recursive:true});
    const output=resolve(directory,"answer.txt");writeFileSync(output,"Verified reply file");
    await options!.tools!.call("attach_file",{path:output});
    return {threadId:"document-chat",response:"Файл готов.",events:[]};
  }}});
  const employee=runtime.store.createProfile({name:"Documents",domain:"work"});
  runtime.store.linkTelegramChat({chatId:"42",title:"Owner",allowedSenders:["42"]});runtime.store.bindTelegramChat("42",employee.id);
  const sent: Array<{method:string;data:any}>=[];
  vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{
    if(url.includes("/file/"))return new Response("Private source document");
    const method=url.split("/").at(-1)!;
    if(init?.body instanceof FormData){sent.push({method,data:init.body});return Response.json({ok:true,result:{message_id:102}});}
    sent.push({method,data:JSON.parse(String(init?.body))});
    return Response.json({ok:true,result:method==="getFile"?{file_path:"documents/note.txt",file_size:23}:{message_id:101}});
  }));
  const {TelegramAdapter}=await import("../src/telegram.js");
  const adapter=new TelegramAdapter("123:test",runtime.store,runtime.messages);
  try {
    const update={update_id:7,message:{message_id:8,from:{id:42},chat:{id:42},document:{file_id:"doc",file_name:"note.txt",mime_type:"text/plain",file_size:23},caption:"Прочитай и подготовь файл"}};
    await adapter.processUpdate(update);
    expect(received.bytes).toBe("Private source document");expect(received.path).toContain("note.txt");
    const chat=runtime.store.profileConversation(employee.id);
    expect(runtime.store.listMessages(chat.id)[0]!.attachments?.[0]?.name).toBe("note.txt");
    const outgoing=sent.find(s=>s.method==="sendDocument")?.data as FormData;
    expect(outgoing).toBeInstanceOf(FormData);expect(await (outgoing.get("document") as Blob).text()).toBe("Verified reply file");
    await adapter.processUpdate(update);
    expect(sent.filter(s=>s.method==="sendDocument")).toHaveLength(1);
  } finally {adapter.stop();await runtime.stop();rmSync(root,{recursive:true,force:true});}
});
