import { randomUUID } from "node:crypto";
import type { Interaction } from "./types.js";

type Pending = { card: Interaction; answers: Record<string, string>; resolve: (a: Record<string, string>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; validate?: (a: Record<string, string>) => Promise<void> };

/** A pending Codex question, tied to exactly one chat and message. */
export class Interactions {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(card: Interaction) => void>();
  private readonly settled = new Set<(card: Interaction) => void>();
  onSettled(listener: (card: Interaction) => void): void { this.settled.add(listener); }
  private finish(card: Interaction): void { for (const listener of this.settled) listener(card); }
  subscribe(listener: (card: Interaction) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  list(conversationId: string): Interaction[] { return [...this.pending.values()].filter(p => p.card.conversationId === conversationId).map(p => p.card); }
  get(id: string): Interaction | undefined { return this.pending.get(id)?.card; }
  ask(card: Omit<Interaction, "id">, validate?: Pending["validate"]): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); this.finish(complete); reject(new Error("Время ожидания ответа истекло. Действие не подтверждено.")); }, 30 * 60_000);
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
    clearTimeout(p.timer); this.pending.delete(id); this.finish(p.card); p.resolve(snapshot);
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
      const detail = [params.message, parameters && Object.keys(parameters).length ? JSON.stringify(parameters, null, 2) : null].filter(Boolean).join("\n\n");
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

export function safeURL(value: unknown): string {
  const url = new URL(String(value));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Небезопасная ссылка подключения");
  return url.toString();
}
