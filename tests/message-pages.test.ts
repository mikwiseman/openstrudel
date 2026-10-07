import { afterEach, expect, it } from "vitest";
import { Store } from "../src/store.js";
const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const chat = store.primaryConversation();
  const messages = Array.from({ length: 127 }, (_, i) => store.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: String(i) }));
  store.db.prepare("UPDATE messages SET created_at=?").run("2026-10-07T00:00:00.000Z");
  return { store, chat, messages };
}
it("walks tied timestamps in bounded pages without duplication while new replies arrive", () => {
  const { store, chat, messages } = fixture();
  const latest = store.messagePage(chat.id, new URLSearchParams("limit=50"));
  expect(latest.messages.map(m => m.id)).toEqual(messages.slice(-50).map(m => m.id));
  const fresh = store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: "New reply" });
  const middle = store.messagePage(chat.id, new URLSearchParams({ before: latest.pagination.olderCursor!, limit: "50" }));
  const first = store.messagePage(chat.id, new URLSearchParams({ before: middle.pagination.olderCursor!, limit: "50" }));
  expect([...first.messages, ...middle.messages, ...latest.messages].map(m => m.id)).toEqual(messages.map(m => m.id));
  expect(first.pagination.olderCursor).toBeNull();
  const delta = store.messagePage(chat.id, new URLSearchParams({ after: latest.pagination.newerCursor! }));
  expect(delta.messages.map(m => m.id)).toEqual([fresh.id]);
  expect(delta.pagination.hasMore).toBe(false);
});
it("refreshes a pending message outside the newest page and drains a large backlog", () => {
  const { store, chat, messages } = fixture();
  store.setMessageStatus(messages[0]!.id, "failed", "Interrupted");
  const delta = store.messagePage(chat.id, new URLSearchParams({ after: messages[49]!.id, limit: "50", watch: messages[0]!.id }));
  expect(delta.messages).toHaveLength(50);
  expect(delta.pagination.hasMore).toBe(true);
  expect(delta.updates[0]).toMatchObject({ id: messages[0]!.id, status: "failed", error: "Interrupted" });
  const next = store.messagePage(chat.id, new URLSearchParams({ after: delta.pagination.newerCursor! }));
  expect(next.messages).toHaveLength(27);
  expect(next.pagination.hasMore).toBe(false);
});
it("does not accept another conversation's cursor or expose hidden messages", () => {
  const { store, chat, messages } = fixture();
  store.db.prepare("UPDATE messages SET hidden=1 WHERE id=?").run(messages.at(-1)!.id);
  expect(store.messagePage(chat.id, new URLSearchParams()).messages.at(-1)!.id).toBe(messages.at(-2)!.id);
  const other = store.getOrCreateConversation({ channel: "api", externalId: "other" });
  expect(() => store.messagePage(other.id, new URLSearchParams({ before: messages[0]!.id }))).toThrow();
});
