import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter, type TelegramUpdate } from "../src/telegram.js";
import type { CodexEngine } from "../src/types.js";

type Run = NonNullable<CodexEngine["run"]>;
type Call = { method: string; body: any };
const cleanups: Array<() => unknown> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); });

/** One Home: a paired owner (42, "Den"), a group with a colleague who has access (43), and a member who has none (44). */
function home(options: { file?: string; run?: Run } = {}) {
  const store = new Store(options.file ?? ":memory:");
  const runs: Array<{ input: string; options: Parameters<Run>[1] }> = [];
  const script = { run: options.run };
  const messages = new MessageService(store, { run: async (input, o) => { runs.push({ input, options: o }); return await script.run?.(input, o) ?? { threadId: "t", response: "OK", events: [] }; } });
  const adapter = new TelegramAdapter("123:test", store, messages);
  messages.telegram = adapter;
  if (!store.getTelegramChat("42")) {
    store.linkTelegramChat({ chatId: "42", title: "Den", allowedSenders: ["42"] });
    store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["42", "43", "44"] });
    store.connectTelegramGroup("-100");
    store.setSetting("access.people", JSON.stringify(["43"]));
  }
  cleanups.push(async () => { adapter.stop(); await messages.close(); store.close(); });
  return { store, messages, adapter, runs, script };
}

/** Telegram's side: every call is kept, and each sent message gets its own id. */
function telegram() {
  const calls: Call[] = [];
  let id = 500;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split("/").at(-1)!, body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: ++id } : true });
  }));
  const of = (method: string) => calls.filter(call => call.method === method).map(call => call.body);
  return { calls, of, buttons: (message: any): Array<{ text: string; callback_data?: string; url?: string }> => (message.reply_markup?.inline_keyboard ?? []).flat() };
}

let updateId = 1000;
const text = (from: number, chat: number, words: string, reply?: number): TelegramUpdate => ({ update_id: ++updateId,
  message: { message_id: updateId, from: { id: from, first_name: from === 42 ? "Den" : from === 43 ? "Yulia" : "Guest" }, text: words,
    chat: { id: chat, type: chat > 0 ? "private" : "group", ...chat < 0 ? { title: "Team" } : {} }, ...reply ? { reply_to_message: { message_id: reply, from: { id: 123, is_bot: true } } } : {} } });
const press = (from: number, chat: number, message: number, data: string): TelegramUpdate => ({ update_id: ++updateId,
  callback_query: { id: "q" + updateId, from: { id: from, first_name: from === 42 ? "Den" : from === 43 ? "Yulia" : "Guest" }, data, message: { message_id: message, chat: { id: chat } } } });

/** The assistant raises a card during a turn, as the model would, and ends quietly. */
const raising = (card: Record<string, unknown>, seen?: (result: any) => void): Run => async (_input, o) => {
  const result = await o!.tools!.call("raise_card", card); seen?.(result);
  return { threadId: "t", response: "NO_REPLY", events: [] };
};
const question = { kind: "answer", title: "Corner bakery, 12.40", reason: "The same shop as last week.", choices: ["Salary", "Office"] };

async function served(run?: Run) {
  const { OpenStrudelRuntime } = await import("../src/runtime.js");
  const script = { run };
  const runs: Array<{ input: string; options: Parameters<Run>[1] }> = [];
  const runtime = new OpenStrudelRuntime({ dbPath: ":memory:", startTelegram: false, apiToken: "owner", engine: { run: async (input, o) => { runs.push({ input, options: o }); return await script.run?.(input, o) ?? { threadId: "t", response: "OK", events: [] }; } } });
  cleanups.push(() => runtime.stop());
  await runtime.telegram.configure("123:test");
  runtime.telegram.stop();
  runtime.store.linkTelegramChat({ chatId: "42", title: "Den", allowedSenders: ["42"] });
  runtime.store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["42", "43"] });
  runtime.store.connectTelegramGroup("-100");
  const address = await runtime.api.listen("127.0.0.1", 0);
  const call = (path: string, body?: unknown, headers: Record<string, string> = { authorization: "Bearer owner" }) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers }, ...body === undefined ? {} : { body: JSON.stringify(body) } });
  return { runtime, call, script, runs };
}
/** Telegram's side for a runtime whose own API is reached over the real network. */
function telegramBeside() {
  const calls: Call[] = [], real = globalThis.fetch;
  let id = 500;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    if (!String(url).startsWith("https://api.telegram.org/")) return real(url, init);
    const method = String(url).split("/").at(-1)!, body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    return Response.json({ ok: true, result: method === "getMe" ? { id: 123, is_bot: true, first_name: "Home", username: "home_bot" } : method === "sendMessage" ? { message_id: ++id } : method === "getUpdates" ? [] : true });
  }));
  return { calls, of: (method: string) => calls.filter(call => call.method === method).map(call => call.body) };
}

describe("a card in Telegram", () => {
  async function correspondenceCard(actions: Array<{kind: string; label: string}>, space: "company" | "personal" = "company", draft: string | null = null) {
    const tg = telegram(), h = home(), inbox = h.store.primaryConversation();
    const dm = h.store.getOrCreateConversation({ channel: "telegram", externalId: "42", title: "Den" });
    h.store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id='42'").run(dm.id);
    const { configureCorrespondence, correspondenceSource, Correspondence, correspondenceContext } = await import("../src/correspondence.js");
    const config = { enabled: true, conversationId: inbox.id, calendarId: "owner@example.com", defaultDurationMinutes: 30,
      sources: [{ id: "mail", provider: "gmail", accountId: "owner@example.com", space, token: "a-private-source-token-with-32-characters" }], drafts: { ownerTelegram: "42" } };
    configureCorrespondence(h.store, true, config);
    const writer = new Correspondence(h.store, h.messages);
    cleanups.push(() => writer.stop());
    const source = correspondenceSource(h.store, "mail", "Bearer " + config.sources[0]!.token);
    writer.receive(source, { id: "new", threadId: "incoming", type: "message.new", occurredAt: new Date().toISOString() });
    h.store.db.prepare("UPDATE correspondence_events SET status='running',run_id='test' WHERE event_id='new'").run();
    const msg = h.store.addMessage({ channel: "api", conversationId: inbox.id, direction: "inbound", externalId: "correspondence:test", text: "changed conversation" });
    h.store.setMessageStatus(msg.id, "running");
    const turn = { conversationId: inbox.id, messageId: msg.id, channel: "api" as const, scope: "personal", scheduled: true, profile: null, cards: h.messages.cards };
    await correspondenceContext(h.store, turn, "Agreement", async () => ({evidence: [], searched: [{memory: space === "company" ? "company" : "mik-mcp"}], unreachable: []}));
    const { employeeTools } = await import("../src/personality.js");
    const tools = employeeTools(h.store, {run: async () => ({threadId:"t",response:"",events:[]})}, h.messages.interactions, turn);
    const question = { question: "Which proposal does Anton need?", reason: "Both proposals are current.", draft, actions };
    await tools.call("correspondence_question", question);
    await tools.call("correspondence_question", question);
    expect(tg.of("sendMessage")).toHaveLength(1);
    expect(tg.of("sendMessage")[0].text).not.toMatch(/Sent by an AI assistant|Отправлено AI-помощником/);
    return { tg, h, dm, buttons: tg.buttons(tg.of("sendMessage")[0]), revoke: () => configureCorrespondence(h.store, true, { ...config, drafts: { ownerTelegram: null } }) };
  }

  it("opens the reply composer for a specific missing fact and routes the reply back with its source", async () => {
    const { tg, h, dm, buttons } = await correspondenceCard([{kind:"detail",label:"Name the proposal"}, {kind:"dismiss",label:"Leave unanswered"}]);
    expect(buttons.map(button => button.text)).toEqual(["Name the proposal", "Leave unanswered"]);
    await h.adapter.processUpdate(press(42, 42, 501, buttons[0]!.callback_data!));
    const prompt = tg.of("sendMessage").at(-1);
    expect(prompt.reply_markup).toMatchObject({ force_reply: true, input_field_placeholder: "Name the proposal" });
    expect(prompt.reply_parameters.message_id).toBe(501);
    expect(h.runs).toHaveLength(0);
    await h.adapter.processUpdate(text(42, 42, "The school course", 502));
    expect(h.runs.at(-1)?.options.conversationId).toBe(dm.id);
    expect(h.runs.at(-1)?.input).toContain("The school course");
    expect(h.runs.at(-1)?.input).toContain("separate approval");
    expect(h.runs.at(-1)?.input).toContain('"thread":"incoming"');
  });

  it("shows the saved draft in the card, with the other reply one press away", async () => {
    const { tg, buttons } = await correspondenceCard([{kind:"draft",label:"Draft a decline"}, {kind:"dismiss",label:"Keep this draft"}], "company", "Anton, yes, let us do the workshop on Friday.");
    const card = tg.of("sendMessage")[0];
    expect(card.text).toContain("Anton, yes, let us do the workshop on Friday.");
    expect(card.entities).toContainEqual(expect.objectContaining({ type: "blockquote", length: "Anton, yes, let us do the workshop on Friday.".length }));
    expect(buttons.map(button => button.text)).toEqual(["Draft a decline", "Keep this draft"]);
  });

  it.each([0,1])("carries draft choice %i to the owner as a draft-only instruction", async index => {
    const labels = ["Draft for the workshop", "Draft for the course"];
    const { tg, h, buttons } = await correspondenceCard(labels.map(label => ({kind:"draft",label})));
    expect(buttons.map(button => button.text)).toEqual(labels);
    await h.adapter.processUpdate(press(42, 42, 501, buttons[index]!.callback_data!));
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.input).toContain(labels[index]);
    expect(h.runs[0]!.input).toContain("only a reply draft");
    expect(tg.of("sendMessage").every(message => String(message.chat_id) === "42")).toBe(true);
  });

  it("dismisses only that notice without running an agent, regardless of the button position", async () => {
    const {h,buttons} = await correspondenceCard([{kind:"dismiss",label:"Leave unanswered"}, {kind:"draft",label:"Draft for the course"}]);
    await h.adapter.processUpdate(press(42,42,501,buttons[0]!.callback_data!));
    expect(h.runs).toHaveLength(0);
    expect(h.messages.cards.list().recent[0]?.answer?.label).toBe("Leave unanswered");
  });

  it("reuses the pending detail prompt and respects revoked access on an earlier card", async () => {
    const {tg,h,buttons,revoke} = await correspondenceCard([{kind:"detail",label:"Enter amount"}]);
    await h.adapter.processUpdate(press(42,42,501,buttons[0]!.callback_data!));
    await h.adapter.processUpdate(press(42,42,501,buttons[0]!.callback_data!));
    expect(tg.of("sendMessage")).toHaveLength(2);
    revoke();
    await h.adapter.processUpdate(press(42,42,501,buttons[0]!.callback_data!));
    expect(tg.of("answerCallbackQuery").at(-1)?.show_alert).toBe(true);
    await h.adapter.processUpdate(text(42,42,"€20",502));
    expect(h.runs).toHaveLength(0);
    expect(h.messages.cards.list().recent[0]?.answer?.label).toBe("The conversation has changed.");
  });

  it("labels creation of a checkout explicitly and requires the company lookup before offering it", async () => {
    const choice = [{kind:"payment_link",label:"Yes"}];
    const {buttons} = await correspondenceCard(choice);
    expect(buttons.map(button => button.text)).toEqual(["Create checkout link"]);
    await expect(correspondenceCard(choice, "personal")).rejects.toThrow(/work context/);
  });

  it.each([["Prepare a proposal",false], ["Renew today",false], ["Create payment link",true]])("honors only an explicit checkout label on a legacy c0 (%s)", async (label, approved) => {
    const { h } = await correspondenceCard([{kind:"draft",label:"Draft proposal"}]);
    const card = h.messages.cards.list().open[0]!;
    const legacyChoices = [{id:"c0",label,role:"primary"}, {id:"c1",label:"Skip",role:"plain"}];
    h.store.db.prepare("UPDATE cards SET choices_json=? WHERE id=?").run(JSON.stringify(legacyChoices),card.id);
    await h.adapter.processUpdate(press(42,42,501,"c:" + card.id + ":c0"));
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]!.input.includes("Create a checkout link only if")).toBe(approved);
    if (!approved) expect(h.runs[0]!.input).toContain("no financial action");
  });

  it("is one message with a button per choice, and the quiet turn that raised it sends nothing else", async () => {
    const tg = telegram(), h = home({ run: raising(question) });
    await h.adapter.processUpdate(text(42, 42, "what is new?"));
    const sent = tg.of("sendMessage");
    expect(sent).toHaveLength(1);
    expect(sent[0].chat_id).toBe("42");
    expect(sent[0].text).toContain("Corner bakery, 12.40");
    expect(sent[0].text).toContain("The same shop as last week.");
    expect(tg.buttons(sent[0]).map(b => b.text)).toEqual(["Salary", "Office", "Something else"]);
    expect(tg.buttons(sent[0]).every(b => Buffer.byteLength(b.callback_data!) <= 64)).toBe(true);
  });

  it("renders a source in the reason as a tappable label at its UTF-16 position", async () => {
    const url = "https://mail.google.com/mail/u/?authuser=owner%40example.org#all/123";
    const tg = telegram(), h = home({ run: raising({ ...question, reason: "🧾 Provider quote. [Renewal notice](" + url + ")" }) });
    await h.adapter.processUpdate(text(42, 42, "What's the source?"));
    const [message] = tg.of("sendMessage");
    expect(message.text).toContain("🧾 Provider quote. Renewal notice");
    expect(message.text).not.toContain(url);
    expect(message.entities).toContainEqual({ type: "text_link", offset: message.text.indexOf("Renewal notice"), length: "Renewal notice".length, url });
  });

  it("carries the right person's press to the raiser's chat, and the message says what was decided", async () => {
    const tg = telegram(), h = home({ run: raising(question) });
    await h.adapter.processUpdate(text(42, 42, "what is new?"));
    const card = tg.of("sendMessage")[0], raiser = h.runs[0]!.options!.conversationId;
    h.script.run = async () => ({ threadId: "t", response: "Filed as salary.", events: [] });
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(card)[0]!.callback_data!));
    // The press is answered at once, the card is edited into a record, and its buttons go.
    expect(tg.of("answerCallbackQuery")).toHaveLength(1);
    const edit = tg.of("editMessageText").at(-1);
    expect(edit).toMatchObject({ chat_id: "42", message_id: 501, reply_markup: { inline_keyboard: [] } });
    expect(edit.text).toContain("Corner bakery, 12.40");
    expect(edit.text).toMatch(/Salary · Den/);
    // The answer is the person's own reply in the conversation that asked, and the reply to it comes back under the card.
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1]!.options!.conversationId).toBe(raiser);
    expect(h.runs[1]!.input).toContain("Salary");
    expect(tg.of("sendMessage").at(-1)).toMatchObject({ chat_id: "42", text: "Filed as salary.", reply_parameters: { message_id: 501 } });
    expect(h.messages.cards.list().open).toEqual([]);
    expect(h.messages.cards.list().recent[0]).toMatchObject({ state: "answered", answer: { choice: "c0", label: "Salary", by: "Den", via: "telegram" } });
  });

  it("does nothing when someone else presses, in a group or with the data replayed from another chat", async () => {
    const tg = telegram(), h = home({ run: raising(question) });
    await h.adapter.processUpdate(text(42, -100, "what is new?"));
    const card = tg.of("sendMessage")[0], data = tg.buttons(card)[0]!.callback_data!;
    expect(card.chat_id).toBe("-100");
    // A member without access to this Home, then the right person's data sent from a chat the card was never in.
    await h.adapter.processUpdate(press(44, -100, 501, data));
    await h.adapter.processUpdate(press(42, 42, 501, data));
    await h.adapter.processUpdate(press(42, -100, 777, data));
    expect(h.runs).toHaveLength(1);
    expect(tg.of("editMessageText")).toEqual([]);
    expect(h.messages.cards.list().open).toHaveLength(1);
    expect(tg.of("answerCallbackQuery").every(answer => answer.show_alert === true)).toBe(true);
    // A colleague with access to this Home may answer a card shown in the group.
    await h.adapter.processUpdate(press(43, -100, 501, data));
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { by: "Yulia" } });
  });

  it("takes one answer: a second press changes nothing and starts nothing", async () => {
    const tg = telegram(), h = home({ run: raising(question) });
    await h.adapter.processUpdate(text(42, 42, "what is new?"));
    const buttons = tg.buttons(tg.of("sendMessage")[0]);
    h.script.run = undefined;
    await h.adapter.processUpdate(press(42, 42, 501, buttons[0]!.callback_data!));
    const turns = h.runs.length, edits = tg.of("editMessageText").length, messages = tg.of("sendMessage").length;
    await h.adapter.processUpdate(press(42, 42, 501, buttons[1]!.callback_data!));
    // Telegram can also deliver the same press twice.
    const again = press(42, 42, 501, buttons[1]!.callback_data!);
    await h.adapter.processUpdate(again); await h.adapter.processUpdate(again);
    expect(h.runs).toHaveLength(turns);
    expect(tg.of("sendMessage")).toHaveLength(messages);
    expect(tg.of("editMessageText")).toHaveLength(edits);
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { label: "Salary" } });
    expect(tg.of("answerCallbackQuery").at(-1).text).toContain("Salary");
  });

  it("takes words as the answer: a reply to the card, also when the button for words was pressed first", async () => {
    const tg = telegram(), h = home({ run: raising(question) });
    await h.adapter.processUpdate(text(42, 42, "what is new?"));
    const card = tg.of("sendMessage")[0], raiser = h.runs[0]!.options!.conversationId;
    h.script.run = async () => ({ threadId: "t", response: "Split in two.", events: [] });
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(card)[2]!.callback_data!));
    expect(h.messages.cards.list().open).toHaveLength(1);
    expect(tg.of("answerCallbackQuery").at(-1).text).toMatch(/reply/i);
    await h.adapter.processUpdate(text(42, 42, "half salary, half office", 501));
    expect(h.runs.at(-1)!.options!.conversationId).toBe(raiser);
    expect(h.runs.at(-1)!.input).toContain("half salary, half office");
    expect(tg.of("editMessageText").at(-1).text).toMatch(/half salary, half office · Den/);
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { choice: null, text: "half salary, half office", by: "Den" } });
  });

  it("stays open and is not sent again when the same thing is raised twice", async () => {
    const tg = telegram(), results: any[] = [], h = home({ run: raising(question, result => results.push(result)) });
    await h.adapter.processUpdate(text(42, 42, "what is new?"));
    await h.adapter.processUpdate(text(42, 42, "and now?"));
    expect(tg.of("sendMessage")).toHaveLength(1);
    expect(h.messages.cards.list().open).toHaveLength(1);
    expect(results[1]).toMatchObject({ id: results[0].id, state: "open", alreadyOpen: true });
  });

  it("survives a restart between the raise and the press", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cards-")), file = join(directory, "home.sqlite");
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const tg = telegram(), first = home({ file, run: raising(question) });
    await first.adapter.processUpdate(text(42, 42, "what is new?"));
    const data = tg.buttons(tg.of("sendMessage")[0])[1]!.callback_data!, raiser = first.runs[0]!.options!.conversationId;
    first.adapter.stop(); await first.messages.close(); first.store.close(); cleanups.splice(1);
    const second = home({ file, run: async () => ({ threadId: "t", response: "Filed as office.", events: [] }) });
    await second.adapter.processUpdate(press(42, 42, 501, data));
    expect(second.runs).toHaveLength(1);
    expect(second.runs[0]!.options!.conversationId).toBe(raiser);
    expect(second.runs[0]!.input).toContain("Office");
    expect(tg.of("editMessageText").at(-1).text).toMatch(/Office · Den/);
  });

  it("goes to the named person's own chat, where only that person can answer", async () => {
    const tg = telegram(), h = home();
    h.store.linkTelegramChat({ chatId: "43", title: "Yulia", allowedSenders: ["43"] });
    h.script.run = raising({ ...question, person: "Yulia" });
    await h.adapter.processUpdate(text(42, 42, "ask Yulia"));
    const card = tg.of("sendMessage")[0], data = tg.buttons(card)[0]!.callback_data!;
    expect(card.chat_id).toBe("43");
    expect(h.messages.cards.list().open[0]).toMatchObject({ chat: { id: "43", title: "Yulia" }, for: [{ id: "43", name: "Yulia" }] });
    h.script.run = undefined;
    await h.adapter.processUpdate(press(42, 43, 501, data));
    expect(h.messages.cards.list().open).toHaveLength(1);
    await h.adapter.processUpdate(press(43, 43, 501, data));
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { by: "Yulia" } });
    // Someone unknown to this Home is refused, with the people who can be asked.
    h.script.run = async (_input, o) => { await expect(o!.tools!.call("raise_card", { ...question, title: "Another", person: "Stranger" })).rejects.toThrow(/Den.*Yulia|Yulia.*Den/); return { threadId: "t", response: "NO_REPLY", events: [] }; };
    await h.adapter.processUpdate(text(42, 42, "ask a stranger"));
  });

  it("is refused to a sender without access to this Home", async () => {
    telegram();
    const h = home();
    h.store.db.prepare("UPDATE telegram_chats SET access='members' WHERE chat_id='-100'").run();
    let refused = "", offered = true;
    h.script.run = async (_input, o) => {
      offered = o!.tools!.definitions.some(tool => tool.name === "raise_card");
      refused = await o!.tools!.call("raise_card", question).then(() => "", error => String(error.message));
      return { threadId: "t", response: "NO_REPLY", events: [] };
    };
    await h.adapter.processUpdate(text(44, -100, "ask everyone something"));
    expect(offered).toBe(false);
    expect(refused).not.toBe("");
    expect(h.messages.cards.list().open).toEqual([]);
    // The tool itself refuses too, whatever offered it.
    await expect(h.messages.cards.raise(question, { conversationId: h.store.getTelegramChat("-100")!.conversationId!, messageId: "m", channel: "telegram", profile: null, access: false, sendable: () => true })).rejects.toThrow(/access/i);
  });
});

describe("a send card", () => {
  const draft = { kind: "send", title: "Send to the team?", reason: "You asked for a note about Friday.", to: "Team", via: "Telegram", text: "Friday we close at *15:00*.\n_No calls after 14._", chatId: "-100" };

  it("shows who receives it, through what, and the whole text exactly", async () => {
    const tg = telegram(), h = home({ run: raising(draft) });
    await h.adapter.processUpdate(text(42, 42, "draft a note for the team"));
    const card = tg.of("sendMessage")[0];
    expect(card.chat_id).toBe("42");
    expect(card.text).toContain("Team · Telegram");
    // The text is shown as written: its asterisks and underscores are not read as formatting.
    expect(card.text).toContain(draft.text);
    expect(tg.buttons(card).map(b => b.text)).toEqual(["Send", "Keep as draft"]);
    expect(h.messages.cards.list().open[0]).toMatchObject({ kind: "send", content: { to: "Team", via: "Telegram", text: draft.text },
      choices: [{ id: "send", label: "Send", role: "primary" }, { id: "draft", label: "Keep as draft", role: "plain" }] });
  });

  it("sends exactly that text to exactly that chat on one press, with no model turn, and never twice", async () => {
    const tg = telegram(), h = home({ run: raising(draft) });
    await h.adapter.processUpdate(text(42, 42, "draft a note for the team"));
    const data = tg.buttons(tg.of("sendMessage")[0])[0]!.callback_data!;
    await h.adapter.processUpdate(press(42, 42, 501, data));
    await h.adapter.processUpdate(press(42, 42, 501, data));
    expect(h.runs).toHaveLength(1);
    const out = tg.of("sendMessage").filter(message => message.chat_id === "-100");
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(draft.text);
    expect(out[0].entities ?? []).toEqual([]);
    expect(tg.of("editMessageText").at(-1).text).toMatch(/Sent to Team · Den/);
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { choice: "send", outcome: "Sent to Team" } });
  });

  it("sends nothing when it is kept as a draft", async () => {
    const tg = telegram(), h = home({ run: raising(draft) });
    await h.adapter.processUpdate(text(42, 42, "draft a note for the team"));
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(tg.of("sendMessage")[0])[1]!.callback_data!));
    expect(tg.of("sendMessage").filter(message => message.chat_id === "-100")).toEqual([]);
    expect(h.runs).toHaveLength(1);
    expect(tg.of("editMessageText").at(-1).text).toMatch(/Keep as draft · Den/);
  });

  it("is refused for a chat the raiser could not send to itself", async () => {
    telegram();
    const h = home();
    h.store.linkTelegramChat({ chatId: "-200", title: "Clients", allowedSenders: ["42"] });
    h.store.connectTelegramGroup("-200");
    let refused = "";
    // A colleague's turn in the group reaches only that group.
    h.script.run = async (_input, o) => { refused = await o!.tools!.call("raise_card", { ...draft, chatId: "-200" }).then(() => "", error => String(error.message)); return { threadId: "t", response: "NO_REPLY", events: [] }; };
    await h.adapter.processUpdate(text(43, -100, "send it to the clients"));
    expect(refused).not.toBe("");
    expect(h.messages.cards.list().open).toEqual([]);
  });

  it("through another service asks the raiser to send exactly the shown text, and lets that one call through unasked", async () => {
    const tg = telegram(), mail = { kind: "send", title: "Send the reply to the office?", to: "office@example.com", via: "Mail", subject: "Re: Friday", text: "We close at 15:00." };
    const h = home({ run: raising(mail) });
    await h.adapter.processUpdate(text(42, 42, "draft the reply"));
    const calls: string[] = [];
    h.script.run = async (input, o) => {
      calls.push(input);
      const approval = await o!.onRequest!("mcpServer/elicitation/request", { mode: "form", serverName: "mail", message: 'Allow the mail MCP server to run tool "send_letter"?',
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { to: "office@example.com", subject: "Re: Friday", body: "We close at 15:00." } }, requestedSchema: { type: "object", properties: {} } }) as { action: string };
      return { threadId: "t", response: approval.action === "accept" ? "Sent." : "Not sent.", events: [] };
    };
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(tg.of("sendMessage")[0])[0]!.callback_data!));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("We close at 15:00.");
    expect(calls[0]).toContain("office@example.com");
    // The press was the approval: no second card, no second question.
    expect(tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length)).toHaveLength(1);
    expect(tg.of("sendMessage").at(-1)).toMatchObject({ text: "Sent.", reply_parameters: { message_id: 501 } });
  });

  it("through another service does not let other words through on the strength of the press", async () => {
    const tg = telegram(), h = home({ run: raising({ kind: "send", title: "Send the reply to the office?", to: "office@example.com", via: "Mail", text: "We close at 15:00." }) });
    await h.adapter.processUpdate(text(42, 42, "draft the reply"));
    let asked: Promise<unknown> | undefined;
    h.script.run = async (_input, o) => {
      asked = o!.onRequest!("mcpServer/elicitation/request", { mode: "form", serverName: "mail", message: 'Allow the mail MCP server to run tool "send_letter"?',
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { to: "office@example.com", body: "We close at 15:00. Also, wire the money today." } }, requestedSchema: { type: "object", properties: {} } });
      void asked.catch(() => undefined);
      await vi.waitFor(() => expect(tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length)).toHaveLength(2));
      return { threadId: "t", response: "Waiting.", events: [] };
    };
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(tg.of("sendMessage")[0])[0]!.callback_data!));
    // The changed text is a new card for the person to read, not an approved send.
    expect(tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length).at(-1).text).toContain("Also, wire the money today.");
  });
});

describe("a connector's own approval to send", () => {
  const letter = { to: "office@example.com", subject: "Report for the week", body: "Dear all,\nthe report is attached.", priority: "high" };
  const asking = (done: () => void): Run => async (_input, o) => {
    const approval = await o!.onRequest!("mcpServer/elicitation/request", { mode: "form", serverName: "mail", message: 'Allow the mail MCP server to run tool "send_letter"?',
      _meta: { codex_approval_kind: "mcp_tool_call", tool_params: letter }, requestedSchema: { type: "object", properties: {} } }) as { action: string };
    if (approval.action === "accept") done();
    return { threadId: "t", response: approval.action === "accept" ? "Sent." : "Not sent.", events: [] };
  };

  it("reads as a plain send card: recipient, subject and the whole text, with nothing hidden", async () => {
    const tg = telegram(), sent = vi.fn(), h = home({ run: asking(sent) });
    const turn = h.adapter.processUpdate(text(42, 42, "send the weekly report"));
    await vi.waitFor(() => expect(tg.of("sendMessage").some(message => message.reply_markup)).toBe(true));
    const card = tg.of("sendMessage").find(message => message.reply_markup)!;
    expect(tg.of("sendMessage").filter(message => message.reply_markup)).toHaveLength(1);
    expect(card.text).toContain("office@example.com · mail");
    expect(card.text).toContain("Report for the week");
    expect(card.text).toContain("Dear all,\nthe report is attached.");
    expect(card.text).toContain("high");
    expect(card.text).not.toMatch(/send_letter|"body"|\{/);
    expect(tg.buttons(card).map(b => b.text)).toEqual(["Send", "Don't send"]);
    expect(sent).not.toHaveBeenCalled();
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(card)[0]!.callback_data!));
    await turn;
    expect(sent).toHaveBeenCalledTimes(1);
    expect(tg.of("editMessageText").at(-1).text).toMatch(/Send · Den/);
  });

  it("in a group is for the person who gave the instruction, not for a colleague with access", async () => {
    const tg = telegram(), sent = vi.fn(), h = home({ run: asking(sent) });
    const turn = h.adapter.processUpdate(text(42, -100, "send the weekly report"));
    await vi.waitFor(() => expect(tg.of("sendMessage").some(message => message.reply_markup)).toBe(true));
    const card = tg.of("sendMessage").find(message => message.reply_markup)!;
    expect(card.chat_id).toBe("-100");
    await h.adapter.processUpdate(press(43, -100, 501, tg.buttons(card)[0]!.callback_data!));
    expect(sent).not.toHaveBeenCalled();
    expect(tg.of("answerCallbackQuery").at(-1)).toMatchObject({ show_alert: true, text: expect.stringContaining("Den") });
    await h.adapter.processUpdate(press(42, -100, 501, tg.buttons(card)[0]!.callback_data!));
    await turn;
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("refuses the action on Don't send", async () => {
    const tg = telegram(), sent = vi.fn(), h = home({ run: asking(sent) });
    const turn = h.adapter.processUpdate(text(42, 42, "send the weekly report"));
    await vi.waitFor(() => expect(tg.of("sendMessage").some(message => message.reply_markup)).toBe(true));
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(tg.of("sendMessage").find(message => message.reply_markup)!)[1]!.callback_data!));
    await turn;
    expect(sent).not.toHaveBeenCalled();
    expect(tg.of("sendMessage").at(-1).text).toBe("Not sent.");
  });

  it("refreshes itself on a press after the wait ran out: one press, no second question", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const tg = telegram(), sent = vi.fn(), h = home({ run: asking(sent) });
    const turn = h.adapter.processUpdate(text(42, 42, "send the weekly report")).catch(() => undefined);
    await vi.waitFor(() => expect(tg.of("sendMessage").some(message => message.reply_markup)).toBe(true));
    const card = tg.of("sendMessage").find(message => message.reply_markup)!;
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await turn;
    expect(sent).not.toHaveBeenCalled();
    // The card kept its buttons and still waits.
    expect(h.messages.cards.list().open).toHaveLength(1);
    const before = tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length).length;
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(card)[0]!.callback_data!));
    expect(sent).toHaveBeenCalledTimes(1);
    expect(tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length)).toHaveLength(before);
    expect(h.runs.at(-1)!.input).toContain("send_letter");
    expect(h.messages.cards.list().open).toEqual([]);
  });

  it("does not let a different text through on the strength of an earlier press", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const tg = telegram(), sent = vi.fn(), h = home({ run: asking(sent) });
    const turn = h.adapter.processUpdate(text(42, 42, "send the weekly report")).catch(() => undefined);
    await vi.waitFor(() => expect(tg.of("sendMessage").some(message => message.reply_markup)).toBe(true));
    const card = tg.of("sendMessage").find(message => message.reply_markup)!;
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    await turn;
    // After the press the assistant tries to send other words: that is a new card, not an approved action.
    let asked: Promise<unknown> | undefined;
    h.script.run = async (_input, o) => {
      asked = o!.onRequest!("mcpServer/elicitation/request", { mode: "form", serverName: "mail", message: 'Allow the mail MCP server to run tool "send_letter"?',
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { ...letter, body: "Something else entirely." } }, requestedSchema: { type: "object", properties: {} } });
      void asked.catch(() => undefined);
      await vi.waitFor(() => expect(tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length)).toHaveLength(2));
      return { threadId: "t", response: "Waiting.", events: [] };
    };
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(card)[0]!.callback_data!));
    expect(tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length).at(-1).text).toContain("Something else entirely.");
    expect(sent).not.toHaveBeenCalled();
  });
});

describe("the same answer twice", () => {
  const about = (amount: string) => ({ kind: "answer", title: `Corner bakery, ${amount}`, about: "Corner bakery", choices: ["Salary", "Office"] });
  /** One round: the assistant asks about the bakery in `chat`, and `from` presses the button that reads `label`. Returns the card as sent. */
  async function round(h: ReturnType<typeof home>, tg: ReturnType<typeof telegram>, amount: string, label: string | null, chat = 42, from = 42) {
    h.script.run = raising(about(amount));
    await h.adapter.processUpdate(text(42, chat, "anything new?"));
    const card = tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length).at(-1), id = 501 + tg.of("sendMessage").indexOf(card);
    h.script.run = async () => ({ threadId: "t", response: "NO_REPLY", events: [] });
    if (label) await h.adapter.processUpdate(press(from, chat, id, tg.buttons(card).find(button => button.text === label)!.callback_data!));
    return { card, id };
  }

  it("offers always, and one press saves a rule that every later turn reads", async () => {
    const { homeRules } = await import("../src/home-management.js");
    const tg = telegram(), h = home();
    expect(tg.buttons((await round(h, tg, "12.40", "Salary")).card).map(b => b.text)).toEqual(["Salary", "Office", "Something else"]);
    expect(tg.buttons((await round(h, tg, "9.10", "Salary")).card).map(b => b.text)).toEqual(["Salary", "Office", "Something else"]);
    const third = await round(h, tg, "7.00", null);
    expect(tg.buttons(third.card).map(b => b.text)).toEqual(["Salary", "Office", "Salary, always", "Something else"]);
    expect(h.messages.cards.list().open[0]).toMatchObject({ content: { about: "Corner bakery" }, choices: expect.arrayContaining([{ id: "always", label: "Salary, always", role: "plain", repeats: "c0", times: 2 }]) });
    expect(homeRules(h.store)).toEqual([]);
    h.script.run = async () => ({ threadId: "t", response: "Filed, and I will not ask again.", events: [] });
    await h.adapter.processUpdate(press(42, 42, third.id, tg.buttons(third.card)[2]!.callback_data!));
    const rules = homeRules(h.store);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.text).toMatch(/Corner bakery.*always.*Salary/);
    expect(rules[0]!.text).not.toMatch(/7\.00|12\.40/);
    expect(tg.of("editMessageText").at(-1).text).toMatch(/Salary, always\. Saved as a rule · Den/);
    // The raiser hears the answer and the rule now, and every later turn carries the rule after its SOUL.
    expect(h.runs.at(-1)!.input).toContain(rules[0]!.text);
    expect(h.runs.at(-1)!.options!.profile).toContain(rules[0]!.text);
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { choice: "always", by: "Den" }, content: { rule: rules[0]!.text } });
    // The streak goes on through an "always": a later card about it still offers the same.
    expect(tg.buttons((await round(h, tg, "3.30", null)).card).map(b => b.text)).toContain("Salary, always");
  });

  it("is not offered after one answer, different answers, words, or about another thing", async () => {
    const tg = telegram(), h = home();
    await round(h, tg, "12.40", "Salary");
    await round(h, tg, "9.10", "Office");
    expect(tg.buttons((await round(h, tg, "7.00", "Office")).card).map(b => b.text)).toEqual(["Salary", "Office", "Something else"]);
    // Two in a row now: offered for the bakery. Another thing has its own count, and a card that names nothing never offers it.
    const offered = await round(h, tg, "5.50", null);
    expect(tg.buttons(offered.card).map(b => b.text)).toContain("Office, always");
    for (const other of [{ title: "Flower shop, 20.00", about: "Flower shop" }, { title: "Which account?" }]) {
      h.script.run = raising({ kind: "answer", choices: ["Salary", "Office"], ...other });
      await h.adapter.processUpdate(text(42, 42, "anything new?"));
      expect(tg.buttons(tg.of("sendMessage").filter(message => message.reply_markup?.inline_keyboard?.length).at(-1)).map(b => b.text)).toEqual(["Salary", "Office", "Something else"]);
    }
    // Words break the streak.
    await h.adapter.processUpdate(text(42, 42, "split it this time", offered.id));
    expect(tg.buttons((await round(h, tg, "4.40", null)).card).map(b => b.text)).toEqual(["Salary", "Office", "Something else"]);
  });

  it("becomes a rule only on an administrator's press", async () => {
    const { homeRules } = await import("../src/home-management.js");
    const tg = telegram(), h = home();
    await round(h, tg, "12.40", "Salary", -100);
    await round(h, tg, "9.10", "Salary", -100);
    const third = await round(h, tg, "7.00", null, -100);
    const always = tg.buttons(third.card).find(button => button.text === "Salary, always")!.callback_data!;
    // A colleague with access may answer, but a rule for the whole Home is its administrators' to give.
    await h.adapter.processUpdate(press(43, -100, third.id, always));
    expect(homeRules(h.store)).toEqual([]);
    expect(h.messages.cards.list().open).toHaveLength(1);
    expect(tg.of("answerCallbackQuery").at(-1)).toMatchObject({ show_alert: true });
    h.store.setSetting("access.managers", JSON.stringify(["43"]));
    await h.adapter.processUpdate(press(43, -100, third.id, always));
    expect(homeRules(h.store)).toHaveLength(1);
    expect(h.messages.cards.list().open).toEqual([]);
  });
});

describe("the other kinds", () => {
  it("closes a due card on Done with no model turn, and tells its raiser on the next turn", async () => {
    const tg = telegram(), h = home({ run: raising({ kind: "due", title: "Call the venue about Friday", reason: "Promised on the 3 November call.", due: "2026-11-12" }) });
    await h.adapter.processUpdate(text(42, 42, "what is due?"));
    const card = tg.of("sendMessage")[0];
    expect(card.text).toContain("12 November");
    expect(tg.buttons(card).map(b => b.text)).toEqual(["Done", "New date"]);
    h.script.run = undefined;
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(card)[0]!.callback_data!));
    expect(h.runs).toHaveLength(1);
    expect(tg.of("editMessageText").at(-1).text).toMatch(/Done · Den/);
    await h.adapter.processUpdate(text(42, 42, "anything else?"));
    expect(h.runs[1]!.input).toMatch(/Call the venue about Friday[\s\S]*Done/);
    // Told once.
    await h.adapter.processUpdate(text(42, 42, "and now?"));
    expect(h.runs[2]!.input).not.toContain("Call the venue about Friday");
  });

  it("takes a new date for a due card in words", async () => {
    const tg = telegram(), h = home({ run: raising({ kind: "due", title: "Call the venue about Friday", due: "2026-11-12" }) });
    await h.adapter.processUpdate(text(42, 42, "what is due?"));
    h.script.run = async () => ({ threadId: "t", response: "Moved to the 20th.", events: [] });
    await h.adapter.processUpdate(text(42, 42, "20 November", 501));
    expect(h.runs.at(-1)!.input).toContain("20 November");
    expect(h.messages.cards.list().recent[0]).toMatchObject({ kind: "due", answer: { text: "20 November" } });
  });

  it("gives a connect card a link that opens the access, and carries on when it is done", async () => {
    const tg = telegram(), h = home({ run: raising({ kind: "connect", title: "Mail is not connected", reason: "The report needs the school's mailbox.", url: "https://example.com/connect" }) });
    await h.adapter.processUpdate(text(42, 42, "send the report"));
    const buttons = tg.buttons(tg.of("sendMessage")[0]);
    expect(buttons).toEqual([{ text: "Open", url: "https://example.com/connect" }, expect.objectContaining({ text: "Done" })]);
    h.script.run = async () => ({ threadId: "t", response: "Connected. Sending the report.", events: [] });
    await h.adapter.processUpdate(press(42, 42, 501, buttons[1]!.callback_data!));
    expect(h.runs).toHaveLength(2);
    expect(tg.of("sendMessage").at(-1).text).toBe("Connected. Sending the report.");
  });

  it("refuses a link that is not https", async () => {
    telegram();
    const h = home();
    let refused = "";
    h.script.run = async (_input, o) => { refused = await o!.tools!.call("raise_card", { kind: "connect", title: "Open it", url: "javascript:alert(1)" }).then(() => "", error => String(error.message)); return { threadId: "t", response: "NO_REPLY", events: [] }; };
    await h.adapter.processUpdate(text(42, 42, "connect"));
    expect(refused).not.toBe("");
  });

  it("lets the raiser close its own card when the thing is done elsewhere, and only its own", async () => {
    const tg = telegram(), h = home({ run: raising({ kind: "due", title: "Call the venue about Friday", due: "2026-11-12" }) });
    await h.adapter.processUpdate(text(42, 42, "what is due?"));
    const card = tg.of("sendMessage")[0], id = h.messages.cards.list().open[0]!.id;
    // A turn in another chat cannot close it, even for a colleague with access.
    let refused = "";
    h.script.run = async (_input, o) => { refused = await o!.tools!.call("close_card", { id, reason: "Done" }).then(() => "", error => String(error.message)); return { threadId: "t", response: "NO_REPLY", events: [] }; };
    await h.adapter.processUpdate(text(43, -100, "close that card"));
    expect(refused).not.toBe("");
    expect(h.messages.cards.list().open).toHaveLength(1);
    let listed = "";
    h.script.run = async (input, o) => {
      listed = input;
      await o!.tools!.call("close_card", { id, reason: "The venue called back on the 11th" });
      return { threadId: "t", response: "Closed it.", events: [] };
    };
    await h.adapter.processUpdate(text(42, 42, "they called already"));
    expect(listed).toContain(`[${id}]`);
    expect(h.messages.cards.list().open).toEqual([]);
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { choice: null, label: "The venue called back on the 11th", by: "OpenStrudel", via: "raiser" } });
    expect(tg.of("editMessageText").at(-1)).toMatchObject({ message_id: 501, reply_markup: { inline_keyboard: [] } });
    expect(tg.of("editMessageText").at(-1).text).toMatch(/The venue called back on the 11th · OpenStrudel/);
    // Its buttons are dead now, and the raiser is not told about its own closing.
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(card)[0]!.callback_data!));
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { via: "raiser" } });
    h.script.run = undefined;
    await h.adapter.processUpdate(text(42, 42, "anything else?"));
    expect(h.runs.at(-1)!.input).not.toContain("Call the venue about Friday");
  });

  it("says a promised message did not come, and closes on one press", async () => {
    const tg = telegram(), h = home({ run: raising({ kind: "failed", title: "The morning brief did not come", reason: "The mailbox did not answer.", nextTry: "2026-11-12T07:00:00Z" }) });
    await h.adapter.processUpdate(text(42, 42, "where is the brief?"));
    const card = tg.of("sendMessage")[0];
    expect(tg.buttons(card).map(b => b.text)).toEqual(["Got it"]);
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(card)[0]!.callback_data!));
    expect(h.runs).toHaveLength(1);
    expect(h.messages.cards.list().open).toEqual([]);
  });

  it("lets go what can no longer be decided: a newer card about the same thing, then three days without an answer", async () => {
    const tg = telegram(), h = home({ run: raising({ ...question, about: "Corner bakery" }) });
    await h.adapter.processUpdate(text(42, 42, "what was that?"));
    // A promise waits until a day past its date, whatever its age.
    h.script.run = raising({ kind: "due", title: "Call the venue about Friday", due: "2026-12-20" });
    await h.adapter.processUpdate(text(42, 42, "what is due?"));
    // A newer question about the same thing takes the older one's place, here and in Telegram.
    h.script.run = raising({ ...question, title: "Corner bakery again, 8.10", about: "corner bakery" });
    await h.adapter.processUpdate(text(42, 42, "and this one?"));
    expect(h.messages.cards.list().open).toHaveLength(3);
    expect(await h.messages.cards.sweep()).toBe(1);
    expect(h.messages.cards.list().open.map(card => card.title).sort()).toEqual(["Call the venue about Friday", "Corner bakery again, 8.10"]);
    expect(tg.of("editMessageText").at(-1)).toMatchObject({ message_id: 501, reply_markup: { inline_keyboard: [] } });
    expect(tg.of("editMessageText").at(-1).text).toMatch(/A newer card asks about this · OpenStrudel/);
    // Three days on, the question has passed; the promise still waits for its day, and then it passes too.
    expect(await h.messages.cards.sweep(new Date(Date.now() + 4 * 86_400_000))).toBe(1);
    expect(h.messages.cards.list().open.map(card => card.kind)).toEqual(["due"]);
    expect(tg.of("editMessageText").at(-1).text).toMatch(/No answer in three days/);
    expect(await h.messages.cards.sweep(new Date("2026-12-22T00:30:00Z"))).toBe(1);
    expect(h.messages.cards.list().open).toEqual([]);
    // Its raiser is not told about what lapsed.
    h.script.run = undefined;
    await h.adapter.processUpdate(text(42, 42, "anything else?"));
    expect(h.runs.at(-1)!.input).not.toContain("Corner bakery");
  });

  it("lets a schedule's failure go while the model sign-in card says why, and keeps that card while it is true", async () => {
    const tg = telegram(), h = home();
    const { Scheduler } = await import("../src/scheduler.js");
    new Scheduler(h.store, h.messages);
    const chat = h.store.getOrCreateConversation({ channel: "telegram", externalId: "42", title: "Den" });
    h.store.db.prepare("INSERT INTO schedules(id,conversation_id,name,prompt,cron,timezone,enabled,next_run_at) VALUES('s1',?,'Morning','Brief','0 7 * * *','UTC',1,'2026-12-01T07:00:00.000Z')").run(chat.id);
    h.store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,error) VALUES('r1','s1',?,'2026-11-25T07:00:00.000Z','failed','2026-11-25T07:00:00.000Z',?)")
      .run(chat.id, "Войдите в OpenAI на устройстве сотрудника: OpenStrudel → Настройки → Аккаунты.");
    await h.messages.cards.failed({ key: "s1", conversationId: chat.id, chatId: "42", title: "Не получилось подготовить «Morning»", reason: "Модель сейчас недоступна.", nextTry: null });
    // Alone it is true, and it stays however long it waits.
    expect(await h.messages.cards.sweep(new Date(Date.now() + 10 * 86_400_000))).toBe(0);
    await h.messages.cards.failed({ key: "account:sign_in", conversationId: chat.id, chatId: "42", title: "Нужен вход в аккаунт модели", reason: "Не работают: Morning.", nextTry: null, code: "sign_in" });
    expect(await h.messages.cards.sweep()).toBe(1);
    expect(h.messages.cards.list().open.map(card => card.title)).toEqual(["Нужен вход в аккаунт модели"]);
    expect(tg.of("editMessageText").at(-1).text).toMatch(/Причина — вход в аккаунт модели/);
    expect(await h.messages.cards.sweep(new Date(Date.now() + 10 * 86_400_000))).toBe(0);
  });

  it("speaks the card's own language on its fixed buttons", async () => {
    const tg = telegram(), h = home({ run: raising({ kind: "due", title: "Позвонить на площадку", due: "2026-11-12" }) });
    await h.adapter.processUpdate(text(42, 42, "что на сегодня?"));
    expect(tg.buttons(tg.of("sendMessage")[0]).map(b => b.text)).toEqual(["Готово", "Новая дата"]);
    expect(tg.of("sendMessage")[0].text).toContain("12 ноября");
  });
});

describe("where a card goes and who it reaches", { timeout: 30_000 }, () => {
  it("from a scheduled report in someone else's group, takes the press back to the employee who raised it", async () => {
    const tg = telegram(), h = home();
    const sales = h.store.createProfile({ name: "Sales" }), own = h.store.profileConversation(sales.id);
    h.script.run = raising({ kind: "answer", title: "Go to the trade fair?", reason: "Entries close on Friday.", choices: ["Yes", "No"] });
    await h.messages.handle({ channel: "api", conversationId: own.id, text: "Scheduled request: fairs", externalId: "schedule:run-1", scheduled: true, scheduleTelegramChatId: "-100" });
    const card = tg.of("sendMessage")[0];
    expect(card.chat_id).toBe("-100");
    expect(card.text).toContain("Sales · Go to the trade fair?");
    h.script.run = async () => ({ threadId: "t", response: "Noted: we go.", events: [] });
    await h.adapter.processUpdate(press(43, -100, 501, tg.buttons(card)[0]!.callback_data!));
    // The group belongs to the main assistant; the answer still reaches the employee's own conversation, as the person who pressed.
    expect(h.runs.at(-1)!.options).toMatchObject({ conversationId: own.id, byOwner: false, access: true });
    expect(h.runs.at(-1)!.input).toContain("Yes");
    expect(tg.of("sendMessage").at(-1)).toMatchObject({ chat_id: "-100", text: "Noted: we go.", reply_parameters: { message_id: 501 } });
    expect(h.messages.cards.list().recent[0]).toMatchObject({ raiser: { profileId: sales.id, name: "Sales" }, chat: { id: "-100", title: "Team" }, for: null });
  });

  it("is recorded in the conversation of the chat it was shown in, with what was decided, so that chat's assistant knows", async () => {
    const tg = telegram(), h = home();
    const sales = h.store.createProfile({ name: "Sales" }), own = h.store.profileConversation(sales.id), team = h.store.getTelegramChat("-100")!.conversationId!;
    h.store.addMessage({ conversationId: team, channel: "telegram", direction: "inbound", author: "Yulia", text: "TEAM_ONLY_TALK" });
    h.script.run = raising({ kind: "answer", title: "Go to the trade fair?", reason: "Entries close on Friday.", choices: ["Yes", "No"] });
    await h.messages.handle({ channel: "api", conversationId: own.id, text: "Scheduled request: fairs", externalId: "schedule:run-1", scheduled: true, scheduleTelegramChatId: "-100" });
    const card = tg.of("sendMessage")[0];
    // The group's own conversation holds the card as it appeared there, from the employee who raised it.
    expect(h.store.listMessages(team).map(m => [m.direction, m.author, m.text])).toEqual([["inbound", "Yulia", "TEAM_ONLY_TALK"], ["outbound", "Sales", card.text]]);
    h.script.run = async () => ({ threadId: "t", response: "Noted: we go.", events: [] });
    await h.adapter.processUpdate(press(43, -100, 501, tg.buttons(card)[0]!.callback_data!));
    expect(h.store.listMessages(team).at(-1)).toMatchObject({ direction: "outbound", author: "Sales", text: expect.stringMatching(/Go to the trade fair\?.*Yes · Yulia/) });
    // A plain message in the group, not a reply, reaches the group's assistant with the card and its answer in view.
    h.script.run = async () => ({ threadId: "t", response: "We decided to go.", events: [] });
    await h.adapter.processUpdate(text(43, -100, "what did we decide about the fair?"));
    expect(h.runs.at(-1)!.options!.conversationId).toBe(team);
    expect(h.runs.at(-1)!.input).toMatch(/Go to the trade fair\?[\s\S]*Yes · Yulia/);
    // The employee that raised it never read the group's talk, and a card in its own chat is not recorded twice.
    expect(h.runs[0]!.input).not.toContain("TEAM_ONLY_TALK");
    h.script.run = raising(question);
    await h.adapter.processUpdate(text(42, 42, "what is new?"));
    expect(h.store.listMessages(h.store.getTelegramChat("42")!.conversationId!).filter(m => m.externalId?.startsWith("notification:card:"))).toEqual([]);
  });

  it("raised in the app's main chat for a named person, brings that person's press back to the main chat", async () => {
    const tg = telegram(), h = home();
    const main = h.store.primaryConversation();
    // His private chat with the bot has a conversation of its own; the card's answer must not land there.
    await h.adapter.processUpdate(text(42, 42, "hello"));
    h.script.run = raising({ ...question, person: "Den" });
    await h.messages.handle({ channel: "api", text: "ask me on Telegram", externalChatId: "home", byOwner: true });
    const card = tg.of("sendMessage").find(message => message.reply_markup)!;
    expect(card.chat_id).toBe("42");
    h.script.run = async () => ({ threadId: "t", response: "Filed.", events: [] });
    await h.adapter.processUpdate(press(42, 42, 502, tg.buttons(card)[0]!.callback_data!));
    expect(h.runs.at(-1)!.options).toMatchObject({ conversationId: main.id, byOwner: true });
    expect(tg.of("sendMessage").at(-1)).toMatchObject({ chat_id: "42", text: "Filed." });
  });

  it("keeps the first answer when words arrive after a press", async () => {
    const tg = telegram(), h = home({ run: raising(question) });
    await h.adapter.processUpdate(text(42, 42, "what is new?"));
    const waiting = h.messages.cards.waiting("42", 501, 42)!;
    h.script.run = undefined;
    await h.adapter.processUpdate(press(42, 42, 501, tg.buttons(tg.of("sendMessage")[0])[1]!.callback_data!));
    // A voice note was still being heard when the button was pressed: its words are an ordinary message now.
    expect(h.messages.cards.words(waiting.id, "half and half", { via: "telegram", userId: "42", name: "Den" })).toBeNull();
    expect(h.messages.cards.waiting("42", 501, 42)).toBeNull();
    expect(h.messages.cards.list().recent[0]).toMatchObject({ answer: { choice: "c1", label: "Office", text: null } });
  });

  it("shows a scheduled report first and the card it raised after it", async () => {
    const tg = telegramBeside(), h = await served(async (_input, o) => {
      await o!.tools!.call("raise_card", { kind: "answer", title: "Which idea to write up?", choices: ["1", "2"] });
      return { threadId: "t", response: "1. The first idea.\n\n2. The second idea.", events: [] };
    });
    const own = h.runtime.store.primaryConversation(), saved = new Date("2030-01-15T05:00:00Z");
    h.runtime.scheduler.save({ conversationId: own.id, name: "Ideas", prompt: "Two ideas", cron: "0 6 * * *", timezone: "UTC", delivery: "telegram", telegramChatId: "-100" }, saved);
    await h.runtime.scheduler.tick(new Date("2030-01-15T06:00:30Z")); await h.runtime.scheduler.idle();
    const sent = tg.of("sendMessage").filter(message => message.chat_id === "-100");
    expect(sent.map(message => Boolean(message.reply_markup?.inline_keyboard?.length))).toEqual([false, true]);
    expect(sent[0].text).toContain("The first idea.");
    expect(sent[1].text).toContain("Which idea to write up?");
    // A quiet run has no report to wait for: its card is shown when the run ends.
    h.script.run = raising({ kind: "answer", title: "Go to the fair?", choices: ["Yes", "No"] });
    await h.runtime.scheduler.tick(new Date("2030-01-16T06:00:30Z")); await h.runtime.scheduler.idle();
    expect(tg.of("sendMessage").filter(message => message.chat_id === "-100").at(-1).text).toContain("Go to the fair?");
    expect(h.runtime.messages.cards.list().open.map(card => card.chat?.id)).toEqual(["-100", "-100"]);
  });

  it("says a scheduled message did not come as one card, refreshed while it keeps failing and closed when the schedule delivers again", async () => {
    const tg = telegramBeside();
    let answer = "FAILED: the source did not answer";
    const h = await served(async () => ({ threadId: "t", response: answer, events: [] }));
    const own = h.runtime.store.primaryConversation();
    h.runtime.scheduler.save({ conversationId: own.id, name: "Ideas", prompt: "Two ideas", cron: "0 6 * * *", timezone: "UTC", delivery: "telegram", telegramChatId: "-100" }, new Date("2030-01-15T05:00:00Z"));
    const run = async (at: string) => { await h.runtime.scheduler.tick(new Date(at)); await h.runtime.scheduler.idle(); };
    const toGroup = () => tg.of("sendMessage").filter(message => message.chat_id === "-100");
    await run("2030-01-15T06:00:30Z");
    // One message in the chat the report was meant for: a card with its one button, in the Home's own words, never the run's reason.
    expect(toGroup()).toHaveLength(1);
    expect(toGroup()[0].text).toContain("Не получилось подготовить «Ideas»");
    expect(toGroup()[0].text).not.toContain("the source did not answer");
    expect(toGroup()[0].reply_markup.inline_keyboard.flat().map((button: any) => button.text)).toEqual(["Понятно"]);
    const first = (await (await h.call("/v1/cards")).json()).open;
    expect(first).toEqual([expect.objectContaining({ kind: "failed", title: "Не получилось подготовить «Ideas»", chat: { id: "-100", title: "Team" }, content: { nextTry: "2030-01-16T06:00:00.000Z" } })]);
    // The next day it fails again: the same card, told once, now with the next try; no second message.
    await run("2030-01-16T06:00:30Z");
    expect(toGroup()).toHaveLength(1);
    expect((await (await h.call("/v1/cards")).json()).open).toEqual([expect.objectContaining({ id: first[0].id, content: { nextTry: "2030-01-17T06:00:00.000Z" } })]);
    expect(tg.of("editMessageText").at(-1)).toMatchObject({ chat_id: "-100", message_id: 501 });
    // The schedule delivers again: the card needs nobody and closes itself.
    answer = "1. The first idea.";
    await run("2030-01-17T06:00:30Z");
    const after = await (await h.call("/v1/cards")).json();
    expect(after.open).toEqual([]);
    expect(after.recent[0]).toMatchObject({ id: first[0].id, state: "answered", answer: { via: "raiser" } });
    expect(tg.of("editMessageText").at(-1)).toMatchObject({ message_id: 501, reply_markup: { inline_keyboard: [] } });
  });

  it("says a signed-out model account once: one card for the owner that names who is stopped, one line in a chat that waits, closed when it works again", async () => {
    const { AccountUnavailableError } = await import("../src/account-errors.js");
    const tg = telegramBeside();
    let out = true;
    const h = await served(async () => { if (out) throw new AccountUnavailableError("sign_in_required"); return { threadId: "t", response: "1. The first idea.", events: [] }; });
    const store = h.runtime.store, saved = new Date("2030-01-15T05:00:00Z");
    const news = store.createProfile({ name: "News", instructions: "Report" }), sales = store.createProfile({ name: "Sales", instructions: "Sell" });
    const plan = (profile: string, name: string, chat: string) => h.runtime.scheduler.save({ conversationId: store.profileConversation(profile).id, name, prompt: "Report", cron: "0 * * * *", timezone: "UTC", delivery: "telegram", telegramChatId: chat }, saved);
    plan(news.id, "Morning", "-100"); plan(news.id, "Radar", "-100"); plan(sales.id, "Pipeline", "42");
    const run = async (at: string) => { await h.runtime.scheduler.tick(new Date(at)); await h.runtime.scheduler.idle(); };
    const said = (chat: string) => tg.of("sendMessage").filter(message => message.chat_id === chat && /вход в аккаунт модели|Не получилось|Требует внимания/.test(message.text));
    const cards = async () => (await (await h.call("/v1/cards")).json()).open;
    // Three schedules of two employees fail for two hours, and again the next day.
    for (const at of ["2030-01-15T06:00:30Z", "2030-01-15T07:00:30Z", "2030-01-16T06:00:30Z"]) await run(at);
    // The chat that waits for editions hears it once for the whole outage, in the Home's own words, with nothing to press.
    expect(said("-100")).toHaveLength(1);
    expect(said("-100")[0].text).toBe("News не работает: нужен вход в аккаунт модели. Владелец знает; всё вернётся само.");
    expect(said("-100")[0].reply_markup).toBeUndefined();
    // The owner has one card for the cause, not one per schedule, and no notice beside it.
    expect(await cards()).toEqual([expect.objectContaining({ kind: "failed", title: "Нужен вход в аккаунт модели", reason: "Не работают: News и Sales.", chat: { id: "42", title: "Den" }, content: { code: "sign_in" } })]);
    expect(said("42")).toHaveLength(1);
    expect(store.listMessages(store.primaryConversation().id).filter(message => message.kind === "notice")).toEqual([]);
    // It works again: the card closes itself, and a later outage is news again.
    out = false; await run("2030-01-16T07:00:30Z");
    expect(await cards()).toEqual([]);
    out = true; await run("2030-01-16T08:00:30Z");
    expect(await cards()).toHaveLength(1);
    expect(said("-100")).toHaveLength(2);
  });

  it("gives the owner's own chat the reason on the card, and no second notice", async () => {
    const tg = telegramBeside();
    const h = await served(async () => ({ threadId: "t", response: "FAILED: the source did not answer", events: [] }));
    await h.runtime.telegram.processUpdate(text(42, 42, "hello"));
    const dm = h.runtime.store.getTelegramChat("42")!.conversationId!, before = tg.of("sendMessage").length;
    h.runtime.scheduler.save({ conversationId: dm, name: "Morning brief", prompt: "The day", cron: "0 6 * * *", timezone: "UTC", delivery: "telegram", telegramChatId: "42" }, new Date("2030-01-15T05:00:00Z"));
    await h.runtime.scheduler.tick(new Date("2030-01-15T06:00:30Z")); await h.runtime.scheduler.idle();
    const sent = tg.of("sendMessage").slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ chat_id: "42" });
    expect(sent[0].text).toContain("the source did not answer");
    expect(sent[0].reply_markup.inline_keyboard.flat().map((button: any) => button.text)).toEqual(["Понятно"]);
  });

  it("stays in the app when the turn has no Telegram chat", async () => {
    const tg = telegram(), h = home({ run: raising(question) });
    await h.messages.handle({ channel: "api", text: "what is new?", externalChatId: "home", byOwner: true });
    expect(tg.of("sendMessage")).toEqual([]);
    expect(h.messages.cards.list().open[0]).toMatchObject({ chat: null, for: null, canAnswer: true, raiser: { profileId: null, name: "OpenStrudel" } });
  });

  it("offers no card to a run that reads the owner's private correspondence", async () => {
    telegram();
    const { employeeTools } = await import("../src/personality.js");
    const h = home(), own = h.store.primaryConversation();
    const tools = (context: Record<string, unknown>) => employeeTools(h.store, {} as any, h.messages.interactions, { profile: null, conversationId: own.id, messageId: "m", channel: "api", cards: h.messages.cards, ...context } as any);
    expect(tools({ byOwner: true }).definitions.some(tool => tool.name === "raise_card")).toBe(true);
    const event = h.store.addMessage({ conversationId: own.id, channel: "api", direction: "inbound", text: "event", externalId: "correspondence:1" });
    const run = tools({ messageId: event.id, scheduled: true });
    // Whatever the audience check decides for this bare run, the tool and the check agree.
    const { correspondenceAudience } = await import("../src/correspondence.js");
    expect(run.definitions.some(tool => tool.name === "raise_card")).toBe(!correspondenceAudience(h.store, { conversationId: own.id, messageId: event.id, channel: "api", scheduled: true }));
  });

  it("keeps a decision off words Telegram would cut: the whole card waits in the app", async () => {
    const tg = telegram(), long = "A long letter. ".repeat(400);
    const h = home({ run: raising({ kind: "send", title: "Send the long letter?", to: "Team", via: "Telegram", text: long, chatId: "-100" }) });
    await h.adapter.processUpdate(text(42, 42, "draft a long letter"));
    const card = tg.of("sendMessage")[0];
    expect(card.text.length).toBeLessThan(4096);
    expect(card.text).toContain("OpenStrudel");
    expect(tg.buttons(card)).toEqual([]);
    expect(h.messages.cards.list().open[0]).toMatchObject({ content: { text: long.trim() } });
  });

  it("waits again, and says why, when Telegram refuses the send", async () => {
    const h = home({ run: raising({ kind: "send", title: "Send to the team?", to: "Team", via: "Telegram", text: "Friday we close at 15:00.", chatId: "-100" }) });
    const calls: Call[] = [];
    let id = 500;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const method = String(url).split("/").at(-1)!, body = JSON.parse(String(init.body));
      calls.push({ method, body });
      if (method === "sendMessage" && body.chat_id === "-100") return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was kicked from the group chat" }, { status: 403 });
      return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: ++id } : true });
    }));
    await h.adapter.processUpdate(text(42, 42, "draft a note"));
    const card = calls.find(call => call.method === "sendMessage")!.body, data = card.reply_markup.inline_keyboard[0][0].callback_data;
    await h.adapter.processUpdate(press(42, 42, 501, data));
    expect(h.messages.cards.list().open).toHaveLength(1);
    const edit = calls.filter(call => call.method === "editMessageText").at(-1)!.body;
    expect(edit.text).toMatch(/Not sent/);
    expect(edit.reply_markup.inline_keyboard.flat().map((button: any) => button.text)).toEqual(["Send", "Keep as draft"]);
  });
});

describe("the app's list", { timeout: 30_000 }, () => {
  it("returns what waits with its whole content, and takes one answer that Telegram then shows", async () => {
    const tg = telegramBeside(), h = await served(raising({ kind: "send", title: "Send to the team?", reason: "You asked for a note about Friday.", to: "Team", via: "Telegram", text: "Friday we close at 15:00.", chatId: "-100" }));
    await h.runtime.telegram.processUpdate(text(42, 42, "draft a note for the team"));
    const list = await (await h.call("/v1/cards")).json();
    expect(list.recent).toEqual([]);
    expect(list.open).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{16}$/), kind: "send", state: "open", createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      raiser: { profileId: null, name: "OpenStrudel" }, conversationId: expect.any(String), messageId: expect.any(String), title: "Send to the team?", reason: "You asked for a note about Friday.",
      content: { to: "Team", via: "Telegram", subject: null, text: "Friday we close at 15:00." },
      choices: [{ id: "send", label: "Send", role: "primary" }, { id: "draft", label: "Keep as draft", role: "plain" }],
      chat: { id: "42", title: "Den" }, for: [{ id: "42", name: "Den" }], canAnswer: true, answer: null }]);
    const id = list.open[0].id;
    expect((await h.call(`/v1/cards/${id}/answer`, { choice: "nothing" })).status).toBe(400);
    expect((await h.call(`/v1/cards/${"0".repeat(16)}/answer`, { choice: "send" })).status).toBe(404);
    const answered = await h.call(`/v1/cards/${id}/answer`, { choice: "send" });
    expect(answered.status).toBe(200);
    expect((await answered.json()).card).toMatchObject({ state: "answered", answer: { choice: "send", via: "app", by: "OpenStrudel app", outcome: "Sent to Team" } });
    // The Home sent the shown text itself, once, and the card in Telegram reads as a record.
    expect(tg.of("sendMessage").filter(message => message.chat_id === "-100").map(message => message.text)).toEqual(["Friday we close at 15:00."]);
    expect(tg.of("editMessageText").at(-1)).toMatchObject({ chat_id: "42", message_id: 501, reply_markup: { inline_keyboard: [] } });
    expect(tg.of("editMessageText").at(-1).text).toMatch(/Sent to Team · OpenStrudel app/);
    // A second answer, from the app or from Telegram, finds it decided.
    const second = await h.call(`/v1/cards/${id}/answer`, { choice: "draft" });
    expect(second.status).toBe(409);
    expect((await second.json()).card.answer.choice).toBe("send");
    await h.runtime.telegram.processUpdate(press(42, 42, 501, `c:${id}:draft`));
    expect(tg.of("sendMessage").filter(message => message.chat_id === "-100")).toHaveLength(1);
    const after = await (await h.call("/v1/cards")).json();
    expect(after.open).toEqual([]);
    expect(after.recent.map((card: any) => card.id)).toEqual([id]);
  });

  it("shows an answer given in Telegram", async () => {
    const tg = telegramBeside(), h = await served(raising(question));
    await h.runtime.telegram.processUpdate(text(42, 42, "what is new?"));
    h.script.run = undefined;
    await h.runtime.telegram.processUpdate(press(42, 42, 501, tg.of("sendMessage")[0].reply_markup.inline_keyboard[0][0].callback_data));
    const list = await (await h.call("/v1/cards")).json();
    expect(list.open).toEqual([]);
    expect(list.recent[0]).toMatchObject({ state: "answered", answer: { choice: "c0", label: "Salary", by: "Den", via: "telegram" } });
  });

  it("carries the app's words to the raiser, and the edited text of a send is the text that leaves", async () => {
    const tg = telegramBeside(), h = await served(raising(question));
    await h.runtime.telegram.processUpdate(text(42, 42, "what is new?"));
    const asked = (await (await h.call("/v1/cards")).json()).open[0];
    h.script.run = async () => ({ threadId: "t", response: "Split in two.", events: [] });
    expect((await h.call(`/v1/cards/${asked.id}/answer`, { choice: "other" })).status).toBe(400);
    expect((await h.call(`/v1/cards/${asked.id}/answer`, { choice: "other", text: "half and half" })).status).toBe(200);
    await vi.waitFor(() => expect(tg.of("sendMessage").at(-1)).toMatchObject({ chat_id: "42", text: "Split in two.", reply_parameters: { message_id: 501 } }));
    expect(h.runs.at(-1)!.options).toMatchObject({ conversationId: asked.conversationId, byOwner: true });
    expect(h.runs.at(-1)!.input).toContain("half and half");
    h.script.run = raising({ kind: "send", title: "Send to the team?", to: "Team", via: "Telegram", text: "Friday we close at 15:00.", chatId: "-100" });
    await h.runtime.telegram.processUpdate(text(42, 42, "draft a note for the team"));
    const draft = (await (await h.call("/v1/cards")).json()).open[0];
    await h.call(`/v1/cards/${draft.id}/answer`, { choice: "send", text: "Friday we close at 14:00." });
    expect(tg.of("sendMessage").filter(message => message.chat_id === "-100").map(message => message.text)).toEqual(["Friday we close at 14:00."]);
  });

  it("takes always from the app as an owner's rule", async () => {
    const { homeRules } = await import("../src/home-management.js");
    const tg = telegramBeside(), h = await served();
    const ask = async (amount: string) => {
      h.script.run = raising({ kind: "answer", title: `Corner bakery, ${amount}`, about: "Corner bakery", choices: ["Salary", "Office"] });
      await h.runtime.telegram.processUpdate(text(42, 42, "anything new?"));
      h.script.run = async () => ({ threadId: "t", response: "NO_REPLY", events: [] });
      return h.runtime.messages.cards.list().open[0]!;
    };
    for (const amount of ["12.40", "9.10"]) expect((await h.call(`/v1/cards/${(await ask(amount)).id}/answer`, { choice: "c0" })).status).toBe(200);
    const third = await ask("7.00");
    expect(third.choices.map(choice => choice.id)).toEqual(["c0", "c1", "always", "other"]);
    const answered = await (await h.call(`/v1/cards/${third.id}/answer`, { choice: "always" })).json();
    expect(answered.card).toMatchObject({ state: "answered", answer: { choice: "always", via: "app", outcome: "Salary, always. Saved as a rule" } });
    expect(homeRules(h.runtime.store).map(rule => rule.text)).toEqual([answered.card.content.rule]);
    await vi.waitFor(() => expect(tg.of("editMessageText").at(-1)?.text).toMatch(/Saved as a rule · OpenStrudel app/));
  });

  it("is closed to a colleague's device", async () => {
    telegramBeside();
    const h = await served(raising(question));
    await h.runtime.telegram.processUpdate(text(42, 42, "what is new?"));
    const login = await h.call("/auth/session", { key: h.runtime.api.web.invite(false).key }, {});
    const { csrf } = await login.json();
    const colleague = { cookie: login.headers.get("set-cookie")!.split(";")[0]!, "x-openstrudel-csrf": csrf };
    const id = h.runtime.messages.cards.list().open[0]!.id;
    expect((await h.call("/v1/cards", undefined, colleague)).status).toBe(403);
    expect((await h.call(`/v1/cards/${id}/answer`, { choice: "c0" }, colleague)).status).toBe(403);
    expect(h.runtime.messages.cards.list().open).toHaveLength(1);
  });

  it("closes a connector's send card when the approval is answered the older way, in the conversation", async () => {
    const tg = telegramBeside(), sent = vi.fn();
    const h = await served(async (_input, o) => {
      const approval = await o!.onRequest!("mcpServer/elicitation/request", { mode: "form", serverName: "mail", message: 'Allow the mail MCP server to run tool "send_letter"?',
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { to: "office@example.com", subject: "Report", body: "Attached." } }, requestedSchema: { type: "object", properties: {} } }) as { action: string };
      if (approval.action === "accept") sent();
      return { threadId: "t", response: "Sent.", events: [] };
    });
    const turn = h.runtime.telegram.processUpdate(text(42, 42, "send the report"));
    await vi.waitFor(() => expect(h.runtime.messages.cards.list().open).toHaveLength(1));
    const card = h.runtime.messages.cards.list().open[0]!, interaction = h.runtime.messages.interactions.list(card.conversationId)[0]!;
    expect(interaction).toMatchObject({ title: "Отправить сообщение?", questions: [{ options: ["Отправить", "Не отправлять"] }] });
    expect(interaction.detail).toBe("To: office@example.com · mail\nSubject: Report\n\nAttached.");
    expect((await h.call(`/v1/interactions/${interaction.id}`, { conversationId: card.conversationId, answers: { decision: "Отправить" } })).status).toBe(200);
    await turn;
    expect(sent).toHaveBeenCalledTimes(1);
    expect(h.runtime.messages.cards.list().recent[0]).toMatchObject({ answer: { choice: "send", via: "app" } });
    await vi.waitFor(() => expect(tg.of("editMessageText").at(-1)?.reply_markup).toEqual({ inline_keyboard: [] }));
  });
});
