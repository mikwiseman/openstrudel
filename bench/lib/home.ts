import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import type { TelegramUpdate } from "../../src/telegram.js";
import type { CodexEngine, Interaction } from "../../src/types.js";
import { FakeTelegram } from "./telegram.js";
import { connectMemory, startMemory, type Memory } from "./memory.js";
import { BOT, CHATS, PEOPLE, SOUL, TIMEZONE, type Chat, type Person } from "./world.js";

/** What a trial may look at afterwards: the Home's own tables, read by the harness. Nothing here comes from the model's words. */
export interface Snapshot {
  /** Settings and switches as `table/key/field` → value. A change of setting is a changed line here. */
  config: Record<string, string>;
  schedules: Array<Record<string, any> & { id: string; nextRunAt: string; enabled: boolean; cron: string }>;
  runs: Array<Record<string, any>>;
  cards: Array<Record<string, any>>;
  /** Files of the model's workspaces, by path, with a hash: a note left behind is seen here. */
  files: Record<string, string>;
  /** How many Telegram and memory calls had been made when this was taken. */
  telegramCalls: number;
  memoryCalls: number;
  toolCalls: number;
}

/** Settings that move by themselves while a Home runs and say nothing about what an agent decided. */
const VOLATILE = /^(codex\.|context\.checkpoint\.|telegram\.(offset|transcript\.|membership\.|bot_|last_bot)|ask\.memories$|conversation\.context\.|statistics\.|schedule\.signed_out\.|operations\.|issues?\.|usage\.|engine\.)/;

export interface Home {
  root: string;
  runtime: OpenStrudelRuntime;
  telegram: FakeTelegram;
  memory: Memory;
  /** Approvals the Home asked a person for, and what the scripted user answered. */
  approvals: Array<{ title: string; detail: string; answer: string }>;
  say(who: Person, where: Chat, text: string, extra?: Record<string, unknown>): Promise<void>;
  press(who: Person, chatId: string, messageId: number, data: string): Promise<void>;
  /** Moves the clock to a moment and lets every schedule that is due run to its end. */
  tick(at: Date): Promise<void>;
  snapshot(toolCalls: number): Snapshot;
  stop(): Promise<void>;
}

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
function listFiles(directory: string, base = directory, found: Record<string, string> = {}): Record<string, string> {
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { return found; }
  for (const name of names) {
    const path = join(directory, name);
    // The Home's own export of a chat's history is not something an agent wrote.
    if (name === "history" || name === "node_modules" || name === ".git") continue;
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory()) listFiles(path, base, found); else if (stat?.isFile()) found[relative(base, path)] = hash(path);
  }
  return found;
}

/** One throwaway Home: its own folder and database, the fake Telegram, the fake memory, and the invented studio in it.
 * The engine is injected exactly as the repository's own integration tests inject theirs. */
export async function openHome(directory: string, engine: CodexEngine, options: { approve?: (interaction: Interaction) => boolean } = {}): Promise<Home> {
  const root = join(directory, "home"), state = join(directory, "state");
  mkdirSync(root, { recursive: true }); mkdirSync(state, { recursive: true });
  const telegram = new FakeTelegram(), restore = telegram.install(), memory = await startMemory();
  connectMemory(root, memory);
  for (const name of ["OPENSTRUDEL_SETUP_CODE", "OPENSTRUDEL_API_TOKEN", "OPENSTRUDEL_CODEX_MODE", "OPENSTRUDEL_METRICS_PORT", "OPENSTRUDEL_HOOKS_PORT", "OPENSTRUDEL_DB"]) delete process.env[name];
  // The adapter takes its bot from the environment only while it is built; no polling is ever started.
  process.env.TELEGRAM_BOT_TOKEN = "7001:strudelbench";
  let runtime: OpenStrudelRuntime;
  try { runtime = new OpenStrudelRuntime({ rootDirectory: root, dbPath: join(state, "home.sqlite"), engine, startTelegram: false, apiToken: "bench", mobilePort: 0 }); }
  finally { delete process.env.TELEGRAM_BOT_TOKEN; }
  const store = runtime.store;
  store.setSetting("telegram.bot_username", BOT.username); store.setSetting("telegram.bot_name", BOT.name);
  store.setSetting("owner.timezone", TIMEZONE); store.setSetting("main.soul", SOUL);
  // The owner works without confirmations, as Homes in use do: a connected service is read without a prompt, also by a
  // scheduled run, which can never wait for one. What is sent to people is still the agent's own decision and the cards'.
  store.setSetting("agents.approval_mode", "approve_all");
  store.setSetting("access.managers", JSON.stringify([String(PEOPLE.admin.id)]));
  store.setSetting("access.people", JSON.stringify([String(PEOPLE.colleague.id)]));
  store.linkTelegramChat({ chatId: CHATS.dm.id, title: CHATS.dm.title, allowedSenders: [String(PEOPLE.owner.id)] });
  const everyone = Object.values(PEOPLE).map(person => String(person.id));
  for (const [chat, senders] of [[CHATS.team, everyone], [CHATS.family, [String(PEOPLE.owner.id)]], [CHATS.nordwind, [String(PEOPLE.owner.id)]], [CHATS.halden, [String(PEOPLE.owner.id)]]] as const) {
    store.linkTelegramChat({ chatId: chat.id, title: chat.title, allowedSenders: [...senders] });
    store.connectTelegramGroup(chat.id);
  }

  // The scripted user answers every approval at once: a read of the studio's records is allowed, anything else is refused.
  const approvals: Home["approvals"] = [];
  const approve = options.approve ?? (interaction => /«records»[^«]*«(recall|read_record)»/.test(interaction.detail ?? ""));
  runtime.messages.interactions.subscribe(interaction => {
    const yes = approve(interaction), answers = Object.fromEntries(interaction.questions.map(question => [question.id, question.options.length ? question.options[yes ? 0 : question.options.length - 1]! : yes ? "yes" : "no"]));
    approvals.push({ title: interaction.title, detail: (interaction.detail ?? "").slice(0, 400), answer: yes ? "allowed" : "refused" });
    queueMicrotask(() => { void runtime.messages.interactions.answer(interaction.id, interaction.conversationId, answers).catch(() => undefined); });
  });

  let updateId = 1000;
  const person = (who: Person) => ({ id: PEOPLE[who].id, first_name: PEOPLE[who].name });
  const group = (chatId: string) => Object.values(CHATS).find(chat => chat.id === chatId);
  const chatOf = (chatId: string) => ({ id: Number(chatId), type: Number(chatId) > 0 ? "private" : "group", ...(Number(chatId) < 0 ? { title: group(chatId)?.title ?? "Group" } : {}) });
  const process_ = (update: TelegramUpdate) => runtime.telegram.processUpdate(update);

  return {
    root, runtime, telegram, memory, approvals,
    async say(who, where, text, extra = {}) {
      // In a private chat the person speaks from their own chat with the bot.
      const chatId = where === "dm" ? String(PEOPLE[who].id) : CHATS[where].id;
      await process_({ update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), from: person(who), chat: chatOf(chatId), text, ...extra } } as TelegramUpdate);
    },
    async press(who, chatId, messageId, data) {
      await process_({ update_id: ++updateId, callback_query: { id: "q" + updateId, from: person(who), data, message: { message_id: messageId, chat: { id: Number(chatId) } } } } as TelegramUpdate);
    },
    async tick(at) { await runtime.scheduler.tick(at); await runtime.scheduler.idle(); },
    snapshot(toolCalls) {
      const config: Record<string, string> = {};
      for (const row of store.db.prepare("SELECT key,value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>) if (!VOLATILE.test(row.key)) config[`settings/${row.key}`] = row.value;
      for (const chat of store.telegramChats()) for (const [field, value] of Object.entries({ title: chat.title, profileId: chat.profileId, enabled: chat.enabled !== false, access: chat.access, replies: chat.replies, transcripts: chat.transcripts, allowedSenders: chat.allowedSenders.join(",") }))
        config[`chats/${chat.chatId}/${field}`] = String(value);
      for (const profile of store.listProfiles()) for (const field of ["name", "instructions", "purpose", "model", "reasoningEffort"] as const) config[`employees/${profile.id}/${field}`] = String(profile[field] ?? "");
      const schedules = runtime.scheduler.list().map(schedule => ({ ...schedule }));
      for (const schedule of schedules) for (const field of ["name", "prompt", "cron", "timezone", "enabled", "telegramChatId", "delivery", "conversationId"] as const) config[`schedules/${schedule.id}/${field}`] = String(schedule[field] ?? "");
      return { config, schedules,
        runs: store.db.prepare("SELECT id,schedule_id,status,scheduled_for,error FROM schedule_runs ORDER BY created_at,rowid").all() as Array<Record<string, any>>,
        cards: (store.db.prepare("SELECT * FROM cards ORDER BY created_at,rowid").all() as Array<Record<string, any>>).map(row => ({ id: row.id, kind: row.kind, state: row.state, chatId: row.chat_id, telegramMessageId: row.telegram_message_id,
          title: row.title, reason: row.reason, content: JSON.parse(String(row.content_json)), choices: JSON.parse(String(row.choices_json)), answer: row.answer_json ? JSON.parse(String(row.answer_json)) : null })),
        files: listFiles(join(root, ".data/workspace")), telegramCalls: telegram.calls.length, memoryCalls: memory.calls.length, toolCalls };
    },
    async stop() {
      try { await runtime.stop(); } finally { await memory.close(); restore(); }
    },
  };
}
