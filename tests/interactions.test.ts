import { describe, expect, it } from "vitest";
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
  it("cancels waiting requests when a turn ends", async () => {
    const broker = new Interactions();
    const result = broker.ask(card);
    broker.cancelMessage("message");
    await expect(result).rejects.toThrow();
    expect(broker.list("chat")).toEqual([]);
  });
});
