import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store.js";
import { ConversationFiles } from "../src/files.js";
import { documentSigningTools } from "../src/document-signing.js";
import { employeeTools } from "../src/personality.js";
import { Interactions } from "../src/interactions.js";
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
  const context: TelegramToolContext = { conversationId: chat.id, messageId: "current-request", channel: "telegram", telegramSenderId: "42", scope, files };
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

it("does not let another paired owner use the configured owner's signature", async () => {
  const f = fixture(); f.store.linkTelegramChat({ chatId: "77", title: "Other owner", allowedSenders: ["77"] });
  const tools = documentSigningTools(f.store, { ...f.context, telegramSenderId: "77" });
  expect(tools.definitions).toEqual([]);
  await expect(tools.call({ action: "inspect", path: "contract.pdf" })).rejects.toThrow("Telegram-аккаунту");
  expect(execute).not.toHaveBeenCalled();
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
