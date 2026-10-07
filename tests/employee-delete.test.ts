import { afterEach, expect, it } from "vitest";
import { OpenStrudelRuntime } from "../src/runtime.js";
import { MockCodexEngine } from "../src/codex.js";
import { deleteEmployee } from "../src/employee-delete.js";
import { assertAgentWritable } from "../src/agent-move.js";
const runtimes: OpenStrudelRuntime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop(); });
function fixture() {
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", engine: new MockCodexEngine(), startTelegram: false }); runtimes.push(runtime);
  const s = runtime.store, first = s.createProfile({ name: "Remove me" }), other = s.createProfile({ name: "Keep me" });
  return { runtime, s, first, other, chat: s.profileConversation(first.id), keep: s.profileConversation(other.id) };
}
it("deletes the selected employee's chats and schedules, detaches Telegram, and preserves others", () => {
  const { runtime, s, first, other, chat, keep } = fixture();
  const msg = s.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: "Delete" });
  s.addMessage({ conversationId: keep.id, channel: "api", direction: "inbound", text: "Keep" });
  s.linkTelegramChat({ chatId: "42", title: "Private", allowedSenders: ["42"] }); s.bindTelegramChat("42", first.id);
  runtime.messages.scheduler!.save({ conversationId: chat.id, name: "Digest", prompt: "News", cron: "0 6 * * *", timezone: "UTC" });
  deleteEmployee(s, first.id);
  expect(s.getProfile(first.id)).toBeNull();
  expect(s.getConversation(chat.id)).toBeNull();
  expect(s.db.prepare("SELECT id FROM messages WHERE id=?").get(msg.id)).toBeUndefined();
  expect(runtime.messages.scheduler!.list(chat.id)).toEqual([]);
  expect(s.getTelegramChat("42")?.profileId).toBeNull();
  expect(s.getProfile(other.id)).not.toBeNull();
  expect(s.listMessages(keep.id)).toHaveLength(1);
  expect(() => assertAgentWritable(s, first.id)).toThrow("удалён");
  expect(s.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("refuses deletion while work is running and rolls back every change", () => {
  const { s, first, chat } = fixture();
  const msg = s.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: "Working" });
  s.setMessageStatus(msg.id, "running");
  expect(() => deleteEmployee(s, first.id)).toThrow("выполняет поручение");
  expect(s.getProfile(first.id)).not.toBeNull();
  expect(s.getSetting("employee.deleted." + first.id)).toBeNull();
  expect(() => deleteEmployee(s, "main")).toThrow();
});
it("exposes deletion and bounded history through the authenticated API", async () => {
  const { runtime, s, first, chat } = fixture();
  const imported = s.getOrCreateConversation({ channel: "api", externalId: "import::delete-test", title: "Imported history" });
  s.db.prepare("UPDATE conversations SET profile_id=? WHERE id=?").run(first.id, imported.id);
  for (let i = 0; i < 70; i++) s.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: String(i) });
  const address = await runtime.api.listen("127.0.0.1", 0), base = `http://127.0.0.1:${address.port}`;
  const page = await (await fetch(base + `/v1/agents/${first.id}/conversation?page=true&limit=50`)).json() as any;
  expect(page.messages).toHaveLength(50); expect(page.pagination.olderCursor).toBeTruthy();
  const response = await fetch(base + "/v1/profiles/" + first.id, { method: "DELETE" });
  expect(response.status).toBe(200);
  const profiles = await (await fetch(base + "/v1/profiles")).json() as any;
  expect(profiles.profiles.some((p: any) => p.id === first.id)).toBe(false);
  expect(profiles.importedConversations.some((c: any) => c.id === imported.id)).toBe(false);
  const conversations = await (await fetch(base + "/v1/conversations")).json() as any;
  expect(conversations.conversations.some((c: any) => c.profileId === first.id)).toBe(false);
});
