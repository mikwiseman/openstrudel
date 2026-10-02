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
