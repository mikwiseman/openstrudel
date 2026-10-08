import { describe, expect, it, vi } from "vitest";
import { Interactions } from "../src/interactions.js";

const card = { conversationId: "chat", messageId: "message", title: "Confirm", questions: [{ id: "decision", question: "Send?", options: ["Yes", "No"] }] };
describe("Codex approvals", () => {
  it("requires the exact chat and offered answer, resolves once", async () => {
    const broker = new Interactions();
    const result = broker.ask(card);
    const id = broker.list("chat")[0]!.id;
    await expect(broker.answer(id, "another", { decision: "Yes" })).rejects.toThrow();
    await expect(broker.answer(id, "chat", { decision: "Maybe" })).rejects.toThrow();
    await broker.answer(id, "chat", { decision: "No" });
    expect(await result).toEqual({ decision: "No" });
    await expect(broker.answer(id, "chat", { decision: "Yes" })).rejects.toThrow();
  });
  it("keeps an OAuth card pending until the service confirms access", async () => {
    const broker = new Interactions();
    let connected = false;
    const result = broker.ask(card, async () => { if (!connected) throw new Error("Not connected"); });
    const id = broker.list("chat")[0]!.id;
    await expect(broker.answer(id, "chat", { decision: "Yes" })).rejects.toThrow("Not connected");
    expect(broker.list("chat")).toHaveLength(1);
    connected = true;
    await broker.answer(id, "chat", { decision: "Yes" });
    await result;
  });
  it("denies instead of auto-approving an unknown server request", async () => {
    await expect(new Interactions().codexRequest("c", "m", "unknown/request", {})).rejects.toThrow("не разрешено");
  });
  it.each(["Разрешить", "Отказать"])("handles the real Codex MCP tool approval form: %s", async decision => {
    const broker = new Interactions();
    const result = broker.codexRequest("chat", "message", "mcpServer/elicitation/request", {
      mode: "form", serverName: "service", message: 'Allow service to run tool "test"?',
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { target: "Test record" } },
      requestedSchema: { type: "object", properties: {} },
    }, "7");
    const pending = broker.list("chat")[0]!;
    expect(pending.requestedBy).toBe("7");
    expect(pending.detail).toContain("Test record");
    await broker.answer(pending.id, "chat", { decision });
    expect(await result).toEqual({ action: decision === "Разрешить" ? "accept" : "decline", content: decision === "Разрешить" ? {} : null, _meta: null });
    expect(broker.list("chat")).toEqual([]);
  });
  it("does not silently accept a form that requires input or user verification", async () => {
    for (const params of [
      { mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" }, requestedSchema: { type: "object", properties: { password: { type: "string" } } } },
      { mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" }, requestedSchema: { type: "object", properties: {}, required: ["token"] } },
      { mode: "openai/userVerification", challenge: "test" },
    ]) await expect(new Interactions().codexRequest("c", "m", "mcpServer/elicitation/request", params)).rejects.toThrow("не разрешено");
  });
  it("cancels waiting requests when a turn ends", async () => {
    const broker = new Interactions();
    const result = broker.ask(card);
    broker.cancelMessage("message");
    await expect(result).rejects.toThrow();
    expect(broker.list("chat")).toEqual([]);
  });
  it("expires an unanswered approval without accepting the action", async () => {
    vi.useFakeTimers();
    const broker = new Interactions();
    try {
      const result = broker.ask(card);
      const id = broker.list("chat")[0]!.id;
      const rejected = expect(result).rejects.toThrow("не подтверждено");
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await rejected;
      expect(broker.list("chat")).toEqual([]);
      await expect(broker.answer(id, "chat", { decision: "Yes" })).rejects.toThrow("завершён");
    } finally { broker.close(); vi.useRealTimers(); }
  });
});
