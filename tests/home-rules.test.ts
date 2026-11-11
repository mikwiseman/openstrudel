import { afterEach, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { MessageService } from "../src/messages.js";
import { INSTRUCTIONS } from "../src/codex.js";
import { agentInstructions } from "../src/claude.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

/** A Home with a paired owner (7), a second administrator (9), a member (11), a team group of the main assistant and a writer's group. */
function home(act: (input: string, call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<string | void> = async () => {}) {
  const store = new Store(":memory:"); stores.push(store);
  store.linkTelegramChat({ chatId: "7", title: "Owner", allowedSenders: ["7"] });
  store.linkTelegramChat({ chatId: "-100", title: "Team", allowedSenders: ["7", "9", "11"] });
  store.linkTelegramChat({ chatId: "-200", title: "Writers", allowedSenders: ["7"] });
  store.setSetting("access.managers", JSON.stringify(["9"]));
  const writer = store.createProfile({ name: "Writer", instructions: "Пиши коротко." });
  store.bindTelegramChat("-200", writer.id);
  const turns: Array<{ input: string; profile: string; tools: string[] }> = [];
  const service = new MessageService(store, { async run(input, options) {
    turns.push({ input, profile: String(options?.profile ?? ""), tools: (options?.tools?.definitions ?? []).map(t => t.name) });
    const answer = await act(input, (name, args) => options!.tools!.call(name, args));
    return { threadId: "t" + turns.length, response: answer ?? "Готово", events: [] };
  } });
  let update = 0;
  const say = (chat: string, sender: string, text: string) =>
    service.handle({ channel: "telegram", externalChatId: chat, externalId: `${chat}:${++update}`, telegramSenderId: sender, author: "Person " + sender, title: chat, text });
  return { store, service, writer, turns, say };
}

it("lets an administrator give a standing rule in a group, reads it back in one line, and puts it in every later turn of the Home", async () => {
  const rule = "Черновики и сообщения людям никогда не подписывай как написанные AI.";
  let saved: any, soul = "";
  const { store, service, writer, turns, say } = home(async (input, call) => {
    if (!input.includes("Запомни правило")) return;
    // The SOUL every chat shares is not rewritten from a group; the refusal names the tool that is.
    soul = await call("update_employee", { name: "OpenStrudel", instructions: "Без подписей." }).then(() => "saved", (error: Error) => error.message);
    saved = await call("save_home_rule", { text: rule });
    return saved.readBack;
  });
  // The second administrator says it in the team group, which the main assistant serves.
  expect(await say("-100", "9", "@bot Запомни правило: никаких подписей про AI.")).toMatchObject({ text: `Правило для всего Home: ${rule}` });
  expect(saved).toMatchObject({ saved: true, readBack: `Правило для всего Home: ${rule}` });
  expect(soul).toContain("save_home_rule");
  expect(store.getSetting("main.soul")).toBeNull();
  const team = store.getOrCreateConversation({ channel: "telegram", externalId: "-100", title: "Team" });
  expect(store.listMessages(team.id).filter(m => m.kind === "notice").map(m => m.text)).toEqual([`Правило для всего Home: ${rule}`]);
  // Every later turn reads it: the owner's private chat, an employee's group, the app, a schedule.
  await say("7", "7", "Как дела?");
  await say("-200", "7", "@bot что нового?");
  await service.handle({ channel: "api", text: "Сводка", byOwner: true });
  await service.handle({ channel: "api", profile: writer.id, text: "Scheduled request: Утро", scheduled: true });
  for (const turn of turns.slice(1)) {
    expect(turn.profile).toContain("Standing rules of this Home");
    expect(turn.profile).toContain(rule);
  }
  // Rules come after the SOUL and win over it.
  expect(turns[2]!.profile.indexOf("Пиши коротко.")).toBeLessThan(turns[2]!.profile.indexOf(rule));
});

it("keeps rules with the Home's administrators: a member or a schedule cannot add one, and removing one takes it out of every turn", async () => {
  let removed: any;
  const { store, turns, say, service } = home(async (input, call) => {
    if (input.includes("Новое правило")) return call("save_home_rule", { text: "Пиши стихами." }).then(() => "ok", (error: Error) => error.message);
    if (input.includes("Сними правило")) { removed = await call("remove_home_rule", { id: JSON.parse(store.getSetting("home.rules")!)[0].id }); return removed.readBack; }
  });
  expect(await say("-100", "11", "@bot Новое правило")).toMatchObject({ text: "Tool unavailable for this employee" });
  expect(turns[0]!.tools).not.toContain("save_home_rule");
  await service.handle({ channel: "api", text: "Scheduled request: Новое правило", scheduled: true });
  expect(turns[1]!.tools).not.toContain("save_home_rule");
  expect(store.getSetting("home.rules")).toBeNull();
  await say("7", "7", "Новое правило");
  expect(JSON.parse(store.getSetting("home.rules")!).map((r: { text: string }) => r.text)).toEqual(["Пиши стихами."]);
  expect(await say("7", "7", "Сними правило")).toMatchObject({ text: "Правило снято: Пиши стихами." });
  await say("-100", "9", "@bot как дела?");
  expect(turns.at(-1)!.profile).not.toContain("Пиши стихами.");
});

it("makes a message to another person a draft unless the request clearly says to send it, on every engine", () => {
  for (const instructions of [INSTRUCTIONS, agentInstructions()]) {
    expect(instructions).toMatch(/A message to another person is a draft unless the request clearly says to send it/);
    expect(instructions).toContain("«напиши», «ответь», «предложи» mean a draft");
    expect(instructions).toContain("no note that an AI wrote it");
    expect(instructions).toContain("save_home_rule");
  }
});
