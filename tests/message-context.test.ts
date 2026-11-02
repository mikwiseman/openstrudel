import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { contextPrompt, resolveMessageContext, type MessageContext } from "../src/message-context.js";
import type { CodexEngine } from "../src/types.js";

const source = { connector: "company", endpoint: "https://example.invalid/mcp", fingerprint: "0123456789abcdef" };
const verifyClient = async (ref: { clientId: string }) => {
  if (ref.clientId !== "c-acme") throw new Error("unknown");
  return { client: { id: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics", aliases: [], stage: "active", brand: "TRINITY", archived: false, archiveReason: null, fileCount: 3, readableFileCount: 2 }, source };
};

describe("context attached to a main-chat message", () => {
  it("binds a client to its verified identity and ignores the display name the app typed", async () => {
    const store = new Store(":memory:");
    try {
      const context = await resolveMessageContext({ type: "client", source, clientId: "c-acme", name: "Acme (renamed on the phone)" }, { store, homeId: "home-1", verifyClient });
      expect(context).toEqual({ type: "client", source, clientId: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics", stage: "active", brand: "TRINITY", archived: false });
      await expect(resolveMessageContext({ type: "client", source, clientId: "c-acme", name: "Acme" }, { store, homeId: "home-1" })).rejects.toMatchObject({ status: 501 });
      await expect(resolveMessageContext({ type: "client", source: { ...source, fingerprint: "nope" }, clientId: "c-acme", name: "Acme" }, { store, homeId: "home-1", verifyClient })).rejects.toMatchObject({ status: 400 });
      const prompt = contextPrompt(context);
      expect(prompt).toContain("Business client context");
      expect(prompt).toContain('"company":"Acme Robotics"');
      expect(prompt).not.toContain("renamed on the phone");
    } finally { store.close(); }
  });

  it("resolves a message or story of this device from its own store and refuses one that is gone", async () => {
    const store = new Store(":memory:");
    try {
      const editor = store.createProfile({ name: "Редактор", instructions: "" });
      const chat = store.profileConversation(editor.id);
      const message = store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "Черновик\u0007 готов: три пункта" });
      const story = store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "**Story**", story: { id: "mistral-4", edition: null, rank: null, section: "Модели", status: "Вышло", title: "Mistral Large 4", summary: "Веса открыты", body: "Текст", view: null, check: null, verification: "Прочитан блог", eventAt: null, change: null, sources: [{ title: "Blog", url: "https://mistral.ai/news", role: "Первоисточник", publishedAt: null }] } });
      const quoted = await resolveMessageContext({ type: "message", conversationId: chat.id, messageId: message.id, title: "typed", quote: "typed quote" }, { store, homeId: "home-1" });
      expect(quoted).toEqual({ type: "message", home: null, conversationId: chat.id, messageId: message.id, title: "Редактор", author: null, date: message.createdAt, quote: "Черновик готов: три пункта" });
      const sameHome = await resolveMessageContext({ type: "message", home: { id: "conn-1", homeId: "home-1", name: "Mac" }, conversationId: chat.id, messageId: message.id }, { store, homeId: "home-1", nodeId: "node-a" });
      expect(sameHome.home).toBeNull();
      const sameNode = await resolveMessageContext({ type: "message", home: { id: "conn-1", homeId: "home-1", nodeId: "node-a", name: "Mac" }, conversationId: chat.id, messageId: message.id }, { store, homeId: "home-1", nodeId: "node-a" });
      expect(sameNode.home).toBeNull();
      // An employee on another node of this Home: its record is not in this store, so the owner's quote travels with that node named.
      const otherNode = await resolveMessageContext({ type: "message", home: { id: "conn-1", homeId: "home-1", nodeId: "node-b", name: "Mini" }, conversationId: chat.id, messageId: message.id, title: "Редактор", quote: "Как выбрано на Mini" }, { store, homeId: "home-1", nodeId: "node-a" });
      expect(otherNode).toMatchObject({ type: "message", home: { id: "conn-1", homeId: "home-1", nodeId: "node-b", name: "Mini" }, title: "Редактор", quote: "Как выбрано на Mini" });
      expect((otherNode as { quote: string }).quote).not.toContain("три пункта");
      await expect(resolveMessageContext({ type: "message", home: { id: "conn-1", homeId: "home-1", nodeId: "node-b", name: "Mini" }, conversationId: chat.id, messageId: message.id }, { store, homeId: "home-1", nodeId: "node-a" })).rejects.toMatchObject({ status: 400 });
      const news = await resolveMessageContext({ type: "story", conversationId: chat.id, messageId: story.id }, { store, homeId: "home-1" });
      expect(news).toMatchObject({ type: "story", home: null, storyId: "mistral-4", title: "Mistral Large 4" });
      expect(JSON.parse((news as { quote: string }).quote)).toMatchObject({ id: "mistral-4", sources: [{ url: "https://mistral.ai/news" }] });
      await expect(resolveMessageContext({ type: "message", conversationId: chat.id, messageId: "missing" }, { store, homeId: "home-1" })).rejects.toMatchObject({ status: 409 });
      await expect(resolveMessageContext({ type: "story", conversationId: chat.id, messageId: message.id }, { store, homeId: "home-1" })).rejects.toMatchObject({ status: 409 });
      expect(contextPrompt(quoted)).toContain('conversation "Редактор"');
      expect(contextPrompt(news)).toContain("Quoted News story");
    } finally { store.close(); }
  });

  it("carries a quote chosen on another device only as bounded quoted text with its source, never resolving its ids here", async () => {
    const store = new Store(":memory:");
    try {
      const local = store.addMessage({ conversationId: store.primaryConversation().id, channel: "api", direction: "outbound", text: "LOCAL SECRET" });
      // The same numeric-looking ids exist here, yet a foreign reference never reads them.
      const foreign = await resolveMessageContext({ type: "message", home: { id: "conn-wolf", homeId: "home-wolf", name: "Wolf" }, conversationId: local.conversationId, messageId: local.id, title: "Группа", quote: "  Текст\u0000 с другого устройства " + "x".repeat(2000) }, { store, homeId: "home-1" });
      expect(foreign).toMatchObject({ type: "message", home: { id: "conn-wolf", homeId: "home-wolf", name: "Wolf" }, title: "Группа", author: null, date: null });
      expect((foreign as { quote: string }).quote).not.toContain("LOCAL SECRET");
      expect((foreign as { quote: string }).quote.startsWith("Текст с другого устройства")).toBe(true);
      expect((foreign as { quote: string }).quote.length).toBe(1500);
      await expect(resolveMessageContext({ type: "message", home: { id: "conn-wolf", homeId: "home-wolf", name: "Wolf" }, conversationId: "c", messageId: "m" }, { store, homeId: "home-1" })).rejects.toMatchObject({ status: 400 });
      // A device without its canonical Home id cannot be the source of a quote.
      await expect(resolveMessageContext({ type: "message", home: { id: "conn-wolf", name: "Wolf" }, conversationId: "c", messageId: "m", quote: "x" }, { store, homeId: "home-1" })).rejects.toMatchObject({ status: 400 });
      const prompt = contextPrompt(foreign);
      expect(prompt).toContain('another device "Wolf"');
      expect(prompt).toContain("untrusted quoted text");
    } finally { store.close(); }
  });

  it("stores the context on the request and hands the model the quoted block in the same conversation", async () => {
    const store = new Store(":memory:");
    const seen: string[] = [];
    const engine: CodexEngine = { async run(input) { seen.push(input); return { threadId: "t", response: "Ок", events: [] }; } };
    const messages = new MessageService(store, engine);
    try {
      const context: MessageContext = { type: "client", source, clientId: "c-acme", slug: "acme", name: "Acme", company: "Acme Robotics", stage: "active", brand: "TRINITY", archived: false };
      const first = await messages.handle({ channel: "api", text: "Что по договору?", context });
      const second = await messages.handle({ channel: "api", text: "А почта?" });
      expect(second.conversationId).toBe(first.conversationId);
      const history = store.listMessages(first.conversationId);
      expect(history.find(m => m.direction === "inbound" && m.text === "Что по договору?")?.context).toEqual(context);
      expect(history.find(m => m.direction === "inbound" && m.text === "А почта?")?.context).toBeUndefined();
      expect(seen[0]).toContain("Business client context");
      expect(seen[0]).toContain("Current user message:\nЧто по договору?");
      expect(seen[1]).not.toContain("Business client context");
    } finally { await messages.close(); store.close(); }
  });
});
