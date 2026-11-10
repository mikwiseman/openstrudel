/** Disposable UI server for the team list: two Homes with mock engines. The first has a main chat, a News desk with an
 * edition whose lead story carries a picture, a second desk named Startups whose edition has a name of its own, and three
 * ordinary employees: one working (its request is held until released), one whose latest scheduled run failed, and one that
 * gets a new result when the control port is asked. The second Home has one employee. No real accounts or Telegram; scheduled
 * runs stay quiet; every name, company, story and number is invented. */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import { publishEdition, publishStory } from "../../src/news.js";
import type { CodexEngine } from "../../src/types.js";

const output = resolve(process.argv[2]!);
const root = await mkdtemp(join(tmpdir(), "strudel-team-ui-"));
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.OPENSTRUDEL_SETUP_CODE;
/** The lead story's picture: an invented chart kept beside this file, read from the public repository. */
const picture = process.env.OPENSTRUDEL_FIXTURE_IMAGE ?? "https://raw.githubusercontent.com/mikwiseman/openstrudel/main/tests/fixtures/assets/chart.png";

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
/** A local wall-clock moment `daysAgo` days back, as the Home stores it. */
const at = (daysAgo: number, time: string) => {
  const [h, m] = time.split(":").map(Number), d = new Date();
  d.setDate(d.getDate() - daysAgo); d.setHours(h!, m!, 0, 0);
  return d.toISOString();
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

const news = store.createProfile({ name: "News", instructions: "Проверяй источники и пиши коротко.", purpose: "Редактор новостей: утренний выпуск и радар за день" });
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
      verification: "Запись в блоге и карточка модели. Веса не скачивал и не запускал.", eventAt: at(0, "06:30"), image: picture,
      sources: [source("Запись в блоге", "severnymost.example"), source("Карточка модели", "hub.example", "Документация"), source("Обсуждение у разработчиков", "forum.example", "Обсуждение")] }),
  story("registry-label", "Правила", "Анонс", "Совет по открытым моделям предложил единую метку для синтетического текста", "Метку предлагают ставить в служебные данные файла, а не в сам текст. Обсуждение открыто на месяц."),
  story("granit-demo", "Железо", "Демо", "«Гранит» показал ускоритель для локальных моделей", "Плата запускает модель на 16 млрд параметров со скоростью разговора. Цена и дата продаж не названы."),
  story("most-phone", "Модели", "Слух", "Слух: «Северный мост» готовит версию «Клёна» для телефонов", "О планах пишет один бывший сотрудник; компания отказалась от комментариев."),
]);
edition(newsChat.id, 0, "07:04", ["klen-3", "registry-label", "granit-demo", "most-phone"]);
publish(newsChat.id, at(0, "09:41"), [story("granit-price", "Железо", "Вышло", "«Гранит» назвал цену ускорителя", "Плата будет стоить как видеокарта среднего класса; продажи начнутся в январе.")]);
const newsMorning = runtime.scheduler.save({ conversationId: newsChat.id, name: "Утренний выпуск", prompt: "Собрать выпуск", cron: "4 7 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
ran(newsMorning, at(0, "07:04"), "completed");

const startups = store.createProfile({ name: "Startups", instructions: "Следи за раундами и запусками.", purpose: "Раунды, запуски и люди в стартапах" });
const startupsChat = store.profileConversation(startups.id);
publish(startupsChat.id, at(0, "08:30"), [
  story("lodka-seed", "Раунды", "Вышло", "«Лодка» привлекла посевной раунд на сервис аренды катеров", "Раунд возглавил фонд «Причал»; деньги пойдут на запуск в трёх приморских городах.", {
    view: "Сезонный бизнес с дорогим железом: смотреть стоит на загрузку вне лета." }),
  story("ukrop-launch", "Запуски", "Вышло", "«Укроп» открыл доставку зелени с городских ферм", "Сервис работает в двух районах и обещает доставку в день сбора."),
  story("sverchok-hire", "Люди", "Анонс", "В «Сверчок» пришёл новый технический директор", "Компания делает датчики для теплиц и готовит вторую версию устройства."),
]);
edition(startupsChat.id, 0, "08:30", ["lodka-seed", "ukrop-launch", "sverchok-hire"], "Стартапы за день");
const startupsMorning = runtime.scheduler.save({ conversationId: startupsChat.id, name: "Стартапы за день", prompt: "Собрать выпуск", cron: "30 8 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
ran(startupsMorning, at(0, "08:30"), "completed");

// MARK: Three ordinary employees

// Working: its request is held, so the Home says it is working until the control port releases it.
const recipes = store.createProfile({ name: "Рецепты", instructions: "Подбирай простые ужины.", purpose: "Подбирает ужины на неделю и собирает список покупок" });
const recipesChat = store.profileConversation(recipes.id);
said(recipesChat.id, at(2, "19:20"), "Ужин на среду: **паста с томатами и базиликом**.\n\n- 20 минут\n- всё есть дома, кроме базилика");
const work = () => { first.held.add(recipesChat.id); void runtime.messages.handle({ channel: "api", text: "Собери меню на неделю", profile: recipes.id }).catch(() => undefined); };
work();

// Failing: the run before worked, yesterday's did not.
const tutor = store.createProfile({ name: "Репетитор", instructions: "Готовь короткие задания по английскому.", purpose: "Каждый вечер присылает десять слов и одно задание" });
const tutorChat = store.profileConversation(tutor.id);
said(tutorChat.id, at(1, "18:31"), "Десять слов на сегодня готовы. Тема — **путешествия**.\n\n1. itinerary — маршрут\n2. layover — пересадка\n3. fare — тариф");
const tutorEvening = runtime.scheduler.save({ conversationId: tutorChat.id, name: "Слова на вечер", prompt: "Подготовить слова", cron: "30 18 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
ran(tutorEvening, at(2, "18:30"), "completed");
ran(tutorEvening, at(1, "18:30"), "failed", "Закончился лимит модели.");

// A new result arrives when the control port is asked: a plan with a link written as the Home writes links.
const coach = store.createProfile({ name: "Тренер", instructions: "Составляй короткие тренировки.", purpose: "Утренний план тренировки на двадцать минут" });
const coachChat = store.profileConversation(coach.id);
said(coachChat.id, at(1, "06:46"), "План на сегодня: **растяжка и планка**, двадцать минут.");
const coachMorning = runtime.scheduler.save({ conversationId: coachChat.id, name: "План на утро", prompt: "Составить план", cron: "45 6 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
ran(coachMorning, at(1, "06:45"), "completed");
runtime.scheduler.save({ conversationId: coachChat.id, name: "Итоги недели", prompt: "Подвести итоги", cron: "0 20 * * 0", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const arrive = () => store.addMessage({ conversationId: coachChat.id, channel: "api", direction: "outbound",
  text: "План на сегодня: **лёгкий бег и приседания**, двадцать минут.\n\nТехника — в [памятке о приседаниях](<https://trener.example/guide/squat_(basic)>) и в [разминке](<https://trener.example/warm_up_plan>)." });

// MARK: The second Home

const gardener = second.runtime.store.createProfile({ name: "Садовник", instructions: "Напоминай о делах в саду.", purpose: "Раз в неделю пишет, что сделать на участке" });
const gardenerChat = second.runtime.store.profileConversation(gardener.id);
const garden = second.runtime.store.addMessage({ conversationId: gardenerChat.id, channel: "api", direction: "outbound", text: "На этой неделе: укрыть розы и убрать шланги до заморозков." });
second.runtime.store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(at(3, "10:00"), garden.id);
second.runtime.scheduler.save({ conversationId: gardenerChat.id, name: "Дела в саду", prompt: "Составить список", cron: "0 10 * * 6", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

// MARK: Control

const control = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/invite") { res.end(JSON.stringify(await first.invite())); return; }
  if (url.pathname === "/invite2") { res.end(JSON.stringify(await second.invite())); return; }
  if (url.pathname === "/arrive") arrive();
  if (url.pathname === "/release") first.release();
  if (url.pathname === "/work") work();
  res.end(JSON.stringify({ news: news.id, startups: startups.id, working: recipes.id, failing: tutor.id, fresh: coach.id, gardener: gardener.id, main: main.id,
    team: store.listTeam().map(p => ({ id: p.id, name: p.name, news: p.news, working: p.working, failing: p.failing, nextRunAt: p.nextRunAt, previewAt: p.previewAt })) }));
});
await new Promise<void>(done => control.listen(0, "127.0.0.1", done));
const controlURL = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
const address = await runtime.api.listen("127.0.0.1", 0), other = await second.runtime.api.listen("127.0.0.1", 0);
await writeFile(output, JSON.stringify({ url: controlURL, localURL: `http://127.0.0.1:${address.port}`, token: runtime.api.localCredential(),
  secondLocalURL: `http://127.0.0.1:${other.port}`, secondToken: second.runtime.api.localCredential(), pid: process.pid }), { mode: 0o600 });
console.log("Isolated team UI fixture ready.");
const stop = async () => { first.release(); control.close(); await runtime.stop(); await second.runtime.stop(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
