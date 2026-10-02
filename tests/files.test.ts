import { mkdtempSync, rmSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenStrudelRuntime } from "../src/runtime.js";

describe("files in a conversation", () => {
  it("returns a real generated file and refuses files outside the employee workspace", async () => {
    const root = mkdtempSync(resolve(tmpdir(),"strudel-output-"));
    const path=resolve(root,".data/workspace/work/report.txt");
    mkdirSync(resolve(root,".data/workspace/work"),{recursive:true}); writeFileSync(path,"Verified report");
    const outside=resolve(root,"private.txt");writeFileSync(outside,"Private");
    const runtime = new OpenStrudelRuntime({dbPath:":memory:",rootDirectory:root,startTelegram:false,engine:{async run(_text,options){
      await expect(options!.tools!.call("attach_file",{path:outside})).rejects.toThrow("рабочей области");
      await options!.tools!.call("attach_file",{path});
      return {threadId:"file-output",response:"Отчёт готов.",events:[]};
    }}});
    try {
      const employee=runtime.store.createProfile({name:"Reports",domain:"work"});
      const result=await runtime.messages.handle({channel:"api",profile:employee.id,text:"Create a report"});
      const answer=runtime.store.findReplyTo(runtime.store.listMessages(result.conversationId)[0]!.id)!;
      expect(answer.attachments?.[0]?.name).toBe("report.txt");
      expect(runtime.messages.files.get(answer.attachments![0]!.id)?.path).not.toBe(path);
    } finally {await runtime.stop();rmSync(root,{recursive:true,force:true});}
  });
  it("delivers an attachment once and refuses to lend it to a different employee", async () => {
    const root = mkdtempSync(resolve(tmpdir(),"strudel-files-"));
    let received = "";
    const runtime = new OpenStrudelRuntime({dbPath:":memory:",rootDirectory:root,startTelegram:false,engine:{async run(text){received=text;return {threadId:"t",response:"File read",events:[]};}}});
    const address=await runtime.api.listen("127.0.0.1",0);
    const base=`http://127.0.0.1:${address.port}`;
    const post=(path:string,body:unknown)=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    try {
      const a=runtime.store.createProfile({name:"Personal"});const b=runtime.store.createProfile({name:"Work",domain:"work"});
      const first=runtime.store.profileConversation(a.id);const second=runtime.store.profileConversation(b.id);
      const upload=await post(`/v1/conversations/${first.id}/files`,{name:"note.txt",mimeType:"text/plain",contentBase64:Buffer.from("Only for this employee").toString("base64")});
      expect(upload.status).toBe(201);
      const {attachment}=await upload.json();
      expect((await post("/v1/messages",{conversationId:second.id,text:"Read",attachments:[attachment.id]})).status).toBe(400);
      const message={conversationId:first.id,text:"Read",attachments:[attachment.id],externalId:"same-file-message"};
      expect((await post("/v1/messages",message)).status).toBe(200);
      expect(received).toContain("note.txt");
      expect(received).toContain(first.id);
      expect((await post("/v1/messages",message)).status).toBe(200);
      expect(runtime.store.listMessages(first.id).filter(m=>m.direction==="inbound")).toHaveLength(1);
      const visible=runtime.store.listMessages(first.id)[0]!;
      expect(visible.attachments?.[0]).toMatchObject({name:"note.txt",id:attachment.id});
      const downloaded=await fetch(base+`/v1/files/${attachment.id}`);
      expect(await downloaded.text()).toBe("Only for this employee");
    } finally {await runtime.stop();rmSync(root,{recursive:true,force:true});}
  });
});
