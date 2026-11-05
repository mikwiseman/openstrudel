import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { Correspondence, configureCorrespondence } from "../src/correspondence.js";
import { GmailPush, type GmailPushConfig, type GmailGateway } from "../src/gmail-push.js";

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.useRealTimers(); });
const config: GmailPushConfig = { sourceId: "gmail", sourceToken: "private-source-token-longer-than-32-characters", mailbox: "owner@example.com",
  clientId: "client", clientSecret: "secret", refreshToken: "refresh", topic: "projects/project/topics/gmail",
  subscription: "projects/project/subscriptions/gmail", pushServiceAccount: "push@project.iam.gserviceaccount.com", audience: "https://home.example/hooks/correspondence/gmail-push" };
const message = (id: string, labels = ["INBOX"], threadId = "thread-1") => ({ id, threadId, labelIds: labels });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
  const store = new Store(":memory:"); stores.push(store);
  const setup = { enabled: true, conversationId: store.primaryConversation().id, calendarId: config.mailbox, defaultDurationMinutes: 60,
    sources: [{ id: config.sourceId, provider: "gmail", accountId: config.mailbox, space: "both", token: config.sourceToken }] };
  configureCorrespondence(store, true, setup);
  const worker = new Correspondence(store, { submit: vi.fn() });
  const request = vi.fn(async (path: string) => {
    if (path === "profile") return { emailAddress: config.mailbox, historyId: "100" };
    if (path === "watch") return { historyId: "100", expiration: String(Date.now() + 7 * 86400000) };
    throw new Error("Unexpected request: " + path);
  });
  const verify = vi.fn(async () => ({ email: config.pushServiceAccount, email_verified: true }));
  const gateway: GmailGateway = { request, verify };
  const push = new GmailPush(store, worker, config, gateway);
  const notify = (historyId = "200", id = "notification-1", extra: Record<string, unknown> = {}) => push.receive("Bearer signed-google-token", Buffer.from(JSON.stringify({
    subscription: config.subscription, message: { messageId: id, publishTime: new Date().toISOString(),
      data: Buffer.from(JSON.stringify({ emailAddress: config.mailbox, historyId, ...extra })).toString("base64") } })));
  const events = () => store.db.prepare("SELECT payload FROM correspondence_events ORDER BY seq").all().map(r => JSON.parse(String(r.payload)));
  return { store, setup, worker, gateway, request, verify, push, notify, events };
}
it("verifies Google identity, exact subscription and mailbox before durable acceptance", async () => {
  const f = fixture(); await f.push.maintain();
  expect(await f.notify()).toMatchObject({ accepted: true, duplicate: false });
  expect(f.request.mock.calls.map(x => x[0])).toEqual(["profile", "watch"]);
  expect(await f.notify()).toMatchObject({ duplicate: true });
  expect(f.push.status()).toMatchObject({ target: "200", cursor: "100", pendingNotifications: 1 });
  await expect(f.notify("201")).rejects.toThrow(/identity/i);
  await expect(f.notify("201", "wrong-mailbox", { emailAddress: "other@example.com" })).rejects.toThrow(/mailbox/i);
  f.verify.mockResolvedValueOnce({ email: "foreign@project.iam.gserviceaccount.com", email_verified: true });
  await expect(f.notify("201", "wrong-identity")).rejects.toThrow(/identity/i);
  f.verify.mockRejectedValueOnce(new Error("invalid JWT"));
  await expect(f.notify("201", "forged")).rejects.toThrow(/identity/i);
  await expect(f.push.receive(undefined, Buffer.from('{}'))).rejects.toThrow(/identity/i);
  expect(JSON.stringify(f.push.status())).not.toMatch(/refresh|sourceToken|clientSecret/);
});
it("drains all history pages into the shared queue, ignores drafts and read flags, and catches outgoing replies", async () => {
  const f = fixture(); await f.push.maintain(); await f.notify();
  f.request.mockImplementation(async path => {
    if (path.startsWith("history?") && !path.includes("pageToken=")) return { history: [{ id: "110", messagesAdded: [{ message: message("incoming") }, { message: message("draft", ["DRAFT"]) }], labelsRemoved: [{ message: message("incoming"), labelIds: ["UNREAD"] }] }], nextPageToken: "next", historyId: "200" };
    if (path.includes("pageToken=next")) return { history: [{ id: "190", messagesAdded: [{ message: message("sent", ["SENT"]) }] }], historyId: "200" };
    if (path.startsWith("messages/incoming?")) return message("incoming");
    if (path.startsWith("messages/draft?")) return message("draft", ["DRAFT"]);
    if (path.startsWith("messages/sent?")) return message("sent", ["SENT"]);
    throw new Error(path);
  });
  await f.push.maintain();
  expect(f.events().map(e => e.messageId)).toEqual(["incoming", "sent"]);
  expect(f.push.status()).toMatchObject({ cursor: "200", pendingNotifications: 0, recoveryRequired: false });
  expect(f.request.mock.calls.every(([p]) => !p.includes("format=full") && !p.includes("messages?"))).toBe(true);
});
it("retains the cursor across page failure and process restart without duplicating accepted events", async () => {
  const f = fixture(); await f.push.maintain(); await f.notify();
  let fail = true;
  f.request.mockImplementation(async path => {
    if (path.includes("pageToken=next")) { if (fail) throw new Error("temporary outage"); return { historyId: "200" }; }
    if (path.startsWith("history?")) return { history: [{ id: "110", messagesAdded: [{ message: message("incoming") }] }], nextPageToken: "next", historyId: "200" };
    if (path.startsWith("messages/")) return message("incoming");
    throw new Error(path);
  });
  await f.push.maintain(); expect(f.push.status().cursor).toBe("100"); expect(f.events()).toHaveLength(1);
  vi.advanceTimersByTime(60_000); fail = false;
  const restarted = new GmailPush(f.store, f.worker, config, f.gateway);
  await restarted.maintain(); expect(restarted.status().cursor).toBe("200"); expect(f.events()).toHaveLength(1);
});
it("renews daily, catches dropped pushes, and never resets an expired history cursor silently", async () => {
  const f = fixture(); await f.push.maintain(); vi.advanceTimersByTime(86400000);
  f.request.mockImplementation(async path => {
    if (path === "profile") return { emailAddress: config.mailbox };
    if (path === "watch") return { historyId: "300", expiration: String(Date.now() + 7 * 86400000) };
    if (path.startsWith("history?")) throw Object.assign(new Error("history expired"), { status: 404 });
    throw new Error(path);
  });
  await f.push.maintain();
  expect(f.push.status()).toMatchObject({ cursor: "100", target: "300", recoveryRequired: true });
  expect(f.events()).toEqual([]);
});
it("refuses source revocation and mailbox mismatch even with a valid Google token", async () => {
  const f = fixture(); await f.push.maintain();
  configureCorrespondence(f.store, true, { ...f.setup, enabled: false });
  await expect(f.notify()).rejects.toThrow(/authorized/i);
  const g = fixture(); g.request.mockResolvedValueOnce({ emailAddress: "foreign@example.com", historyId: "100" });
  await g.push.maintain(); expect(g.push.status().lastError).toMatch(/mailbox/i);
  expect(g.request).toHaveBeenCalledTimes(1);
});
it("retains pushes that arrive during history reads and rejects foreign subscription/identity changes", async () => {
  const f = fixture(); await f.push.maintain(); await f.notify();
  let pageCalls = 0;
  f.request.mockImplementation(async path => {
    if (path.startsWith('history?')) {
      pageCalls++;
      if (pageCalls === 1) { await f.notify('300', 'newer'); return { historyId: '200' }; }
      return { historyId: '300' };
    }
    throw new Error(path);
  });
  await f.push.maintain(); expect(f.push.status()).toMatchObject({ cursor: '200', target: '300', pendingNotifications: 1 });
  await f.push.maintain(); expect(f.push.status()).toMatchObject({ cursor: '300', pendingNotifications: 0 });
  await f.notify('150', 'late'); expect(f.push.status().pendingNotifications).toBe(0);
  const wrong = Buffer.from(JSON.stringify({ subscription: 'projects/project/subscriptions/other', message: { messageId: 'bad', publishTime: new Date().toISOString(), data: Buffer.from(JSON.stringify({ emailAddress: config.mailbox, historyId: '400' })).toString('base64') } }));
  await expect(f.push.receive('Bearer signed', wrong)).rejects.toThrow(/subscription/i);
  expect(() => new GmailPush(f.store, f.worker, { ...config, mailbox: 'other@example.com' }, f.gateway)).toThrow(/identity changed/i);
});
it("invalidates managed messages on deletion/archive without processing draft deletes", async () => {
  const f = fixture(); await f.push.maintain(); await f.notify();
  f.request.mockImplementation(async path => {
    if (path.startsWith('history?')) return { historyId: '200', history: [
      { id: '110', messagesAdded: [{ message: message('incoming') }] },
      { id: '120', labelsRemoved: [{ message: message('incoming'), labelIds: ['INBOX'] }] },
      { id: '130', messagesDeleted: [{ message: message('incoming') }, { message: message('draft', ['DRAFT']) }] },
    ] };
    if (path.startsWith('messages/incoming?')) return message('incoming');
    throw new Error(path);
  });
  await f.push.maintain();
  expect(f.events().map(e => e.type)).toEqual(['message.new', 'message.updated', 'message.deleted']);
});
