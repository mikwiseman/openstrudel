import { randomUUID } from "node:crypto";
import type { Interaction, SendAction } from "./types.js";

type Pending = { card: Interaction; answers: Record<string, string>; resolve: (a: Record<string, string>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; validate?: (a: Record<string, string>) => Promise<void> };

/** A pending Codex question, tied to exactly one chat and message. */
export class Interactions {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(card: Interaction) => void>();
  private readonly settled = new Set<(card: Interaction, answers?: Record<string, string>) => void>();
  /** Answers are given only when a person answered; a wait that ran out or a turn that ended has none. */
  onSettled(listener: (card: Interaction, answers?: Record<string, string>) => void): void { this.settled.add(listener); }
  private finish(card: Interaction, answers?: Record<string, string>): void { for (const listener of this.settled) listener(card, answers); }
  subscribe(listener: (card: Interaction) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list(conversationId: string): Interaction[] { return [...this.pending.values()].filter(p => p.card.conversationId === conversationId).map(p => p.card); }
  get(id: string): Interaction | undefined { return this.pending.get(id)?.card; }
  ask(card: Omit<Interaction, "id">, validate?: Pending["validate"]): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      // A send keeps its card after the wait: the person's later press starts it again, so nobody is asked twice.
      const timer = setTimeout(() => { this.pending.delete(id); this.finish(complete); reject(new Error(card.send
        ? "Ответ пока не получен, ничего не отправлено. Карточка осталась открытой: отправка начнётся, когда человек нажмёт «Отправить». Не спрашивайте ещё раз."
        : "Время ожидания ответа истекло. Действие не подтверждено.")); }, 30 * 60_000);
      timer.unref();
      const complete = { ...card, id };
      this.pending.set(id, { card: complete, answers: {}, resolve, reject, timer, validate });
      for (const listener of this.listeners) listener(complete);
    });
  }
  async answer(id: string, conversationId: string, answers: Record<string, string>): Promise<void> {
    const p = this.pending.get(id);
    if (!p || p.card.conversationId !== conversationId) throw new Error("Этот запрос уже завершён или принадлежит другому чату");
    const snapshot = { ...p.answers };
    for (const [key, value] of Object.entries(answers)) {
      const question = p.card.questions.find(q => q.id === key);
      if (!question || typeof value !== "string" || !value.trim() || value.length > 8000) throw new Error("Проверьте ответ");
      if (question.options.length && !question.options.includes(value)) throw new Error("Выберите один из предложенных ответов");
      snapshot[key] = value;
    }
    if (!p.card.questions.every(q => snapshot[q.id])) { p.answers = snapshot; return; }
    await p.validate?.(snapshot);
    if (this.pending.get(id) !== p) throw new Error("Запрос уже завершён");
    clearTimeout(p.timer); this.pending.delete(id); this.finish(p.card, snapshot); p.resolve(snapshot);
  }
  cancelMessage(messageId: string): void {
    for (const [id, p] of this.pending) if (p.card.messageId === messageId) {
      clearTimeout(p.timer); this.pending.delete(id); this.finish(p.card); p.reject(new Error("Запрос завершён без подтверждения"));
    }
  }
  close(): void { for (const p of [...this.pending.values()]) this.cancelMessage(p.card.messageId); }

  async codexRequest(conversationId: string, messageId: string, method: string, params: Record<string, any>, requestedBy?: string): Promise<unknown> {
    const base = { conversationId, messageId };
    if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") {
      if ((params.questions ?? []).some((q: any) => q.isSecret)) throw new Error("Секретные данные вводятся только на странице подключения сервиса");
      const answers = await this.ask({ ...base, title: "Нужен ваш ответ", questions: params.questions.map((q: any) => ({ id: q.id, question: q.question, options: (q.options ?? []).map((o: any) => o.label) })) });
      return { answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }])) };
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const answers = await this.ask({ ...base, title: "Разрешить действие?", detail: [params.reason, params.command, params.cwd, params.grantRoot].filter(Boolean).join("\n"), questions: [{ id: "decision", question: "", options: ["Разрешить", "Отказать"] }] });
      return { decision: answers.decision === "Разрешить" ? "accept" : "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      const answers = await this.ask({ ...base, title: "Разрешить доступ?", detail: [params.reason, JSON.stringify(params.permissions)].filter(Boolean).join("\n"), questions: [{ id: "decision", question: "Только для этого ответа", options: ["Разрешить", "Отказать"] }] });
      return { permissions: answers.decision === "Разрешить" ? Object.fromEntries(Object.entries(params.permissions ?? {}).filter(([, value]) => value != null)) : {}, scope: "turn" };
    }
    if (method === "mcpServer/elicitation/request" && params.mode === "form"
        && params._meta?.codex_approval_kind === "mcp_tool_call"
        && params.requestedSchema?.type === "object"
        && params.requestedSchema.properties && Object.keys(params.requestedSchema.properties).length === 0
        && (params.requestedSchema.required === undefined || Array.isArray(params.requestedSchema.required) && params.requestedSchema.required.length === 0)) {
      // Codex uses an empty MCP form for a one-time tool-call approval.
      // This is not OAuth and is not permission to approve later calls.
      const parameters = params._meta.tool_params;
      // Words that will leave are shown as they are: who receives them, the subject and the whole text, not field names.
      const tool = approvedTool(params.message, params.serverName), send = tool ? sendAction(params.serverName, tool, parameters) : null;
      if (send) {
        const answers = await this.ask({ ...base, requestedBy, title: SEND_TITLE, detail: sendDetail(send), send, questions: [{ id: "decision", question: "", options: [SEND, DONT_SEND] }] });
        return { action: answers.decision === SEND ? "accept" : "decline", content: answers.decision === SEND ? {} : null, _meta: null };
      }
      const detail = [mcpApprovalMessage(params.message, params.serverName), parameters && Object.keys(parameters).length ? JSON.stringify(parameters, null, 2) : null].filter(Boolean).join("\n\n");
      const answers = await this.ask({ ...base, requestedBy, title: "Разрешить действие сервиса?", detail,
        questions: [{ id: "decision", question: "Только это действие", options: ["Разрешить", "Отказать"] }] });
      return { action: answers.decision === "Разрешить" ? "accept" : "decline", content: answers.decision === "Разрешить" ? {} : null, _meta: null };
    }
    if (method === "mcpServer/elicitation/request" && params.mode === "url") {
      const answers = await this.ask({ ...base, title: params.serverName, detail: params.message, url: safeURL(params.url), questions: [{ id: "decision", question: "Завершите подключение в браузере", options: ["Продолжить", "Отмена"] }] });
      return { action: answers.decision === "Продолжить" ? "accept" : "decline", content: null, _meta: null };
    }
    // Never silently accept unfamiliar permissions or guess a provider's schema.
    throw new Error("Этот тип запроса пока не поддерживается OpenStrudel; действие не разрешено");
  }
}

// Translate only Codex's known UI template. Keep unfamiliar provider text intact;
// never infer or hide which action the owner is being asked to approve.
function mcpApprovalMessage(message: unknown, server: unknown): unknown {
  const tool = approvedTool(message, server);
  return tool ? `Сервис «${server}» выполнит действие «${tool}».` : message;
}

/** The tool named by Codex's own approval sentence; null for any other wording. */
export function approvedTool(message: unknown, server: unknown): string | null {
  if (typeof message !== "string" || typeof server !== "string") return null;
  const prefix = `Allow the ${server} MCP server to run tool "`;
  if (!message.startsWith(prefix) || !message.endsWith('"?')) return null;
  const tool = message.slice(prefix.length, -2);
  return /^[A-Za-z0-9_.:-]+$/.test(tool) ? tool : null;
}

export const SEND_TITLE = "Отправить сообщение?", SEND = "Отправить", DONT_SEND = "Не отправлять";
const TEXT_KEYS = ["text", "body", "message", "content", "html", "caption", "comment"];
const TO_KEYS = ["to", "recipient", "recipients", "chat", "chat_id", "chatid", "chat_name", "channel", "email", "address", "peer", "username", "user", "phone"];
const SUBJECT_KEYS = ["subject", "title"];
const plainValue = (value: unknown): string => value == null ? "" : typeof value === "string" ? value.trim() : typeof value !== "object" ? String(value)
  : Array.isArray(value) ? value.map(plainValue).filter(Boolean).join(", ") : Object.entries(value).map(([key, item]) => `${key}: ${plainValue(item)}`).join("; ");
const plainLabel = (key: string) => { const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().toLowerCase(); return words.charAt(0).toUpperCase() + words.slice(1); };

/** A service action that sends words to someone: a sending verb in the tool's name, a recipient and a text among its arguments.
 * Everything else the action carries is kept as plain facts, so nothing it will do is hidden. Null: not a send, shown as before. */
export function sendAction(server: unknown, tool: string, params: unknown): SendAction | null {
  if (typeof server !== "string" || !params || typeof params !== "object" || Array.isArray(params)) return null;
  const words = tool.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z]+/);
  if (!(words.includes("send") || !words.includes("draft") && words.some(word => ["reply", "respond", "forward", "publish", "post"].includes(word)))) return null;
  const entries = Object.entries(params as Record<string, unknown>), used = new Set<string>();
  const pick = (keys: string[]) => { for (const key of keys) { const found = entries.find(([name, value]) => name.toLowerCase() === key && plainValue(value)); if (found) { used.add(found[0]); return found[1]; } } return undefined; };
  const text = pick(TEXT_KEYS), to = plainValue(pick(TO_KEYS)), subject = plainValue(pick(SUBJECT_KEYS));
  if (typeof text !== "string" || !text.trim() || !to) return null;
  const details = entries.filter(([name, value]) => !used.has(name) && plainValue(value)).map(([name, value]) => ({ label: plainLabel(name), value: plainValue(value) }));
  return { server, tool, params: params as Record<string, unknown>, to, via: server, subject: subject || null, text, details };
}

/** The same card as plain lines, for a client that draws an approval as title, detail and choices. */
export function sendDetail(send: SendAction): string {
  const russian = /[А-Яа-яЁё]/.test(send.text + (send.subject ?? ""));
  return [`${russian ? "Кому" : "To"}: ${send.to} · ${send.via}`, send.subject ? `${russian ? "Тема" : "Subject"}: ${send.subject}` : "", "", send.text,
    ...send.details.length ? ["", ...send.details.map(detail => `${detail.label}: ${detail.value}`)] : []].filter((line, index, lines) => line || lines[index - 1]).join("\n");
}

export function safeURL(value: unknown): string {
  const url = new URL(String(value));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Небезопасная ссылка подключения");
  return url.toString();
}
