import { afterEach, expect, it, vi } from "vitest";
const wire = vi.hoisted(() => ({ request: vi.fn(), notify: undefined as undefined | ((message: any) => void) }));
vi.mock("../src/rpc.js", () => ({ CodexRpc: class {
  closed = false;
  constructor(_home: unknown, notify: (message: any) => void) { wire.notify = notify; }
  initialize = async () => undefined;
  request = wire.request;
  close() { this.closed = true; }
} }));
import { CodexEngineAdapter } from "../src/codex.js";
afterEach(() => wire.request.mockReset());

it("steers the current native turn with its expected id and does not start another turn", async () => {
  wire.request.mockImplementation(async (method: string) => {
    if (method === "thread/start") return { thread: { id: "steer-thread" } };
    if (method === "turn/start") return { turn: { id: "running-turn" } };
    if (method === "turn/steer") return { turnId: "running-turn" };
    throw new Error(method);
  });
  const engine = new CodexEngineAdapter();
  const pending = engine.run("Draft");
  await vi.waitFor(() => expect(wire.request.mock.calls.some(([m]) => m === "turn/start")).toBe(true));
  expect(await engine.steer("Keep it shorter", { threadId: "steer-thread", images: ["/tmp/fixture.png"] })).toBe(true);
  expect(wire.request.mock.calls.find(([m]) => m === "turn/steer")?.[1]).toEqual({ threadId: "steer-thread", expectedTurnId: "running-turn", input: [{ type: "text", text: "Keep it shorter" }, { type: "localImage", path: "/tmp/fixture.png" }] });
  wire.notify?.({ method: "turn/completed", params: { threadId: "steer-thread", turn: { status: "completed" } } });
  await pending;
  expect(await engine.steer("Late input", { threadId: "steer-thread" })).toBe(false);
  expect(wire.request.mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(1);
  engine.close();
});

it("changes approval policy on resume without replaying identity or silently approving a pending request",async()=>{
  wire.request.mockImplementation(async(method:string,params:any)=>{
    if(method==="thread/start"||method==="thread/resume")return {thread:{id:"approval-thread"}};
    if(method==="thread/unsubscribe")return {};
    if(method==="turn/start"){
      queueMicrotask(()=>wire.notify?.({method:"turn/completed",params:{threadId:params.threadId,turn:{status:"completed"}}}));
      return {turn:{id:"turn"}};
    }
    throw new Error(method);
  });
  const engine=new CodexEngineAdapter({config:{mcp_servers:{fixture:{command:"test",enabled:false}}}});
  try {
    const first=await engine.run("First");
    await engine.run("Second",{threadId:first.threadId,approvalMode:"auto",groupContext:true});
    await engine.run("Third",{threadId:first.threadId,approvalMode:"approve_all",groupContext:true});
    const resumes=wire.request.mock.calls.filter(([m])=>m==="thread/resume").map(([,p])=>p);
    expect(resumes[0].approvalsReviewer).toBe("auto_review");
    expect(resumes[0].approvalPolicy.granular.request_permissions).toBe(false);
    expect(resumes[1].approvalPolicy).toBe("never");
    expect(resumes[1].config['mcp_servers.fixture.default_tools_approval_mode']).toBe("approve");
    expect(resumes[1].config.mcp_servers.fixture.enabled).toBe(false);
    expect(wire.request.mock.calls.filter(([m])=>m==="thread/unsubscribe")).toHaveLength(2);
    expect(wire.request.mock.calls.some(([m])=>m==="thread/inject_items")).toBe(false);
  }finally{engine.close();}
});

it("sends identity as developer instructions and refreshes it when the employee changes", async () => {
  wire.request.mockImplementation(async (method: string, params: any) => {
    if (method === "thread/start" || method === "thread/resume") return {thread:{id:"identity-thread"}};
    if (method === "thread/inject_items") return {};
    if (method === "turn/start") {
      queueMicrotask(() => {
        wire.notify?.({method:"item/completed",params:{threadId:params.threadId,item:{type:"agentMessage",text:"НЕТ"}}});
        wire.notify?.({method:"turn/completed",params:{threadId:params.threadId,turn:{status:"completed"}}});
      });
      return {turn:{id:"turn"}};
    }
    throw new Error(method);
  });
  const engine = new CodexEngineAdapter();
  try {
    const first = await engine.run("Йо!", {profile:"Отвечай только НЕТ."});
    const start = wire.request.mock.calls.find(([method]) => method === "thread/start")![1];
    expect(start.developerInstructions).toContain("Отвечай только НЕТ.");
    expect(wire.request.mock.calls.find(([method]) => method === "turn/start")![1].input[0].text).toBe("Йо!");
    await engine.run("Привет!", {threadId:first.threadId,profile:"Отвечай только НЕТ."});
    expect(wire.request.mock.calls.filter(([method]) => method === "thread/resume")).toHaveLength(0);
    await engine.run("Привет!", {threadId:first.threadId,profile:"Новая роль: редактор."});
    expect(wire.request.mock.calls.find(([method]) => method === "thread/resume")![1].developerInstructions).toContain("Новая роль: редактор.");
    const update = wire.request.mock.calls.find(([method]) => method === "thread/inject_items")![1];
    expect(update.items[0].role).toBe("developer");
    expect(update.items[0].content[0].text).toContain("Новая роль: редактор.");
  } finally { engine.close(); }
});

it("refreshes native MCP credentials for each group delivery without rewriting personality",async()=>{
 wire.request.mockImplementation(async(method:string,params:any)=>{
  if(method==="thread/start" || method==="thread/resume")return {thread:{id:"group"}};
  if(method==="thread/unsubscribe")return {status:"unsubscribed"};
  if(method==="turn/start"){
   queueMicrotask(()=>wire.notify?.({method:"turn/completed",params:{threadId:params.threadId,turn:{status:"completed"}}}));
   return {turn:{id:"turn"}};
  }
  throw new Error(method);
 });
 const engine=new CodexEngineAdapter({telegramServers:{company:{url:"https://example.test/mcp",http_headers:{Authorization:"Bearer fixture"}}}});
 try{
  await engine.run("First",{profile:"Core",telegramActor:{userId:"7",chatId:"-100",messageId:"-100:1"}});
  await engine.run("Second",{threadId:"group",profile:"Core",telegramActor:{userId:"8",chatId:"-100",messageId:"-100:2"}});
  const resumed=wire.request.mock.calls.find(([method])=>method==="thread/resume")![1];
  expect(resumed.config["mcp_servers.company"].http_headers).toMatchObject({"x-hermes-user-id":"8","x-hermes-chat-id":"-100","x-hermes-message-id":"-100:2"});
  expect(wire.request.mock.calls.findIndex(([method])=>method==="thread/unsubscribe")).toBeLessThan(wire.request.mock.calls.findIndex(([method])=>method==="thread/resume"));
  expect(wire.request.mock.calls.some(([method])=>method==="thread/inject_items")).toBe(false);
  await engine.run("UI",{threadId:"group",profile:"Core"});
  expect(wire.request.mock.calls.filter(([method])=>method==="thread/resume").at(-1)![1].config["mcp_servers.company"].enabled).toBe(false);
 }finally{engine.close();}
});
