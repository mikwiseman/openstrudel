/** Disposable UI server for the home and the team: two Homes with mock engines. The first has a main chat, a News desk with an
 * edition whose lead story carries a picture the fixture serves itself, a second desk named Startups whose edition has a name
 * of its own, and three ordinary employees: one working (its request is held until released), one whose latest scheduled run
 * failed, and one that gets a new result when the control port is asked. The control port can also make the main assistant
 * ask for an approval, so the chat shows a card. A Telegram group of the first Home is asked four questions every evening
 * but Saturday, and two people have answered them for eighteen days. The second Home has one employee. No real accounts or
 * Telegram: the subscription's limits are the only invented answer of the Home itself; scheduled runs stay quiet; every
 * name, company, story and number is invented. */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import { publishEdition, publishStory } from "../../src/news.js";
import { recordAnswer, recordPoll } from "../../src/check-ins.js";
import type { CodexEngine } from "../../src/types.js";

const output = resolve(process.argv[2]!);
const root = await mkdtemp(join(tmpdir(), "strudel-team-ui-"));
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.OPENSTRUDEL_SETUP_CODE;
/** The lead story's picture: an invented chart kept beside this file, served by the control port below. */
const chart = fileURLToPath(new URL("./assets/chart.png", import.meta.url));
/** A picture an employee attaches to its answer: an invented plate, kept as one of the Home's own files. */
const dish = fileURLToPath(new URL("./assets/dish.png", import.meta.url));

function home(name: string) {
  const directory = join(root, name === "Тестовый Mac" ? "first" : "second");
  mkdirSync(directory, { recursive: true });
  /** Chats whose requests wait until released: their employee is working. */
  const held = new Set<string>(), waiting: Array<() => void> = [];
  const engine: CodexEngine = {
    async run(input, options) {
      const message = input.split("Current user message:\n").at(-1)!.trim();
      options?.onEvent?.({ type: "thread.started", payload: { threadId: options.threadId ?? "team-thread" } });
      // A schedule that comes due while the fixture runs publishes nothing.
      if (input.includes("Scheduled request:")) return { threadId: options?.threadId ?? "team-thread", response: "NO_REPLY", events: [] };
      // The main assistant asks before a service acts, so the chat shows a card with its two answers.
      if (message.includes("Отправь письмо")) {
        const answer = await options!.onRequest!("mcpServer/elicitation/request", { mode: "form", serverName: "mail",
          message: 'Allow the mail MCP server to run tool "send_letter"?', _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { to: "partners@lodka.example", subject: "Условия аренды, версия 4" } },
          requestedSchema: { type: "object", properties: {} } }) as { action: string };
        return { threadId: options?.threadId ?? "team-thread", response: answer.action === "accept" ? "Отправил. Ответ придёт сюда же." : "Хорошо, не отправляю.", events: [] };
      }
      if (options?.conversationId && held.has(options.conversationId)) {
        await new Promise<void>(done => { waiting.push(done); options.signal?.addEventListener("abort", () => done(), { once: true }); });
        return { threadId: options.threadId ?? "team-thread", response: "Меню на неделю готово: семь ужинов и список покупок.", events: [] };
      }
      await new Promise(done => setTimeout(done, 400));
      return { threadId: options?.threadId ?? "team-thread", response: `Принято: ${message}`, events: [] };
    },
    async connections() { return []; },
    async connect() { return { url: "http://127.0.0.1/connect" }; },
  };
  const runtime = new OpenStrudelRuntime({ rootDirectory: directory, dbPath: ":memory:", engine, startTelegram: false, mobilePort: 0 });
  runtime.api.home.rename(name);
  Object.assign((runtime.api.mobile as any).options, { host: "127.0.0.1", hostname: "127.0.0.1" });
  runtime.account.read = async () => ({ connected: true, email: "preview@example.com", managed: true, planType: "plus" });
  const invite = async () => {
    const invitation = await runtime.api.mobile.invite(true);
    const link = new URL(invitation.url); link.searchParams.set("name", name);
    return { ...invitation, url: link.toString() };
  };
  return { runtime, held, release: () => { held.clear(); waiting.splice(0).forEach(done => done()); }, invite };
}

const first = home("Тестовый Mac"), second = home("Дачный Mac");
process.chdir(join(root, "first"));
const { runtime } = first, store = runtime.store;

const pad = (n: number) => String(n).padStart(2, "0");
/** A local wall-clock moment `daysAgo` days back, as the Home stores it. A moment of today that has not come yet is told
 * earlier today, in the same order, so the fixture reads the same whenever it is started. */
const at = (daysAgo: number, time: string) => {
  const [h, m] = time.split(":").map(Number), d = new Date();
  d.setDate(d.getDate() - daysAgo); d.setHours(h!, m!, 0, 0);
  if (d.getTime() <= Date.now()) return d.toISOString();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  return new Date(midnight.getTime() + (Date.now() - midnight.getTime()) * (h! * 60 + m!) / (24 * 60)).toISOString();
};
const day = (daysAgo: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** An answer written at a moment in the past. */
const said = (conversationId: string, createdAt: string, text: string, direction: "inbound" | "outbound" = "outbound") => {
  const message = store.addMessage({ conversationId, channel: "api", direction, text });
  store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(createdAt, message.id);
  return message;
};
const ran = (schedule: { id: string; conversationId: string }, scheduledFor: string, status: string, error: string | null = null) =>
  store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,error) VALUES(?,?,?,?,?,?,?)")
    .run(`fixture-${schedule.id}-${scheduledFor}`, schedule.id, schedule.conversationId, scheduledFor, status, scheduledFor, error);
/** A scheduled run with its whole retained chain, as the scheduler leaves it: the hidden request, the answer, the receipt.
 * The Home's activity reads results from exactly this. */
const produced = (schedule: { id: string; conversationId: string; prompt: string }, scheduledFor: string, text: string) => {
  const runId = `fixture-${schedule.id}-${scheduledFor}`;
  const request = store.addMessage({ conversationId: schedule.conversationId, channel: "api", direction: "inbound", externalId: "schedule:" + runId, text: schedule.prompt });
  const answer = store.addMessage({ conversationId: schedule.conversationId, channel: "api", direction: "outbound", replyToId: request.id, text });
  store.db.prepare("UPDATE messages SET hidden=1, created_at=? WHERE id=?").run(scheduledFor, request.id);
  store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(new Date(Date.parse(scheduledFor) + 60_000).toISOString(), answer.id);
  store.db.prepare("INSERT INTO schedule_runs(id,schedule_id,conversation_id,scheduled_for,status,created_at,message_id) VALUES(?,?,?,?,'completed',?,?)")
    .run(runId, schedule.id, schedule.conversationId, scheduledFor, scheduledFor, answer.id);
};

// MARK: The main chat

const main = store.primaryConversation();
said(main.id, at(0, "08:10"), "Что важного сегодня?", "inbound");
said(main.id, at(0, "08:11"), "Утром вышли два выпуска: **News** и **Startups**. Тренер прислал план, у Репетитора не прошёл вчерашний запуск.");

// MARK: Two desks

const source = (title: string, host: string, role = "Первоисточник") => ({ title, url: `https://${host}/`, role, publishedAt: null });
const story = (storyId: string, section: string, status: string, title: string, summary: string, extra: Record<string, unknown> = {}) => ({
  storyId, edition: null, rank: null, section, status, title, summary, body: summary + "\n\nПодробности — в источнике.", view: null, check: null,
  verification: "Страница компании.", eventAt: null, change: null, sources: [source("Страница компании", storyId.split("-")[0] + ".example")], telegram: null, image: null, ...extra,
});
/** Publishes stories as the desk's own tool does, then moves them to the moment they are said to have appeared. */
function publish(conversationId: string, createdAt: string, stories: Array<ReturnType<typeof story>>) {
  for (const item of stories) store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(createdAt, publishStory(store, conversationId, item).messageId);
}
function edition(conversationId: string, daysAgo: number, time: string, storyIds: string[], title: string | null = null) {
  const before = new Set((store.db.prepare("SELECT id FROM messages WHERE conversation_id=?").all(conversationId) as Array<{ id: string }>).map(row => row.id));
  publishEdition(store, conversationId, { edition: day(daysAgo), storyIds, title });
  for (const row of store.db.prepare("SELECT id FROM messages WHERE conversation_id=?").all(conversationId) as Array<{ id: string }>) {
    if (!before.has(row.id)) store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(at(daysAgo, time), row.id);
  }
}

const news = store.createProfile({ name: "News", instructions: "Проверяй источники и пиши коротко.", purpose: "Редактор новостей: утренний выпуск и радар за день", appearance: { version: 1, kind: "coil", tone: 4 } });
const newsChat = store.profileConversation(news.id);
publish(newsChat.id, at(1, "07:03"), [
  story("veresk-phone", "Модели", "Демо", "«Вереск» запустил малую модель на телефоне", "На видео модель отвечает без сети; скорость — около десяти слов в секунду."),
  story("rodnik-first", "Деньги", "Вышло", "«Родник» назвал первые шесть проектов с грантами", "Среди получателей — два корпуса устной речи и словарь терминов для врачей."),
]);
edition(newsChat.id, 1, "07:03", ["veresk-phone", "rodnik-first"]);
publish(newsChat.id, at(0, "07:04"), [
  story("klen-3", "Модели", "Вышло", "«Северный мост» открыл веса модели «Клён 3»",
    "Модель вышла под свободной лицензией в трёх размерах. Младшая работает на ноутбуке со скоростью разговора, старшая на тестах компании обходит прежний «Клён».", {
      body: "«Северный мост» опубликовал веса и код запуска «Клён 3».\n\nВ выпуске три размера: 4, 16 и 70 млрд параметров. Компания приводит собственные замеры и предупреждает, что независимых пока нет.\n\nЛицензия разрешает коммерческое использование без отчислений.",
      view: "Младшая версия важнее старшей: она ставит локальную работу с кодом на обычный ноутбук.",
      check: "Замеры компании никто не повторил. Скорость на ноутбуке заявлена для одной конфигурации.",
      verification: "Запись в блоге и карточка модели. Веса не скачивал и не запускал.", eventAt: at(0, "06:30"),
      sources: [source("Запись в блоге", "severnymost.example"), source("Карточка модели", "hub.example", "Документация"), source("Обсуждение у разработчиков", "forum.example", "Обсуждение")] }),
  story("registry-label", "Правила", "Анонс", "Совет по открытым моделям предложил единую метку для синтетического текста", "Метку предлагают ставить в служебные данные файла, а не в сам текст. Обсуждение открыто на месяц."),
  story("granit-demo", "Железо", "Демо", "«Гранит» показал ускоритель для локальных моделей", "Плата запускает модель на 16 млрд параметров со скоростью разговора. Цена и дата продаж не названы."),
  story("most-phone", "Модели", "Слух", "Слух: «Северный мост» готовит версию «Клёна» для телефонов", "О планах пишет один бывший сотрудник; компания отказалась от комментариев."),
]);
edition(newsChat.id, 0, "07:04", ["klen-3", "registry-label", "granit-demo", "most-phone"]);
publish(newsChat.id, at(0, "09:41"), [story("granit-price", "Железо", "Вышло", "«Гранит» назвал цену ускорителя", "Плата будет стоить как видеокарта среднего класса; продажи начнутся в январе.")]);
const newsMorning = runtime.scheduler.save({ conversationId: newsChat.id, name: "Утренний выпуск", prompt: "Собрать выпуск", cron: "4 7 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
ran(newsMorning, at(0, "07:04"), "completed");

const startups = store.createProfile({ name: "Startups", instructions: "Следи за раундами и запусками.", purpose: "Раунды, запуски и люди в стартапах", appearance: { version: 1, kind: "knot", tone: 3 } });
const startupsChat = store.profileConversation(startups.id);
publish(startupsChat.id, at(0, "08:30"), [
  story("lodka-seed", "Раунды", "Вышло", "Лодка: аренда катеров на час, без капитана", "Сервис привлёк посевной раунд от фонда «Причал»; деньги пойдут на запуск в трёх приморских городах.", {
    view: "Сезонный бизнес с дорогим железом: смотреть стоит на загрузку вне лета." }),
  story("ukrop-launch", "Запуски", "Вышло", "Укроп: зелень с городских ферм в день сбора", "Сервис работает в двух районах и обещает доставку в день сбора."),
  story("sverchok-hire", "Люди", "Анонс", "Сверчок: датчики для теплиц, новый технический директор", "Компания готовит вторую версию устройства."),
]);
edition(startupsChat.id, 0, "08:30", ["lodka-seed", "ukrop-launch", "sverchok-hire"], "Стартапы за день");
const startupsMorning = runtime.scheduler.save({ conversationId: startupsChat.id, name: "Стартапы за день", prompt: "Собрать выпуск", cron: "30 8 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
ran(startupsMorning, at(0, "08:30"), "completed");

// MARK: Three ordinary employees

// Working: its request is held, so the Home says it is working until the control port releases it.
const recipes = store.createProfile({ name: "Рецепты", instructions: "Подбирай простые ужины.", purpose: "Подбирает ужины на неделю и собирает список покупок", appearance: { version: 1, kind: "pillow", tone: 7 } });
const recipesChat = store.profileConversation(recipes.id);
said(recipesChat.id, at(2, "19:20"), "Ужин на среду: **рис с овощами**.\n\n- 25 минут\n- всё есть дома");
// Today's dinner came with its picture, so the home shows it on the shelf and the page shows it in the feed.
const plate = runtime.messages.files.put(recipesChat.id, (runtime.messages as unknown as { contextFor(id: string): string }).contextFor(recipesChat.id),
  { name: "pasta.png", mimeType: "image/png", contentBase64: (await readFile(dish)).toString("base64") });
const dinner = store.addMessage({ conversationId: recipesChat.id, channel: "api", direction: "outbound", attachments: [plate],
  text: "Ужин на сегодня: **паста с томатами и базиликом**.\n\n- 20 минут\n- всё есть дома, кроме базилика" });
store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(at(0, "08:10"), dinner.id);
const work = () => { first.held.add(recipesChat.id); void runtime.messages.handle({ channel: "api", text: "Собери меню на неделю", profile: recipes.id }).catch(() => undefined); };
work();

// Failing: the run before worked, yesterday's did not.
const tutor = store.createProfile({ name: "Репетитор", instructions: "Готовь короткие задания по английскому.", purpose: "Каждый вечер присылает десять слов и одно задание", appearance: { version: 1, kind: "wave", tone: 1 } });
const tutorChat = store.profileConversation(tutor.id);
const tutorEvening = runtime.scheduler.save({ conversationId: tutorChat.id, name: "Слова на вечер", prompt: "Подготовить слова", cron: "30 18 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
produced(tutorEvening, at(2, "18:30"), "Десять слов на сегодня готовы. Тема — **путешествия**.\n\n1. itinerary — маршрут\n2. layover — пересадка\n3. fare — тариф");
ran(tutorEvening, at(1, "18:30"), "failed", "Закончился лимит модели.");
// The Home reports the failure as it does for a real run, so the home's «Что важно» has someone who needs the owner.
await runtime.messages.reportProblem(tutorChat.id, `fixture-${tutorEvening.id}-${at(1, "18:30")}`, "execution", undefined, "Закончился лимит модели.");

// A new result arrives when the control port is asked: a plan with a link written as the Home writes links.
const coach = store.createProfile({ name: "Тренер", instructions: "Составляй короткие тренировки.", purpose: "Утренний план тренировки на двадцать минут", appearance: { version: 1, kind: "fold", tone: 6 } });
const coachChat = store.profileConversation(coach.id);
const coachMorning = runtime.scheduler.save({ conversationId: coachChat.id, name: "План на утро", prompt: "Составить план", cron: "45 6 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
produced(coachMorning, at(1, "06:45"), "План на сегодня: **растяжка и планка**, двадцать минут.");
runtime.scheduler.save({ conversationId: coachChat.id, name: "Итоги недели", prompt: "Подвести итоги", cron: "0 20 * * 0", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const arrive = () => store.addMessage({ conversationId: coachChat.id, channel: "api", direction: "outbound",
  text: "План на сегодня: **лёгкий бег и приседания**, двадцать минут.\n\nТехника — в [памятке о приседаниях](<https://trener.example/guide/squat_(basic)>) и в [разминке](<https://trener.example/warm_up_plan>)." });

// MARK: The evening polls

// Four questions in one group, Sunday to Friday. Аня answers every evening; Марк missed one and has not answered today.
// His calm fell this week, and her energy today is far above her usual: both are things the page should notice.
store.linkTelegramChat({ chatId: "-4242", title: "Вечерний круг", allowedSenders: ["42", "77"] });
const circle = store.connectTelegramGroup("-4242").conversationId!;
const asked: Array<[string, string, number[], Array<number | null>]> = [
  ["спокойствие", "Спокойствие: насколько спокойным был день? 1 — совсем нет; 10 — полностью.",
    [6, 7, 6, 5, 7, 6, 6, 7, 5, 6, 7, 6, 7, 6, 7, 6, 7, 7], [7, 6, 7, 6, 7, 6, 7, 6, null, 7, 6, 4, 4, 3, 5, 4, 4, null]],
  ["фокус", "Фокус: сколько из задуманного получилось? 1 — почти ничего; 10 — всё.",
    [7, 8, 7, 6, 8, 7, 7, 8, 6, 7, 8, 7, 8, 7, 8, 7, 6, 8], [6, 6, 7, 5, 6, 7, 6, 6, null, 6, 5, 6, 7, 6, 6, 7, 6, null]],
  ["энергия", "Энергия: сколько было сил? 1 — почти не было; 10 — через край.",
    [6, 6, 5, 6, 7, 6, 5, 6, 6, 5, 6, 6, 5, 6, 6, 5, 6, 9], [7, 7, 8, 7, 6, 7, 8, 7, null, 8, 7, 7, 8, 7, 7, 8, 7, null]],
  ["настроение", "Настроение: как вы себя чувствовали? 1 — плохо; 10 — отлично.",
    [7, 7, 8, 7, 7, 8, 7, 7, 6, 7, 8, 7, 7, 8, 7, 7, 8, 8], [6, 7, 6, 7, 6, 6, 7, 6, null, 6, 6, 7, 6, 5, 6, 6, 7, null]],
];
for (const [name, question, anya, mark] of asked) {
  const options = Array.from({ length: 10 }, (_, i) => String(i + 1));
  const schedule = runtime.scheduler.save({ conversationId: circle, name: "Пульс · " + name, prompt: "", cron: "30 18 * * 0-5",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, delivery: "bound", poll: { question, options } });
  // The clock never asks while the fixture runs: its answers are the ones written here.
  store.db.prepare("UPDATE schedules SET next_run_at='2099-01-01T15:30:00.000Z' WHERE id=?").run(schedule.id);
  anya.forEach((value, index) => {
    const daysAgo = anya.length - 1 - index, date = day(daysAgo), when = new Date(); when.setDate(when.getDate() - daysAgo);
    // No poll on a past Saturday. Today is always asked, so the page reads the same on any day the fixture runs.
    if (daysAgo > 0 && when.getDay() === 6) return;
    const pollId = `fixture-${schedule.id}-${date}`, at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    recordPoll(store, { pollId, scheduleId: schedule.id, conversationId: circle, chatId: "-4242", messageId: null, localDate: date, question, options, createdAt: at });
    recordAnswer(store, { pollId, userId: "42", userName: "Аня", optionIds: [value - 1], at });
    if (mark[index] != null) recordAnswer(store, { pollId, userId: "77", userName: "Марк", optionIds: [mark[index]! - 1], at });
  });
}

// MARK: The second Home

const gardener = second.runtime.store.createProfile({ name: "Садовник", instructions: "Напоминай о делах в саду.", purpose: "Раз в неделю пишет, что сделать на участке", appearance: { version: 1, kind: "curl", tone: 2 } });
const gardenerChat = second.runtime.store.profileConversation(gardener.id);
const garden = second.runtime.store.addMessage({ conversationId: gardenerChat.id, channel: "api", direction: "outbound", text: "На этой неделе: укрыть розы и убрать шланги до заморозков." });
second.runtime.store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(at(3, "10:00"), garden.id);
second.runtime.scheduler.save({ conversationId: gardenerChat.id, name: "Дела в саду", prompt: "Составить список", cron: "0 10 * * 6", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

// MARK: Control

/** The subscription's limits, as the Home's accounts route gives them: a mock engine has none of its own. */
const api = runtime.api as unknown as { handle: (...args: any[]) => Promise<void> };
const handle = api.handle.bind(runtime.api);
api.handle = async (req, res, ...rest) => {
  if (req.method === "GET" && new URL(req.url, "http://127.0.0.1").pathname === "/v1/accounts") {
    const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ canManage: true, accounts: [{ id: "main", name: "Основной", activeRuns: 0, loginPending: false,
      account: { connected: true, email: "preview@example.com", managed: true, planType: "plus" },
      usage: { checkedAt: new Date().toISOString(), ordinaryUsageAllowed: true, unavailable: false, windows: [
        { name: "5h", remainingPercent: 81, windowDurationMins: 300, resetsAt: resets }, { name: "weekly", remainingPercent: 32, windowDurationMins: 10080, resetsAt: resets }] } }] }));
    return;
  }
  await handle(req, res, ...rest);
};

const control = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/chart.png") { res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(await readFile(chart)); return; }
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/invite") { res.end(JSON.stringify(await first.invite())); return; }
  if (url.pathname === "/invite2") { res.end(JSON.stringify(await second.invite())); return; }
  if (url.pathname === "/arrive") arrive();
  if (url.pathname === "/release") first.release();
  if (url.pathname === "/work") work();
  if (url.pathname === "/ask") void runtime.messages.handle({ channel: "api", text: "Отправь письмо в «Лодку» с новыми условиями аренды", byOwner: true }).catch(() => undefined);
  res.end(JSON.stringify({ news: news.id, startups: startups.id, working: recipes.id, failing: tutor.id, fresh: coach.id, gardener: gardener.id, main: main.id, polls: circle,
    team: store.listTeam().map(p => ({ id: p.id, name: p.name, news: p.news, working: p.working, failing: p.failing, nextRunAt: p.nextRunAt, previewAt: p.previewAt })) }));
});
await new Promise<void>(done => control.listen(0, "127.0.0.1", done));
const controlURL = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
// The lead story's picture comes from this fixture's own host, which the app trusts as it trusts the Home beside it.
store.db.prepare("UPDATE messages SET story_json=json_set(story_json,'$.image',?) WHERE conversation_id=? AND story_id='klen-3'").run(`${controlURL}/chart.png`, newsChat.id);
const address = await runtime.api.listen("127.0.0.1", 0), other = await second.runtime.api.listen("127.0.0.1", 0);
await writeFile(output, JSON.stringify({ url: controlURL, localURL: `http://127.0.0.1:${address.port}`, token: runtime.api.localCredential(),
  secondLocalURL: `http://127.0.0.1:${other.port}`, secondToken: second.runtime.api.localCredential(), pid: process.pid }), { mode: 0o600 });
console.log("Isolated team UI fixture ready.");
const stop = async () => { first.release(); control.close(); await runtime.stop(); await second.runtime.stop(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
