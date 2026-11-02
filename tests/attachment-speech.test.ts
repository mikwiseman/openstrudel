import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { runtimeIssues } from "../src/operations.js";

vi.mock("../src/voice.js", () => ({ transcribeVoice: vi.fn(async () => { throw new Error("Речь не распознана. Попробуйте записать сообщение ещё раз."); }) }));

const roots: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function service(prompts: string[], response = "Видно экран настроек.") {
  const root = mkdtempSync(join(tmpdir(), "attachment-speech-")); roots.push(root);
  const store = new Store(":memory:");
  const messages = new MessageService(store, { async run(input) { prompts.push(input); return { threadId: "t", response, events: [] }; } }, root);
  return { store, messages };
}

/** The owner's established Telegram chat and a team group, on a Home whose speech server answers with `recognizer`. */
function telegram(prompts: string[], recognizer: () => Response, response?: string) {
  vi.stubEnv("OPENSTRUDEL_STT_URL", "https://stt.example.test");
  const { store, messages } = service(prompts, response);
  const adapter = new TelegramAdapter("123:test", store, messages); messages.telegram = adapter;
  store.linkTelegramChat({ chatId: "42", title: "Owner", allowedSenders: ["42"] });
  store.getOrCreateConversation({ channel: "telegram", externalId: "42", title: "Owner" });
  store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["42", "7"] }); store.connectTelegramGroup("-100");
  const sent: Array<{ chat: string; text: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://stt.example.test/v1/speech-to-text") return recognizer();
    if (url.includes("/file/")) return new Response(new Uint8Array([1, 2, 3]));
    if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "videos/file_1.mp4", file_size: 3 } });
    if (url.endsWith("/sendMessage")) { const body = JSON.parse(String(init!.body)); sent.push({ chat: String(body.chat_id), text: body.text }); }
    return Response.json({ ok: true, result: { message_id: 99 } });
  }));
  // The owner writes in their own chat; a member, in the group.
  const send = (chat: 42 | -100, media: object) => adapter.processUpdate({ update_id: 1, message: { message_id: 1, from: { id: chat > 0 ? 42 : 7, is_bot: false }, chat: { id: chat, type: chat > 0 ? "private" : "group" }, ...media } });
  const request = (chat: 42 | -100) => store.findMessageByExternal("telegram", chat + ":1");
  return { store, messages, sent, send, request };
}

it("answers about a video without speech instead of failing the whole request", async () => {
  const prompts: string[] = [];
  const { store, messages } = service(prompts);
  try {
    const result = await messages.handle({ channel: "api", text: "Что на этой записи экрана?", uploads: [{ id: "00000000-0000-4000-8000-000000000001", name: "screen.mp4", mimeType: "video/mp4", contentBase64: "AQID" }] });
    expect(result.text).toBe("Видно экран настроек.");
    expect(prompts[0]).toContain("screen.mp4");
    expect(prompts[0]).toContain("Что на этой записи экрана?");
  } finally { await messages.close(); store.close(); }
});

it("answers about a lone video without speech, sent with no words, and reports no problem", async () => {
  const prompts: string[] = [];
  const { store, messages } = service(prompts);
  try {
    const result = await messages.handle({ channel: "api", text: "", uploads: [{ id: "00000000-0000-4000-8000-000000000003", name: "screen.mov", mimeType: "video/quicktime", contentBase64: "AQID" }] });
    expect(result.text).toBe("Видно экран настроек.");
    expect(prompts[0]).toContain('"screen.mov" (video/quicktime)');
    expect(runtimeIssues(store)).toEqual([]);
  } finally { await messages.close(); store.close(); }
});

it("still explains an unrecognized voice note sent on its own", async () => {
  const prompts: string[] = [];
  const { store, messages } = service(prompts);
  try {
    await expect(messages.handle({ channel: "api", text: "", uploads: [{ id: "00000000-0000-4000-8000-000000000002", name: "voice.m4a", mimeType: "audio/mp4", contentBase64: "AQID" }] })).rejects.toThrow("Речь не распознана");
    expect(prompts).toEqual([]);
  } finally { await messages.close(); store.close(); }
});

it.each([
  ["hears no speech", () => Response.json({ text: "" })],
  ["fails", () => new Response("busy", { status: 503 })],
])("answers about a lone Telegram video whose recognizer %s, and reports no problem", async (_, answer) => {
  const prompts: string[] = [], recognizer = vi.fn(answer);
  const { store, messages, sent, send, request } = telegram(prompts, recognizer);
  try {
    await send(42, { video: { file_id: "video", file_size: 3, mime_type: "video/mp4" } });
    // A video is a file first: the employee opens it like any other attachment.
    expect(request(42)).toMatchObject({ status: "completed", text: "", attachments: [{ name: "video.mp4", mimeType: "video/mp4", size: 3 }] });
    expect(prompts).toEqual([expect.stringContaining('"video.mp4" (video/mp4)')]);
    expect(sent).toEqual([{ chat: "42", text: "Видно экран настроек." }]);
    expect(runtimeIssues(store)).toEqual([]);
    // Heard once, on arrival: the turn does not wait for the same recording again.
    expect(recognizer).toHaveBeenCalledOnce();
  } finally { await messages.close(); store.close(); }
});

it("answers about a screen recording sent as a file without speech", async () => {
  const prompts: string[] = [];
  const { store, messages, sent, send, request } = telegram(prompts, () => Response.json({ text: "" }));
  try {
    await send(42, { document: { file_id: "screen", file_size: 3, file_name: "screen.mov", mime_type: "video/quicktime" } });
    expect(request(42)).toMatchObject({ status: "completed", attachments: [{ name: "screen.mov", mimeType: "video/quicktime" }] });
    expect(prompts).toEqual([expect.stringContaining('"screen.mov" (video/quicktime)')]);
    expect(sent).toEqual([{ chat: "42", text: "Видно экран настроек." }]);
  } finally { await messages.close(); store.close(); }
});

it("keeps a captionless group video without speech as shared context and tells the owner nothing", async () => {
  const prompts: string[] = [];
  const { store, messages, sent, send, request } = telegram(prompts, () => Response.json({ text: "" }), "NO_REPLY");
  try {
    await send(-100, { video: { file_id: "video", file_size: 3 } });
    expect(request(-100)).toMatchObject({ status: "completed", attachments: [{ name: "video.mp4", mimeType: "video/mp4" }] });
    expect(prompts).toEqual([expect.stringContaining('"attachmentOnly":true')]);
    expect(sent).toEqual([]);
    expect(runtimeIssues(store)).toEqual([]);
  } finally { await messages.close(); store.close(); }
});

it.each([
  ["voice note", { voice: { file_id: "voice", file_size: 3 } }],
  ["audio", { audio: { file_id: "audio", file_size: 3 } }],
  ["round video note", { video_note: { file_id: "note", file_size: 3 } }],
  ["audio file", { document: { file_id: "file", file_size: 3, file_name: "meeting.m4a", mime_type: "audio/mp4" } }],
])("still fails a lone Telegram %s without speech and says why in the owner's chat", async (_, media) => {
  const prompts: string[] = [];
  const { store, messages, sent, send, request } = telegram(prompts, () => Response.json({ text: "" }));
  try {
    await send(42, media);
    expect(prompts).toEqual([]);
    expect(request(42)).toMatchObject({ status: "failed", error: "Речь не распознана. Попробуйте записать сообщение ещё раз.", attachments: [] });
    expect(sent).toEqual([{ chat: "42", text: "Речь не распознана. Попробуйте записать сообщение ещё раз." }]);
  } finally { await messages.close(); store.close(); }
});

it("still makes the speech in a Telegram video its request", async () => {
  const prompts: string[] = [];
  const { store, messages, sent, send, request } = telegram(prompts, () => Response.json({ text: "Что не так на этом экране?" }));
  try {
    await send(42, { video: { file_id: "video", file_size: 3 } });
    expect(sent).toEqual([{ chat: "42", text: "📝 Что не так на этом экране?" }, { chat: "42", text: "Видно экран настроек." }]);
    expect(prompts).toEqual([expect.stringContaining("Что не так на этом экране?")]);
    expect(request(42)).toMatchObject({ status: "completed", text: "Что не так на этом экране?", attachments: [] });
  } finally { await messages.close(); store.close(); }
});
