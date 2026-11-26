import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store.js";
import { ConversationFiles } from "../src/files.js";
import { documentSigningTools } from "../src/document-signing.js";
import { employeeTools } from "../src/personality.js";
import { Interactions } from "../src/interactions.js";
import { MessageService } from "../src/messages.js";
import { TelegramAdapter } from "../src/telegram.js";
import { authorizationSetting } from "../src/authorization.js";
import type { TelegramToolContext } from "../src/telegram-tools.js";

// No signing executable or signature assets are used by these tests.
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});

const fixtures: Array<{ store: Store; root: string }> = [];
afterEach(() => {
  execute.mockReset();
  for (const { store, root } of fixtures.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); }
});

function fixture(group = false) {
  const root = mkdtempSync(join(tmpdir(), "document-signing-")), store = new Store(":memory:");
  fixtures.push({ store, root });
  const owner = store.getOrCreateConversation({ channel: "telegram", externalId: "42", title: "Owner" });
  const chat = group ? store.getOrCreateConversation({ channel: "telegram", externalId: "-100", title: "Team" }) : owner;
  for (const conversation of group ? [owner, chat] : [owner]) {
    store.linkTelegramChat({ chatId: conversation.externalId!, title: conversation.title!, allowedSenders: ["42"] });
    store.db.prepare("UPDATE telegram_chats SET conversation_id=? WHERE chat_id=?").run(conversation.id, conversation.externalId!);
  }
  const directory = join(root, ".data/sign-document"), files = new ConversationFiles(store, root);
  mkdirSync(join(directory, "scripts"), { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ telegramUserId: "42" }), { mode: 0o600 });
  writeFileSync(join(directory, "scripts/docsign.py"), "# Synthetic fixture. Must never execute.\n", { mode: 0o600 });
  writeFileSync(join(directory, "SKILL.md"), "Synthetic document instructions.", { mode: 0o600 });
  const scope = group ? "group-" + "a".repeat(64) : "personal", workspace = files.workspace(scope);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const source = join(workspace, "contract.pdf");
  writeFileSync(source, "%PDF-synthetic-original\n", { mode: 0o600 });
  const context: TelegramToolContext = { conversationId: chat.id, messageId: "current-request", channel: "telegram", telegramSenderId: "42", telegramDirectText: "Please sign and stamp the attached document.", scope, files };
  return { root, store, directory, workspace, source, context, chat };
}

function fakeDocumentWork(_file: string, args: string[]) {
  const action = args[3];
  if (action === "inspect") writeFileSync(args[6]!, JSON.stringify({ source: args[4], pages: 1, zones: [] }));
  if (action === "apply") {
    const plan = JSON.parse(readFileSync(args[5]!, "utf8"));
    writeFileSync(plan.output, "SYNTHETIC OUTPUT; NO SIGNATURE");
  }
  if (action === "preview") { mkdirSync(args[6]!); writeFileSync(join(args[6]!, "page-1.png"), "SYNTHETIC PREVIEW"); }
  return { stdout: "", stderr: "" };
}

it.each([false, true])("registers signing for the configured owner's current Telegram request (group=%s)", async group => {
  const f = fixture(group);
  execute.mockImplementation(fakeDocumentWork);
  const tools = employeeTools(f.store, { async run() { return { response: "unused", events: [] }; } }, new Interactions(), { ...f.context, profile: null });
  expect(tools.definitions.find(tool => tool.name === "sign_document")).toBeDefined();
  const result = await tools.call("sign_document", { action: "inspect", path: "contract.pdf" });
  expect(result).toEqual({ report: { source: "contract.pdf", pages: 1, zones: [] }, instructions: "Synthetic document instructions." });
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]![0]).toBe("python3");
  expect(execute.mock.calls[0]![1].slice(0, 4)).toEqual(["-I", resolve("scripts/document-signing.py"), f.directory, "inspect"]);
  expect(execute.mock.calls[0]![2]).toMatchObject({ timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  expect(readdirSync(join(f.directory, "jobs"))).toEqual([]);
});

it.each([
  ["missing direct request", { telegramDirectText: undefined }],
  ["other business", { telegramDirectText: "Please prepare a Word notice with room for the signature and stamp." }],
  ["negation", { telegramDirectText: "Please do not sign this." }],
  ["negative request", { telegramDirectText: "Не надо подписывать это заявление." }],
  ["negative stamp", { telegramDirectText: "Do not stamp this." }],
  ["general capability", { telegramDirectText: "Can you sign documents?" }],
  ["question about capabilities", { telegramDirectText: "Можешь рассказать, как подписать документ и поставить печать?" }],
  ["question about another person", { telegramDirectText: "Should Olga sign the contract?" }],
  ["conditional", { telegramDirectText: "If legal approves, sign it." }],
  ["approval clause", { telegramDirectText: "Можешь составить документ и подписать его после моего согласования?" }],
  ["conditional compound", { telegramDirectText: "Could you draft the notice and sign it once I approve?" }],
  ["reported Russian request", { telegramDirectText: "Можешь составить письмо и попросить Андрея проверить и подписать его?" }],
  ["reported English request", { telegramDirectText: "Can you prepare the document asking Andrew to review and sign it?" }],
  ["another signer", { telegramDirectText: "Prepare a cancellation notice for Andrew to review and sign it." }],
  ["another signer in Russian", { telegramDirectText: "Можешь составить документ для юриста, который должен проверить и подписать его?" }],
  ["conditional approval", { telegramDirectText: "Draft the termination letter and sign it after I approve." }],
  ["spoken quote", { telegramDirectText: "Please draft the note ‘sign and stamp it’ for Andrew." }],
  ["reported instruction", { telegramDirectText: "Подготовь письмо о том, что надо поставить дату и подпиши его — это слова клиента." }],
  ["negated compound", { telegramDirectText: "Could you draft the document and not sign or stamp it?" }],
  ["negated Russian compound", { telegramDirectText: "Можешь составить документ и подписать его не надо, поставим печать позже." }],
  ["unsigned original", { telegramDirectText: "Prepare the document without signing it and send it to me." }],
  ["quoted phrase", { telegramDirectText: "Ирина сказала: «Подпиши договор»." }],
  ["reported request", { telegramDirectText: "Pavel wrote: sign the document." }],
  ["Telegram addressed to a colleague", { telegramDirectText: "Гриша, подпиши этот договор." }],
  ["unrelated sign in", { telegramDirectText: "Please sign in to Telegram." }],
  ["API owner flag", { channel: "api", byOwner: true }],
  ["scheduled owner", { scheduled: true }],
  ["unpaired sender", { telegramSenderId: "77" }],
  ["missing sender", { telegramSenderId: undefined }],
  ["missing workspace scope", { scope: undefined }],
  ["missing file service", { files: undefined }],
] as Array<[string, Partial<TelegramToolContext>]>)('does not expose signing to %s', async (_label, overrides) => {
  const f = fixture();
  const tools = documentSigningTools(f.store, { ...f.context, ...overrides });
  expect(tools.definitions).toEqual([]);
  await expect(tools.call({ action: "inspect", path: "contract.pdf", telegramSenderId: "42" })).rejects.toThrow("Telegram-аккаунту");
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  "Хорошо, а теперь заполни дату сегодняшним числом и подпиши ее с помощью скилла и поставь печать с помощью скилла.",
  "Подпиши, пожалуйста, договор.", "Поставь печать на заявлении.", "Stamp it.", "Could you please sign this contract?",
  "Можешь подписать этот документ и поставить печать?", "Можешь подписать?", "Можешь поставить печать?",
  "Can you sign this?", "Please sign and stamp it.", "Wolf, sign this document.",
  "Можешь составить документ, подписать его и поставить печать?",
  "Подготовь заявление и подпиши его.",
  "Could you draft the notice and sign and stamp it?",
  "Prepare the document, then sign it and send it here.",
  "Можешь подготовить заявление по договору А-123 и подписать его?",
  "Please prepare the Example Telecom termination notice for contract A-123 and sign it.",
  "Please sign this document and send it back here when you're done.",
  "Please sign this notice about the period after termination.",
])("recognizes an explicit request from the configured signer: %s", telegramDirectText => {
  const f = fixture();
  expect(documentSigningTools(f.store, { ...f.context, telegramDirectText }).definitions).toHaveLength(1);
});

it.each([false, true])("grants signing only on the first of two successive owner voice messages (group=%s)", async group => {
  const f = fixture(group), offered: boolean[] = [];
  const messages = new MessageService(f.store, { async run(_text, options) {
    offered.push(!!options?.tools?.definitions.some(tool => tool.name === "sign_document"));
    return { threadId: "voice-thread", response: "NO_REPLY", events: [] };
  } }, f.root);
  const adapter = new TelegramAdapter("123:test", f.store, messages);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/file/") ? new Response("voice") : Response.json({ok:true,result:url.endsWith("getFile") ? {file_path:"voice.ogg"} : {message_id:100}})));
  adapter.transcribe = vi.fn().mockResolvedValueOnce("В почте есть образец заявления. Можешь составить документ и подписать и поставить печать.")
    .mockResolvedValueOnce("А потом пришли его сюда, я посмотрю.");
  try {
    for (const id of [1,2]) await adapter.processUpdate({ update_id:id, message:{
      from:{id:42}, chat:{id:group ? -100 : 42,type:group ? "group" : "private"}, message_id:id, voice:{ file_id:"voice" },
    } });
    expect(offered).toEqual([true,false]);
    expect(execute).not.toHaveBeenCalled();
  } finally { adapter.stop(); await messages.close(); vi.unstubAllGlobals(); }
});

it("offers the signer on an owner's direct group reply and dictated request, then withdraws it on a forwarded turn", async () => {
  const f = fixture(true), offered: boolean[] = [];
  const messages = new MessageService(f.store, { async run(_text, options) {
    offered.push(!!options?.tools?.definitions.some(tool => tool.name === "sign_document"));
    return { threadId: "test", response: "NO_REPLY", events: [] };
  } }, f.root);
  const adapter = new TelegramAdapter("123:test", f.store, messages);
  f.store.setSetting("telegram.bot_username", "wolf_test_bot");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/file/") ? new Response("voice") : Response.json({ok:true,result:url.endsWith("getFile") ? {file_path:"voice.ogg"} : {message_id:100}})));
  adapter.transcribe = async () => "Хорошо, а теперь заполни дату сегодняшним числом и подпиши ее с помощью скилла и поставь печать с помощью скилла.";
  const turn = (id: number, extra: Record<string, unknown>) => adapter.processUpdate({ update_id:id, message:{
    from:{id:42}, chat:{id:-100,type:"group"}, message_id:id, ...extra,
  } });
  try {
    await turn(1,{ text:"@wolf_test_bot, could you sign this?", reply_to_message:{ message_id:9, caption:"Third-party document", from:{id:7} } });
    await turn(2,{ voice:{file_id:"voice"} });
    await turn(3,{ text:"Please sign this.", forward_origin:{type:"user",sender_user:{id:42}} });
    await turn(4,{ text:"Look at this.", reply_to_message:{ message_id:1, from:{id:42}, text:"Sign this." }, quote:{text:"Sign this."} });
    expect(offered).toEqual([true,true,false,false]);
    expect(execute).not.toHaveBeenCalled();
  } finally { adapter.stop(); await messages.close(); vi.unstubAllGlobals(); }
});

it("does not let another paired owner use the configured owner's signature", async () => {
  const f = fixture(); f.store.linkTelegramChat({ chatId: "77", title: "Other owner", allowedSenders: ["77"] });
  const tools = documentSigningTools(f.store, { ...f.context, telegramSenderId: "77" });
  expect(tools.definitions).toEqual([]);
  await expect(tools.call({ action: "inspect", path: "contract.pdf" })).rejects.toThrow("Telegram-аккаунту");
  expect(execute).not.toHaveBeenCalled();
});

it("makes the exact replied-to Telegram file available for the signer's first request about it", async () => {
  const f = fixture(true);
  const messages = new MessageService(f.store, { async run() { return { response: "NO_REPLY", events: [] }; } }, f.root);
  const adapter = new TelegramAdapter("123:test", f.store, messages);
  const document = { file_id: "distinct-source", file_name: "notice.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  const fetcher = vi.fn(async (url: string) => url.includes("/file/") ? new Response("original Word file")
    : Response.json({ ok: true, result: url.endsWith("getFile") ? { file_path: "documents/notice.docx" } : { message_id: 99 } }));
  vi.stubGlobal("fetch", fetcher);
  try {
    for (const [id, text] of [[51,"Read this."], [52,"Please sign this document."]] as const) {
      await adapter.processUpdate({ update_id: id, message: { message_id: id, from: { id: 42 }, chat: { id: -100, type: "group" },
        text, reply_to_message: { message_id: 44, document, from: { id: 7 } } } });
    }
    expect(fetcher.mock.calls.filter(([url]) => url.includes("/file/"))).toHaveLength(1);
    const source = f.store.findMessageByExternal("telegram", "-100:52")?.attachments?.[0];
    expect(source?.name).toBe("notice.docx");
    expect(readFileSync(messages.files.get(source!.id)!.path, "utf8")).toBe("original Word file");
  } finally { adapter.stop(); await messages.close(); vi.unstubAllGlobals(); }
});

it.each(["disabled", "unbound", "restricted"])("keeps signing unavailable in a %s chat", async state => {
  const f = fixture(true);
  if (state === "disabled") f.store.setSetting("telegram.paused.-100", "true");
  if (state === "unbound") f.store.db.prepare("DELETE FROM telegram_chats WHERE chat_id=?").run("-100");
  if (state === "restricted") f.store.setSetting(authorizationSetting, JSON.stringify({ version: 1, revision: 1,
    connectors: { company: { url: "https://example.test/mcp", headers: {} } }, policies: { team: { connectorId: "company", tools: [] } }, subjects: {},
    chats: { "-100": { enabled: true, policyId: "team", defaultCapabilities: [], members: {} } } }));
  const tools = documentSigningTools(f.store, f.context);
  expect(tools.definitions).toEqual([]);
  await expect(tools.call({ action: "inspect", path: "contract.pdf" })).rejects.toThrow("Telegram-аккаунту");
  expect(execute).not.toHaveBeenCalled();
});

it("rechecks access after tool discovery and before opening a document", async () => {
  const f = fixture(), tools = documentSigningTools(f.store, f.context);
  expect(tools.definitions).toHaveLength(1);
  writeFileSync(join(f.directory, "config.json"), JSON.stringify({ telegramUserId: "77" }));
  await expect(tools.call({ action: "inspect", path: "contract.pdf" })).rejects.toThrow("Telegram-аккаунту");
  expect(execute).not.toHaveBeenCalled();
  expect(existsSync(join(f.directory, "jobs"))).toBe(false);
});

it.each(["absolute", "traversal", "symlink", "other workspace"])("rejects an unsafe %s source before invoking the private executable", async kind => {
  const f = fixture();
  const outside = join(f.root, "outside.pdf"); writeFileSync(outside, "PRIVATE OUTSIDE SOURCE");
  const other = join(f.context.files!.workspace("other"), "other.pdf"); mkdirSync(resolve(other, ".."), { recursive: true }); writeFileSync(other, "OTHER WORKSPACE");
  symlinkSync(outside, join(f.workspace, "link.pdf"));
  const path = kind === "absolute" ? outside : kind === "traversal" ? "../../../outside.pdf" : kind === "symlink" ? "link.pdf" : other;
  await expect(documentSigningTools(f.store, f.context).call({ action: "inspect", path })).rejects.toThrow("рабочей области");
  expect(execute).not.toHaveBeenCalled();
  expect(existsSync(join(f.directory, "jobs"))).toBe(false);
});

it("requires a reviewed placement plan and rejects model-supplied execution options", async () => {
  const f = fixture(), tools = documentSigningTools(f.store, f.context);
  await expect(tools.call({ action: "apply", path: "contract.pdf" })).rejects.toThrow("план размещения");
  await expect(tools.call({ action: "inspect", path: "contract.pdf", command: "other-script" })).rejects.toThrow();
  await expect(tools.call({ action: "apply", path: "contract.pdf", placements: [{ page: 1, asset: "../../private" }] })).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it("publishes new output and previews only inside the caller's workspace, preserving the original", async () => {
  const f = fixture(); execute.mockImplementation(fakeDocumentWork);
  const result = await documentSigningTools(f.store, f.context).call({ action: "apply", path: "contract.pdf", placements: [{ page: 1, asset: "signature" }] });
  expect(result).toMatchObject({ reviewRequired: true });
  const output = result as { path: string; previews: string[] };
  expect(output.path.startsWith(realpathSync(f.workspace) + "/signed-")).toBe(true);
  expect(readFileSync(output.path, "utf8")).toBe("SYNTHETIC OUTPUT; NO SIGNATURE");
  expect(output.previews).toHaveLength(1); expect(output.previews[0]!.startsWith(realpathSync(f.workspace) + "/signed-")).toBe(true);
  expect(readFileSync(f.source, "utf8")).toBe("%PDF-synthetic-original\n");
  expect(readdirSync(join(f.directory, "jobs"))).toEqual([]);
});

it.each(["apply", "preview"])("does not publish results when access is revoked during %s", async stage => {
  const f = fixture(true);
  execute.mockImplementation(async (file: string, args: string[]) => {
    const result = fakeDocumentWork(file, args);
    if (args[3] === stage) f.store.setSetting("telegram.paused.-100", "true");
    return result;
  });
  await expect(documentSigningTools(f.store, f.context).call({ action: "apply", path: "contract.pdf", placements: [{ page: 1, asset: "signature" }] })).rejects.toThrow("Telegram-аккаунту");
  expect(execute).toHaveBeenCalledTimes(stage === "apply" ? 1 : 2);
  expect(readdirSync(f.workspace)).toEqual(["contract.pdf"]);
  expect(readdirSync(join(f.directory, "jobs"))).toEqual([]);
});
