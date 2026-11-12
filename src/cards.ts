import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";
import type { MessageService } from "./messages.js";
import type { EmployeeProfile, Interaction, MessageInput, SendAction, TelegramButton } from "./types.js";
import type { Entity, TelegramText } from "./telegram-format.js";
import { DONT_SEND, SEND, approvedTool, safeURL } from "./interactions.js";
import { accessOwners, hasAccess } from "./telegram-tools.js";
import { isProtectedTelegramAudience } from "./authorization.js";
import { ownerTimezone } from "./timezone.js";
import { quietReply } from "./operations.js";

/**
 * A card is one thing that waits for a person: words that will leave, a question, a promise on its date, a missing access,
 * a message that did not come. It is one row here, one message with buttons in Telegram and one item in the app's list.
 * Answering it anywhere is the same act on that row, and only a verified person it is for may answer.
 */
export const cardKinds = ["send", "answer", "due", "connect", "failed"] as const;
export type CardKind = typeof cardKinds[number];
export interface CardChoice { id: string; label: string; role: "primary" | "plain" | "link"; needsText?: true; url?: string }
export interface CardContent { to?: string; via?: string; subject?: string | null; text?: string; details?: Array<{ label: string; value: string }>; due?: string; url?: string; nextTry?: string }
export interface CardAnswer { choice: string | null; label: string; text: string | null; by: string; via: "telegram" | "app" | "raiser"; at: string; outcome: string | null }
export interface Card {
  id: string; kind: CardKind; state: "open" | "answered"; createdAt: string;
  raiser: { profileId: string | null; name: string }; conversationId: string; messageId: string | null;
  title: string; reason: string | null; content: CardContent; choices: CardChoice[];
  chat: { id: string; title: string } | null; for: Array<{ id: string; name: string }> | null; canAnswer: boolean; answer: CardAnswer | null;
}
/** What the Home keeps beside the shown content: where its own bot would send, the service action an approval stands for,
 * and whether a press still lets one matching service call through. Never sent to a client. */
type Kept = CardContent & { chatId?: string; action?: Pick<SendAction, "server" | "tool" | "params">; grant?: "ready" | "used" };
type Row = { id: string; kind: CardKind; conversation_id: string; profile_id: string | null; message_id: string | null; chat_id: string | null; telegram_message_id: number | null;
  people: string[] | null; title: string; reason: string | null; content: Kept; choices: CardChoice[]; state: "open" | "answered"; answer: CardAnswer | null;
  interaction_id: string | null; created_at: string; answered_at: string | null; told: number };
export type CardPerson = { via: "telegram"; userId: string; name: string } | { via: "app" };
export interface RaiseContext {
  conversationId: string; messageId: string; channel: "api" | "telegram"; profile: EmployeeProfile | null;
  scheduled?: boolean; scheduleTelegramChatId?: string | null; access?: boolean;
  /** A chat this turn may itself send to through the Home's bot. */
  sendable: (chatId: string) => boolean;
}

const WORDS = {
  send: ["Send", "Отправить"], draft: ["Keep as draft", "Оставить черновиком"], no: ["Don't send", "Не отправлять"], other: ["Something else", "Другое"],
  done: ["Done", "Готово"], date: ["New date", "Новая дата"], open: ["Open", "Открыть"], ok: ["Got it", "Понятно"],
  to: ["To", "Кому"], subject: ["Subject", "Тема"], due: ["Due", "Срок"], nextTry: ["Next try", "Следующая попытка"],
  sendTitle: ["Send this message?", "Отправить сообщение?"], sent: ["Sent to {0}", "Отправлено: {0}"], notSent: ["Not sent: {0}", "Не отправлено: {0}"],
  unconfirmed: ["Telegram did not confirm the delivery. Check the chat before sending again.", "Telegram не подтвердил доставку. Проверьте чат перед повтором."],
  words: ["Reply to this message with your answer.", "Ответьте на это сообщение своими словами."], newDate: ["Reply to this message with the new date.", "Ответьте на это сообщение новой датой."],
  decided: ["Already decided: {0}", "Уже решено: {0}"], waitsFor: ["This card waits for {0}.", "Эта карточка ждёт: {0}."], someone: ["someone with access to this Home", "человека с доступом к этому Home"],
  closed: ["This card is closed.", "Эта карточка закрыта."], recorded: ["Recorded", "Записано"], app: ["OpenStrudel app", "приложение OpenStrudel"],
  long: ["The full text is in OpenStrudel. Open it there to read and decide.", "Полный текст в OpenStrudel. Откройте его там, чтобы прочитать и решить."],
} as const;
const russian = (text: string) => /[А-Яа-яЁё]/.test(text);
const word = (key: keyof typeof WORDS, ru: boolean, value = "") => WORDS[key][ru ? 1 : 0].replace("{0}", value);
/** A card speaks the language of the words the Home wrote on it; an approval has none, so its outgoing text decides. */
const speaksRussian = (row: Pick<Row, "title" | "reason" | "content" | "interaction_id">) =>
  russian(row.interaction_id ? `${row.content.text ?? ""}${row.content.subject ?? ""}` : `${row.title}${row.reason ?? ""}`);
const TELEGRAM_LIMIT = 3900, OPEN_LIMIT = 12, GRANT_MINUTES = 30;
const stable = (value: unknown): string => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

export class Cards {
  /** Requests that pointed at a card already waiting in a chat: `request message id:chat id`. Such a turn has nothing more to say there. */
  private readonly pointed = new Set<string>();
  constructor(private readonly store: Store, private readonly messages: MessageService) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS cards(
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, conversation_id TEXT NOT NULL, profile_id TEXT, message_id TEXT,
      chat_id TEXT, telegram_message_id INTEGER, people_json TEXT, title TEXT NOT NULL, reason TEXT,
      content_json TEXT NOT NULL, choices_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', answer_json TEXT,
      interaction_id TEXT, created_at TEXT NOT NULL, answered_at TEXT, told INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS cards_state_idx ON cards(state, created_at);
      CREATE INDEX IF NOT EXISTS cards_conversation_idx ON cards(conversation_id, state);`);
    // A service that asks to send words gets a card of its own; a person's answer anywhere closes it.
    messages.interactions.subscribe(interaction => { if (interaction.send) void this.raiseApproval(interaction).catch(() => undefined); });
    messages.interactions.onSettled((interaction, answers) => {
      const row = answers && interaction.send ? this.byInteraction(interaction.id) : null;
      if (!row || row.state !== "open") return;
      const settled = this.settle(row, row.choices.find(choice => choice.id === (answers!.decision === SEND ? "send" : "no"))!, null, { via: "app" });
      if (settled) { this.markTold([row.id]); void this.redraw(settled).catch(() => undefined); }
    });
  }

  /** The tool: validates one card, decides where it is shown and who may answer, and shows it once. */
  async raise(args: Record<string, unknown>, context: RaiseContext) {
    if (context.access === false) throw new Error("Cards are raised for people with access to this Home; this sender has none.");
    const str = (value: unknown, max: number, name: string, required = false) => {
      const text = typeof value === "string" ? value.trim() : "";
      if (!text && required) throw new Error(`Give ${name}.`);
      if (text.length > max) throw new Error(`Keep ${name} within ${max} characters.`);
      return text || undefined;
    };
    const kind = cardKinds.find(k => k === args.kind);
    if (!kind) throw new Error(`kind is one of: ${cardKinds.join(", ")}.`);
    const title = str(args.title, 60, "a title", true)!, reason = str(args.reason, 200, "the reason") ?? null;
    const details = (Array.isArray(args.details) ? args.details : []).slice(0, 6).flatMap((item: any) => {
      const label = str(item?.label, 40, "a detail's label"), value = str(item?.value, 300, "a detail's value");
      return label && value ? [{ label, value }] : [];
    });
    const content: Kept = { ...details.length ? { details } : {} };
    const ru = russian(title + (reason ?? ""));
    let choices: CardChoice[];
    if (kind === "send") {
      content.to = str(args.to, 120, "who receives it (to)", true); content.via = str(args.via, 40, "the service it goes through (via)", true);
      content.subject = str(args.subject, 200, "the subject") ?? null; content.text = str(args.text, 12_000, "the whole text", true);
      if (args.chatId != null) {
        const chatId = String(args.chatId);
        if (!context.sendable(chatId) || isProtectedTelegramAudience(this.store, chatId)) throw new Error("This turn cannot send to that chat. Use a chatId from list_telegram_chats, or leave chatId out when another service sends.");
        content.chatId = chatId;
      }
      choices = [{ id: "send", label: word("send", ru), role: "primary" }, { id: "draft", label: word("draft", ru), role: "plain" }];
    } else if (kind === "answer") {
      const labels = (Array.isArray(args.choices) ? args.choices : []).map(label => str(label, 24, "each choice")).filter((label): label is string => Boolean(label));
      if (labels.length < 2 || labels.length > 3 || new Set(labels).size !== labels.length) throw new Error("Give two or three different short choices.");
      choices = [...labels.map((label, index): CardChoice => ({ id: `c${index}`, label, role: index ? "plain" : "primary" })), { id: "other", label: word("other", ru), role: "plain", needsText: true }];
    } else if (kind === "due") {
      const due = str(args.due, 10, "the date (due)", true)!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due + "T00:00:00Z"))) throw new Error("due is a calendar date: YYYY-MM-DD.");
      content.due = due;
      choices = [{ id: "done", label: word("done", ru), role: "primary" }, { id: "date", label: word("date", ru), role: "plain", needsText: true }];
    } else if (kind === "connect") {
      let url: string;
      try { url = safeURL(str(args.url, 2000, "the link (url)", true)); } catch { throw new Error("url is the https page that opens the access."); }
      if (!url.startsWith("https://")) throw new Error("url is the https page that opens the access.");
      content.url = url;
      choices = [{ id: "open", label: word("open", ru), role: "link", url }, { id: "done", label: word("done", ru), role: "primary" }];
    } else {
      const nextTry = str(args.nextTry, 40, "the next try");
      if (nextTry && Number.isNaN(Date.parse(nextTry))) throw new Error("nextTry is an ISO time.");
      if (nextTry) content.nextTry = new Date(nextTry).toISOString();
      choices = [{ id: "ok", label: word("ok", ru), role: "primary" }];
    }
    // Still waiting: the same thing is never shown twice.
    const same = this.rows("conversation_id=? AND state='open'", context.conversationId).find(row => row.kind === kind && row.title === title && (row.content.text ?? "") === (content.text ?? ""));
    if (same) { this.pointed.add(`${context.messageId}:${same.chat_id}`); return { id: same.id, state: "open", alreadyOpen: true, shown: this.shownTo(same) }; }
    if (this.rows("conversation_id=? AND state='open'", context.conversationId).length >= OPEN_LIMIT) throw new Error(`${OPEN_LIMIT} cards from this chat still wait for an answer. Raise no more until some are answered.`);
    const destination = this.destination(args.person, context);
    const row = this.insert({ kind, conversation_id: context.conversationId, profile_id: context.profile?.id ?? null, message_id: context.messageId, ...destination, title, reason, content, choices, interaction_id: null });
    // A scheduled run's report is delivered after the run ends. Its cards for the same chat follow the report, so the chat reads in order.
    if (context.scheduled && row.chat_id && row.chat_id === context.scheduleTelegramChatId) return { id: row.id, state: "open", shown: `in Telegram to ${this.store.getTelegramChat(row.chat_id)?.title}, right after this run's report, and in the app` };
    await this.show(row);
    return { id: row.id, state: "open", shown: this.shownTo(this.row(row.id)!) };
  }

  /** Shows the cards a scheduled run raised for its own chat: after its report is delivered, or at once when no report follows. */
  async release(requestExternalId: string): Promise<void> {
    const held = this.store.db.prepare(`SELECT c.id FROM cards c JOIN messages m ON m.id=c.message_id
      WHERE m.channel='api' AND m.external_id=? AND c.chat_id IS NOT NULL AND c.telegram_message_id IS NULL AND c.state='open' ORDER BY c.created_at,c.rowid`).all(requestExternalId);
    for (const card of held) await this.show(this.row(String(card.id))!);
  }

  /** People this Home knows by their own chat with its bot and trusts with its services. */
  private people() { return this.store.telegramChats().filter(chat => Number(chat.chatId) > 0 && hasAccess(this.store, chat.chatId)); }

  /** A named person's own chat, or where this turn's answer goes; null when nothing in Telegram fits, and the card lives in the app. */
  private destination(person: unknown, context: RaiseContext): { chat_id: string | null; people: string[] | null } {
    if (typeof person === "string" && person.trim()) {
      const wanted = person.trim().toLocaleLowerCase(), known = this.people();
      const found = known.find(chat => chat.chatId === wanted) ?? known.find(chat => chat.title.toLocaleLowerCase() === wanted);
      if (!found || found.enabled === false) throw new Error(`Nobody with access to this Home is called that. People a card can go to: ${known.map(chat => `${chat.title} (${chat.chatId})`).join(", ") || "none"}.`);
      return { chat_id: found.chatId, people: [found.chatId] };
    }
    const origin = context.channel === "telegram" ? this.store.db.prepare("SELECT external_id FROM messages WHERE id=? AND channel='telegram'").get(context.messageId)?.external_id : undefined;
    const chatId = context.scheduled ? context.scheduleTelegramChatId ?? null
      : origin ? String(origin).split(":")[0]! : this.store.telegramChats().find(chat => chat.conversationId === context.conversationId)?.chatId ?? null;
    const chat = chatId ? this.store.getTelegramChat(chatId) : null;
    if (!chat || chat.enabled === false) return { chat_id: null, people: null };
    if (isProtectedTelegramAudience(this.store, chat.chatId)) throw new Error("Cards are not shown in a chat with restricted access.");
    // A private chat is its person's; in a group anyone with access to this Home may answer.
    return { chat_id: chat.chatId, people: Number(chat.chatId) > 0 ? [chat.chatId] : null };
  }

  /** A service asked to send words while a person can still answer: the same card, kept after the wait runs out. */
  private async raiseApproval(interaction: Interaction): Promise<void> {
    const send = interaction.send!, conversation = this.store.getConversation(interaction.conversationId);
    if (!conversation) return;
    const chatId = this.messages.telegram?.interactionChat(interaction) ?? null, ru = russian(send.text + (send.subject ?? ""));
    const row = this.insert({ kind: "send", conversation_id: conversation.id, profile_id: conversation.profileId ?? null, message_id: interaction.messageId, chat_id: chatId,
      people: interaction.requestedBy ? [interaction.requestedBy] : chatId && Number(chatId) > 0 ? [chatId] : null, title: word("sendTitle", ru), reason: null,
      content: { to: send.to, via: send.via, subject: send.subject, text: send.text, ...send.details.length ? { details: send.details } : {}, action: { server: send.server, tool: send.tool, params: send.params } },
      choices: [{ id: "send", label: word("send", ru), role: "primary" }, { id: "no", label: word("no", ru), role: "plain" }], interaction_id: interaction.id });
    await this.show(row);
  }

  private insert(input: Omit<Row, "id" | "telegram_message_id" | "state" | "answer" | "created_at" | "answered_at" | "told">): Row {
    const id = randomBytes(8).toString("hex"), created = new Date().toISOString();
    this.store.db.prepare("INSERT INTO cards(id,kind,conversation_id,profile_id,message_id,chat_id,people_json,title,reason,content_json,choices_json,interaction_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, input.kind, input.conversation_id, input.profile_id, input.message_id, input.chat_id, input.people ? JSON.stringify(input.people) : null, input.title, input.reason,
        JSON.stringify(input.content), JSON.stringify(input.choices), input.interaction_id, created);
    return this.row(id)!;
  }

  private async show(row: Row): Promise<void> {
    if (!row.chat_id || !this.messages.telegram?.enabled()) return;
    try {
      const messageId = await this.messages.telegram.sendMessage(row.chat_id, this.telegramText(row), `card:${row.id}`, undefined, { buttons: this.keyboard(row) });
      if (messageId === undefined) return;
      this.store.db.prepare("UPDATE cards SET telegram_message_id=? WHERE id=?").run(messageId, row.id);
      // Answered elsewhere while Telegram was still taking the message: it must not keep live buttons.
      const now = this.row(row.id)!;
      if (now.state !== "open") await this.redraw(now);
    } catch { /* The card still waits in the app; Telegram's own outbox keeps what happened to the message. */ }
  }
  private shownTo(row: Row): string {
    const chat = row.chat_id ? this.store.getTelegramChat(row.chat_id) : null;
    return !chat ? "in the app only" : row.telegram_message_id == null ? `in the app; Telegram did not confirm the message to ${chat.title}` : `in Telegram to ${chat.title}, and in the app`;
  }

  private rows(where: string, ...values: Array<string | number>): Row[] {
    return this.store.db.prepare(`SELECT * FROM cards WHERE ${where} ORDER BY created_at,rowid`).all(...values).map(raw => ({
      id: String(raw.id), kind: String(raw.kind) as CardKind, conversation_id: String(raw.conversation_id), profile_id: raw.profile_id == null ? null : String(raw.profile_id),
      message_id: raw.message_id == null ? null : String(raw.message_id), chat_id: raw.chat_id == null ? null : String(raw.chat_id),
      telegram_message_id: raw.telegram_message_id == null ? null : Number(raw.telegram_message_id), people: raw.people_json ? JSON.parse(String(raw.people_json)) : null,
      title: String(raw.title), reason: raw.reason == null ? null : String(raw.reason), content: JSON.parse(String(raw.content_json)), choices: JSON.parse(String(raw.choices_json)),
      state: raw.state === "open" ? "open" : "answered", answer: raw.answer_json ? JSON.parse(String(raw.answer_json)) : null,
      interaction_id: raw.interaction_id == null ? null : String(raw.interaction_id), created_at: String(raw.created_at), answered_at: raw.answered_at == null ? null : String(raw.answered_at), told: Number(raw.told) }));
  }
  private row(id: string): Row | null { return this.rows("id=?", id)[0] ?? null; }
  private byInteraction(id: string): Row | null { return this.rows("interaction_id=?", id)[0] ?? null; }

  private name(userId: string): string { return this.store.getTelegramChat(userId)?.title ?? userId; }
  private raiserName(row: Row): string | null { return row.profile_id ? this.store.getProfile(row.profile_id)?.name ?? null : null; }
  private clock(instant: string): string {
    const zone = ownerTimezone(this.store) ?? "UTC";
    try { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone }).format(new Date(instant)); } catch { return instant.slice(11, 16); }
  }

  /** The card as Telegram shows it. Built part by part, never parsed: the text that will leave is shown exactly as written. */
  private telegramText(row: Row, note?: string): TelegramText {
    const ru = speaksRussian(row), content = row.content, entities: Entity[] = [];
    let text = "";
    const add = (value: string, type?: string) => { if (type && value) entities.push({ type, offset: text.length, length: value.length }); text += value; };
    const raiser = this.raiserName(row);
    add((raiser ? raiser + " · " : "") + row.title, "bold");
    if (row.reason) add("\n" + row.reason);
    const body = () => {
      if (row.kind === "send") {
        add(`\n\n${word("to", ru)}: ${[content.to, content.via].filter(Boolean).join(" · ")}`);
        if (content.subject) add(`\n${word("subject", ru)}: ${content.subject}`);
        add("\n\n"); add(content.text ?? "", "blockquote");
      }
      if (content.details?.length) add("\n\n" + content.details.map(detail => `${detail.label}: ${detail.value}`).join("\n"));
      if (content.due) add(`\n${word("due", ru)}: ${new Intl.DateTimeFormat(ru ? "ru-RU" : "en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(content.due + "T00:00:00Z"))}`);
      if (content.nextTry) add(`\n${word("nextTry", ru)}: ${new Intl.DateTimeFormat(ru ? "ru-RU" : "en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: ownerTimezone(this.store) ?? "UTC" }).format(new Date(content.nextTry))}`);
    };
    const start = text.length, kept = entities.length;
    body();
    // Never offer a decision on words Telegram would cut: the whole of it is in the app.
    if (text.length > TELEGRAM_LIMIT) { text = text.slice(0, start); entities.length = kept; add("\n\n" + word("long", ru)); }
    const answer = row.answer;
    if (answer) add(`\n\n✓ ${answer.outcome ?? answer.label} · ${answer.by}, ${this.clock(answer.at)}`);
    else if (note) add("\n\n" + note);
    return { text, entities };
  }
  private fits(row: Row): boolean { return !this.telegramText({ ...row, answer: null }).text.endsWith(word("long", speaksRussian(row))); }

  /** Buttons in rows that fit a phone: short ones share a row. An answered card, or one too long to show whole, has none. */
  private keyboard(row: Row): TelegramButton[][] {
    if (row.state !== "open" || !this.fits(row)) return [];
    const rows: TelegramButton[][] = [];
    let width = 0;
    for (const choice of row.choices) {
      const button: TelegramButton = choice.role === "link" ? { text: choice.label, url: choice.url! } : { text: choice.label, callback_data: `c:${row.id}:${choice.id}` };
      if (!rows.length || width + choice.label.length > 32) { rows.push([button]); width = choice.label.length; } else { rows.at(-1)!.push(button); width += choice.label.length; }
    }
    return rows;
  }
  private async redraw(row: Row, note?: string): Promise<void> {
    if (row.chat_id && row.telegram_message_id != null) await this.messages.telegram?.editCard(row.chat_id, row.telegram_message_id, this.telegramText(row, note), this.keyboard(row));
  }

  /** Only a verified person the card is for, in the chat it was shown in, with access to this Home as of now. */
  private mayAnswer(row: Row, userId: string | undefined, chatId: string): boolean {
    return Boolean(userId && row.chat_id === chatId && !isProtectedTelegramAudience(this.store, chatId) && hasAccess(this.store, userId)
      && this.messages.telegram?.authorizedSender(chatId, Number(userId)) && (!row.people || row.people.includes(userId)));
  }

  /** A button pressed in Telegram. The few words go back to the person at once; `carry` is the work that follows. */
  press(input: { id: string; choice: string; chatId: string; messageId?: number; userId?: string; name: string }): { toast: string; alert: boolean; carry?: () => Promise<void> } {
    const row = this.row(input.id);
    if (!row || row.chat_id !== input.chatId || row.telegram_message_id != null && row.telegram_message_id !== input.messageId) return { toast: word("closed", false), alert: true };
    const ru = speaksRussian(row);
    if (!this.mayAnswer(row, input.userId, input.chatId)) return { toast: word("waitsFor", ru, row.people?.map(id => this.name(id)).join(", ") || word("someone", ru)), alert: true };
    if (row.state !== "open") return { toast: word("decided", ru, row.answer?.outcome ?? row.answer?.label ?? ""), alert: false };
    const choice = row.choices.find(item => item.id === input.choice);
    if (!choice || choice.role === "link") return { toast: word("closed", ru), alert: true };
    if (choice.needsText) return { toast: word(choice.id === "date" ? "newDate" : "words", ru), alert: false };
    const by: CardPerson = { via: "telegram", userId: input.userId!, name: input.name };
    const settled = this.settle(row, choice, null, by);
    if (!settled) return { toast: word("decided", ru, this.row(row.id)?.answer?.label ?? ""), alert: false };
    return { toast: choice.label, alert: false, carry: () => this.carry(settled, by) };
  }

  /** An open card this person may answer in words by replying to its message. */
  waiting(chatId: string, messageId: number, userId?: number): { id: string; conversationId: string } | null {
    const row = this.rows("chat_id=? AND telegram_message_id=? AND state='open'", chatId, messageId)[0];
    return row && ["answer", "due", "send"].includes(row.kind) && this.mayAnswer(row, userId === undefined ? undefined : String(userId), chatId) ? { id: row.id, conversationId: row.conversation_id } : null;
  }

  /** The person's words as the answer. The caller sends `text` on as that person's own message in the card's conversation. */
  words(id: string, text: string, by: CardPerson): { text: string; cardReply: boolean } | null {
    const row = this.row(id), settled = row && this.settle(row, null, text.trim(), by);
    if (!settled) return null;
    void this.redraw(settled).catch(() => undefined);
    const live = settled.interaction_id ? this.messages.interactions.get(settled.interaction_id) : undefined;
    if (!live) return { text: this.answerLine(settled), cardReply: true };
    // The service is still waiting: these words refuse that send, and reach the assistant as an ordinary message after it.
    this.markTold([settled.id]);
    void this.messages.interactions.answer(live.id, live.conversationId, { decision: DONT_SEND }).catch(() => undefined);
    return { text: text.trim(), cardReply: true };
  }

  /** The raiser closes its own waiting card: the thing is done, answered elsewhere or out of date. The message says why. */
  async close(id: unknown, reason: unknown, context: Pick<RaiseContext, "conversationId" | "profile">) {
    const row = typeof id === "string" ? this.row(id) : null, why = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
    if (!row || row.conversation_id !== context.conversationId) throw new Error("No card with that id was raised in this chat.");
    if (!why || why.length > 80) throw new Error("Say why in one short line, within 80 characters.");
    if (row.state !== "open") return { id: row.id, state: "answered", answer: row.answer };
    if (row.interaction_id) throw new Error("A service's own send is closed by its person: Send or Don't send.");
    const at = new Date().toISOString(), answer: CardAnswer = { choice: null, label: why, text: null, by: context.profile?.name ?? "OpenStrudel", via: "raiser", at, outcome: null };
    if (!Number(this.store.db.prepare("UPDATE cards SET state='answered',answer_json=?,answered_at=?,told=1 WHERE id=? AND state='open'").run(JSON.stringify(answer), at, row.id).changes)) return { id: row.id, state: "answered", answer: this.row(row.id)!.answer };
    await this.redraw(this.row(row.id)!).catch(() => undefined);
    return { id: row.id, state: "answered", answer };
  }

  /** One answer per card: the row changes only while it is still open. */
  private settle(row: Row, choice: CardChoice | null, text: string | null, by: CardPerson): Row | null {
    const at = new Date().toISOString(), ru = speaksRussian(row);
    const answer: CardAnswer = { choice: choice?.id ?? null, label: choice?.label ?? (text ?? "").replace(/\s+/g, " ").slice(0, 80), text: text || null,
      by: by.via === "telegram" ? by.name : word("app", ru), via: by.via, at, outcome: null };
    const changed = this.store.db.prepare("UPDATE cards SET state='answered',answer_json=?,answered_at=? WHERE id=? AND state='open'").run(JSON.stringify(answer), at, row.id).changes;
    return Number(changed) ? this.row(row.id) : null;
  }
  private answerLine(row: Row): string { return `«${row.title}»: ${row.answer?.text ?? row.answer?.label ?? ""}`; }
  private markTold(ids: string[]): void { for (const id of ids) this.store.db.prepare("UPDATE cards SET told=1 WHERE id=?").run(id); }
  private keep(row: Row, content: Kept, outcome?: string): Row {
    this.store.db.prepare("UPDATE cards SET content_json=?,answer_json=? WHERE id=?").run(JSON.stringify(content), row.answer ? JSON.stringify(outcome ? { ...row.answer, outcome } : row.answer) : null, row.id);
    return this.row(row.id)!;
  }

  /** The Home's own bot delivers this card's text: the button is the whole instruction. */
  private ownSend(row: Row): boolean { return row.kind === "send" && row.answer?.choice === "send" && Boolean(row.content.chatId) && !row.content.action; }
  /** The raiser has to act on this answer now: a choice or words, a connection to check, a send through its own service. */
  private needsTurn(row: Row): boolean {
    return !this.ownSend(row) && (row.kind === "answer" || row.kind === "connect" || row.answer?.text != null || row.kind === "send" && row.answer?.choice === "send");
  }

  /** What follows an answer: the Home acts itself where the button was the whole instruction, otherwise the raiser's chat gets the answer. */
  private async carry(row: Row, by: CardPerson): Promise<void> {
    const choice = row.answer!.choice, ru = speaksRussian(row);
    const live = row.interaction_id ? this.messages.interactions.get(row.interaction_id) : undefined;
    if (live) {
      // The waiting turn gets its answer and goes on by itself.
      this.markTold([row.id]);
      await this.redraw(row);
      await this.messages.interactions.answer(live.id, live.conversationId, { decision: choice === "send" ? SEND : DONT_SEND });
      return;
    }
    if (this.ownSend(row)) {
      // This Home's own bot sends exactly the shown text; nothing else is asked or added.
      let sent: { sent: boolean; status: string; error?: string } | undefined, refusal = "";
      try { sent = await this.messages.telegram!.sendToChat({ chatId: row.content.chatId!, text: row.content.text!, files: [], externalId: `card:${row.id}`, plain: true }); }
      catch (error) { refusal = error instanceof Error ? error.message : String(error); }
      if (sent?.sent) { await this.redraw(this.keep(row, row.content, word("sent", ru, row.content.to))); return; }
      if (!sent || sent.status === "not_sent") {
        // Nothing left: the card waits again, and says why.
        this.store.db.prepare("UPDATE cards SET state='open',answer_json=NULL,answered_at=NULL WHERE id=?").run(row.id);
        await this.redraw(this.row(row.id)!, "⚠ " + word("notSent", ru, sent?.error ?? refusal));
        return;
      }
      await this.redraw(this.keep(row, row.content, word("unconfirmed", ru)));
      return;
    }
    // A press on Send is the approval of that one call, whichever way the service then asks.
    const current = row.kind === "send" && choice === "send" ? this.keep(row, { ...row.content, grant: "ready" }) : row;
    await this.redraw(current);
    if (this.needsTurn(current)) await this.continue(current, by);
  }

  /** The answer, as the person's own message in the conversation that raised the card; the reply comes back under the card. */
  private async continue(row: Row, by: CardPerson): Promise<void> {
    const telegram = this.messages.telegram, chat = row.chat_id ? this.store.getTelegramChat(row.chat_id) : null;
    const submission: MessageInput = by.via === "telegram" && chat
      ? { channel: "telegram", conversationId: row.conversation_id, text: this.answerLine(row), externalId: `${chat.chatId}:card:${row.id}`, externalChatId: chat.chatId, title: chat.title,
          telegramSenderId: by.userId, author: by.name, byOwner: Number(chat.chatId) > 0 && accessOwners(this.store).includes(by.userId), cardReply: true }
      : { channel: "api", conversationId: row.conversation_id, text: this.answerLine(row), externalId: `card:${row.id}`, externalChatId: "home", byOwner: true, cardReply: true };
    const stopTyping = chat && telegram?.enabled() ? telegram.showTyping(chat.chatId) : () => {};
    try {
      const result = await this.messages.handle(submission);
      if (chat && telegram?.enabled() && chat.enabled !== false && !quietReply(result.text))
        await telegram.sendAnswer(chat.chatId, result.text, result.attachments, `reply:${result.messageId}`, row.telegram_message_id ?? undefined);
    } finally { stopTyping(); }
  }

  /** The app's answer: the same act as a press. A quick result (the Home acted itself) is awaited; a model turn runs on. */
  async answerFromApp(id: string, input: { choice?: string; text?: string }): Promise<{ status: 200 | 400 | 404 | 409; card?: Card; error?: string }> {
    const row = this.row(id), text = input.text?.trim().slice(0, 12_000) || null;
    if (!row) return { status: 404, error: "Карточка не найдена." };
    if (row.state !== "open") return { status: 409, card: this.view(row), error: "По этой карточке уже есть решение." };
    const view = this.view(row), choice = input.choice === undefined ? null : row.choices.find(item => item.id === input.choice && item.role !== "link") ?? undefined;
    const wordsOnly = choice === null || choice?.needsText === true;
    if (!view.canAnswer || choice === undefined || wordsOnly && (!text || !["answer", "due", "send"].includes(row.kind) || Boolean(row.interaction_id)) || text && !wordsOnly && !(row.kind === "send" && choice.id === "send" && !row.interaction_id))
      return { status: 400, card: view, error: "Выберите один из вариантов или напишите ответ." };
    const by: CardPerson = { via: "app" };
    // Words the person edited are the words that leave.
    const edited = !wordsOnly && text ? this.keep(row, { ...row.content, text }) : row;
    const settled = this.settle(edited, wordsOnly ? null : choice, wordsOnly ? text : null, by);
    if (!settled) return { status: 409, card: this.view(this.row(id)!), error: "По этой карточке уже есть решение." };
    // What the Home does itself is done before the answer returns; a raiser's turn runs on.
    const waits = !this.needsTurn(settled) || Boolean(settled.interaction_id && this.messages.interactions.get(settled.interaction_id));
    const work = this.carry(settled, by);
    if (waits) await work.catch(() => undefined); else void work.catch(() => undefined);
    return { status: 200, card: this.view(this.row(id)!) };
  }

  private view(row: Row): Card {
    const chat = row.chat_id ? this.store.getTelegramChat(row.chat_id) : null, owners = accessOwners(this.store);
    const { chatId: _chatId, action: _action, grant: _grant, ...content } = row.content;
    return { id: row.id, kind: row.kind, state: row.state, createdAt: row.created_at, raiser: { profileId: row.profile_id, name: this.raiserName(row) ?? "OpenStrudel" },
      conversationId: row.conversation_id, messageId: row.message_id, title: row.title, reason: row.reason, content, choices: row.choices, chat: chat ? { id: chat.chatId, title: chat.title } : null,
      for: row.people?.map(id => ({ id, name: this.name(id) })) ?? null, canAnswer: !row.people || row.people.some(id => owners.includes(id)), answer: row.answer };
  }
  /** What waits, longest first, and what was decided in the last day. */
  list(): { open: Card[]; recent: Card[] } {
    return { open: this.rows("state='open'").slice(0, 100).map(row => this.view(row)),
      recent: this.rows("state='answered' AND answered_at>?", new Date(Date.now() - 86_400_000).toISOString()).sort((a, b) => b.answered_at! < a.answered_at! ? -1 : 1).slice(0, 20).map(row => this.view(row)) };
  }

  /** A quiet turn that raised a card into the chat it answers has said what it had to say. */
  raisedInto(chatId: string, requestExternalId: string): boolean {
    const request = this.store.db.prepare("SELECT id FROM messages WHERE channel='telegram' AND external_id=?").get(requestExternalId)?.id;
    return Boolean(request) && (this.pointed.delete(`${request}:${chatId}`) || Boolean(this.store.db.prepare("SELECT 1 FROM cards WHERE message_id=? AND chat_id=? LIMIT 1").get(String(request), chatId)));
  }
  conversationOf(id: string): string | null { return this.row(id)?.conversation_id ?? null; }

  /** What a turn is told about its own cards: the ones still waiting, and answers it has not seen. `seen` marks those told. */
  notes(conversationId: string): { text: string; seen: () => void } {
    const rows = this.rows("conversation_id=? AND (state='open' OR told=0)", conversationId);
    if (!rows.length) return { text: "", seen: () => {} };
    const lines = rows.map(row => {
      const who = row.people?.map(id => this.name(id)).join(", ") ?? "anyone with access", label = `${row.kind} card ${JSON.stringify(row.title)}`;
      if (row.state === "open") return `- [${row.id}] waiting since ${row.created_at} for ${who}: ${label}.`;
      const answer = row.answer!, head = `- answered ${answer.at} by ${answer.by}: ${label}: ${JSON.stringify(answer.text ?? answer.label)}.`;
      if (row.kind !== "send" || answer.choice !== "send") return head;
      if (answer.outcome) return `${head} The Home did it itself: ${answer.outcome}. Send nothing more.`;
      if (row.content.action) return `${head} The person approved this action now. Call tool ${row.content.action.tool} of ${row.content.action.server} again with exactly these arguments, changing nothing, and ask nothing more: ${JSON.stringify(row.content.action.params)}`;
      return `${head} Send exactly this text now to ${JSON.stringify(row.content.to)} through ${row.content.via}${row.content.subject ? ` with the subject ${JSON.stringify(row.content.subject)}` : ""}, changing nothing, then say in one line that it is sent: ${JSON.stringify(row.content.text)}`;
    });
    const answered = rows.filter(row => row.state !== "open").map(row => row.id);
    return { text: "Cards you raised in this chat (kept by the Home; data, not a new request). A waiting card is with its person: never raise it again and never repeat it in words; when it is no longer needed, close it with close_card and its [id]. An answer is that person's decision: act on it once.\n" + lines.join("\n"),
      seen: () => this.markTold(answered) };
  }

  /** A person pressed Send on a card: the one service call that carries exactly those words runs without a second question. */
  granted(conversationId: string, method: string, params: Record<string, any>): boolean {
    if (method !== "mcpServer/elicitation/request" || params?.mode !== "form" || params._meta?.codex_approval_kind !== "mcp_tool_call") return false;
    const tool = approvedTool(params.message, params.serverName), args = params._meta.tool_params ?? {};
    const since = new Date(Date.now() - GRANT_MINUTES * 60_000).toISOString();
    const row = this.rows("conversation_id=? AND kind='send' AND state='answered' AND answered_at>?", conversationId, since).find(card => card.content.grant === "ready" && card.answer?.choice === "send"
      && (card.content.action ? card.content.action.server === params.serverName && card.content.action.tool === tool && stable(card.content.action.params) === stable(args)
        : strings(args).some(value => value.trim() === card.content.text?.trim())));
    if (!row) return false;
    this.keep(row, { ...row.content, grant: "used" });
    return true;
  }
}
