/** Telegram's side of a trial: the same fake the repository's tests use (a stubbed `fetch`), kept as a list of calls.
 * Everything the Home says to anyone passes through here, so "what left the Home" is read from this list, never from the model. */
export interface TelegramCall { n: number; phase: string; method: string; body: Record<string, any>; messageId?: number }
export interface Sent { n: number; phase: string; method: string; chatId: string; text: string; messageId?: number; buttons: Array<{ text: string; callback_data?: string; url?: string }> }

/** Methods that put words or files in front of people. */
const LEAVING = /^(send(?!ChatAction)\w+|editMessageText|editMessageCaption)$/;

export class FakeTelegram {
  readonly calls: TelegramCall[] = [];
  /** Requests to anything but Telegram or this machine: refused and listed. */
  readonly blocked: string[] = [];
  phase = "setup";
  private nextMessage = 500;
  private readonly real = globalThis.fetch;

  install(): () => void {
    globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
      const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.startsWith("https://api.telegram.org/file/")) return new Response("");
      if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: this.answer(url.split("/").at(-1)!, init.body) });
      if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)) return this.real(input, init);
      this.blocked.push(url.split("?")[0]!);
      throw new TypeError("StrudelBench: no live network in a trial");
    }) as typeof fetch;
    return () => { globalThis.fetch = this.real; };
  }

  private answer(method: string, raw: unknown): unknown {
    const body: Record<string, any> = typeof raw === "string" ? JSON.parse(raw)
      : raw instanceof FormData ? Object.fromEntries([...raw.entries()].map(([key, value]) => [key, typeof value === "string" ? value : { file: (value as File).name, size: (value as File).size }])) : {};
    const call: TelegramCall = { n: this.calls.length, phase: this.phase, method, body };
    this.calls.push(call);
    if (method === "getMe") return { id: 7001, is_bot: true, first_name: "Strudel", username: "tideline_bot" };
    if (method === "getUpdates") return [];
    if (method === "getFile") return { file_path: "file.bin" };
    if (/^send(?!ChatAction)/.test(method)) {
      call.messageId = ++this.nextMessage;
      const message = { message_id: call.messageId, chat: { id: Number(body.chat_id) } };
      return method === "sendPoll" ? { ...message, poll: { id: "poll-" + call.messageId } } : method === "sendMediaGroup" ? [message] : message;
    }
    return true;
  }

  /** What people in a chat were shown, in order: messages, captions and edits of a card. */
  sent(chatId?: string, untilCall = Infinity): Sent[] {
    return this.calls.filter(call => call.n < untilCall && LEAVING.test(call.method) && (chatId === undefined || String(call.body.chat_id) === chatId)).map(call => ({
      n: call.n, phase: call.phase, method: call.method, chatId: String(call.body.chat_id), messageId: call.messageId ?? call.body.message_id,
      text: [call.body.text, call.body.caption, call.body.rich_message?.html, call.body.question, ...(Array.isArray(call.body.options) ? call.body.options.map((o: any) => o?.text ?? o) : [])].filter(part => typeof part === "string").join("\n"),
      buttons: (call.body.reply_markup?.inline_keyboard ?? []).flat(),
    }));
  }
}
