import { describe, expect, it } from "vitest";
import { OpenStrudelRuntime } from "../src/runtime.js";
import type { CodexEngine } from "../src/types.js";

describe("native delivery and pending questions", () => {
  it("acknowledges before completion, exposes the question, then continues without resending", async () => {
    let calls = 0;
    const engine: CodexEngine = { async run(_text, options) {
      calls++;
      const answer = await options!.onRequest!("item/tool/requestUserInput", {
        questions: [{ id: "choice", question: "Север или Юг?", options: [{ label: "Север" }, { label: "Юг" }] }],
      }) as { answers: Record<string, { answers: string[] }> };
      return { threadId: "t", response: answer.answers.choice!.answers[0]!, events: [] };
    } };
    const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine, startTelegram: false });
    const address = await runtime.api.listen("127.0.0.1", 0);
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const message = { text: "choose", externalId: "stable-id" };
      const submitted = await post("/v1/messages?async=true", message);
      expect(submitted.status).toBe(202);
      const receipt = await submitted.json();
      const duplicate = await post("/v1/messages?async=true", message);
      expect((await duplicate.json()).messageId).toBe(receipt.messageId);
      const chat = await (await fetch(base + "/v1/conversation")).json();
      expect(chat.messages[0].status).toBe("running");
      expect(chat.interactions).toHaveLength(1);
      const card = chat.interactions[0];
      expect((await post("/v1/interactions/" + card.id, { conversationId: "wrong", answers: { choice: "Север" } })).status).toBe(400);
      expect((await post("/v1/interactions/" + card.id, { conversationId: receipt.conversationId, answers: { choice: "Юг" } })).status).toBe(200);
      await new Promise(r => setTimeout(r, 10));
      const complete = await (await fetch(base + "/v1/conversation")).json();
      expect(complete.messages.at(-1).text).toBe("Юг");
      expect(complete.interactions).toEqual([]);
      expect(calls).toBe(1);
    } finally { await runtime.stop(); }
  });
});

describe("local API origin", () => {
  it("requires the local credential even from another process on the same Mac", async () => {
    const runtime=new OpenStrudelRuntime({dbPath:":memory:",engine:{async run(){throw new Error("must not run");}},startTelegram:false,apiToken:"local-test-credential"});
    const address=await runtime.api.listen("127.0.0.1",0);const url=`http://127.0.0.1:${address.port}/v1/profiles`;
    try {
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url,{headers:{authorization:"Bearer wrong"}})).status).toBe(401);
      expect((await fetch(url,{headers:{authorization:"Bearer local-test-credential"}})).status).toBe(200);
    } finally {await runtime.stop();}
  });
  it("does not let an unrelated website command the local assistant", async () => {
    const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine: { async run() { throw new Error("must not run"); } }, startTelegram: false });
    const address = await runtime.api.listen("127.0.0.1", 0);
    try {
      const result = await fetch(`http://127.0.0.1:${address.port}/v1/profiles`, { method: "POST", headers: { origin: "https://unrelated.example", "content-type": "application/json" }, body: "{}" });
      expect(result.status).toBe(403);
      expect(runtime.store.listProfiles()).toHaveLength(0);
    } finally { await runtime.stop(); }
  });
});
