import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const wire=vi.hoisted(()=>({outputs:[] as string[],turns:0,called:""}));
vi.mock("../src/rpc.js",()=>({CodexRpc:class {
  exited=Promise.resolve();initialize=async()=>{};close() {}
  constructor(_home:unknown,private notify:(event:any)=>void) {}
  async request(method:string,params:any) {
    if(method==="account/read") return {account:{type:"chatgpt",email:"tester@example.org"}};
    if(method==="thread/start") return {thread:{id:"engineer"},model:"gpt-6.2-astra",reasoningEffort:"ultra",serviceTier:"default"};
    if(method==="turn/start"){
      const id="turn-"+(++wire.turns);wire.called=params.input[0].text;
      const send=(threadId:string,method:string,data:any)=>this.notify({method,params:{threadId,turnId:id,...data}});
      send("helper","item/completed",{item:{type:"agentMessage",phase:"final_answer",text:"A delegated observation"}});
      send("helper","turn/completed",{turn:{id:"child",status:"completed"}});
      send("engineer","item/completed",{item:{type:"agentMessage",phase:"final_answer",text:wire.outputs.shift()}});
      send("engineer","item/completed",{item:{type:"agentMessage",phase:"commentary",text:"A progress update"}});
      send("engineer","turn/completed",{turn:{id,status:"completed"}});
      return {turn:{id}};
    }
    return {};
  }
}}));
import { prepareCandidate } from "../src/aigid-candidate.js";
const root=mkdtempSync(join(tmpdir(),"wolf-rpc-"));
afterEach(()=>{wire.turns=0;wire.outputs.length=0;rmSync(root,{recursive:true,force:true});});
const example=()=>prepareCandidate({home:root,cwd:tmpdir(),inputs:tmpdir(),images:[],goal:"Inspect the web entry",branch:"test",changes:true,
  account:{read:async()=>({connected:true,email:"tester@example.org"}),authTokens:async()=>({accessToken:"test",chatgptAccountId:"test"})},
  email:"tester@example.org",selection:{model:"gpt-6.2-astra",reasoningEffort:"ultra"},project:"owner/site",signal:new AbortController().signal});
it("uses the parent final answer and ignores commentary and delegated completions",async()=>{
 wire.outputs.push(JSON.stringify({ready:true,notes:"Actual source",checks:"Passed checks"}));expect((await example()).notes).toBe("Actual source");expect(wire.turns).toBe(1);
});
it("recovers a malformed report once without reimplementing the request",async()=>{
 wire.outputs.push("Plain text",JSON.stringify({ready:true,notes:"Prepared",checks:"Inspected"}));expect((await example()).notes).toBe("Prepared");expect(wire.turns).toBe(2);expect(wire.called).toMatch(/format/i);
});
it("preserves an actual failing check without asking the model to reinterpret it",async()=>{
 wire.outputs.push(JSON.stringify({ready:false,notes:"Check failed",checks:"Module missing"}));await expect(example()).rejects.toThrow("Module missing");expect(wire.turns).toBe(1);
});
it("asks for a complete short result when the worker report would end mid-sentence", async () => {
  wire.outputs.push(JSON.stringify({ ready:true, notes:"Long diagnostics. ".repeat(130), checks:"Inspected" }),
    JSON.stringify({ ready:true, notes:"The next question can be missed while the microphone reconnects.", checks:"Inspected" }));
  expect((await example()).notes).toBe("The next question can be missed while the microphone reconnects.");
  expect(wire.turns).toBe(2);
});
