/** Disposable UI server for the News reader: a Home with a mock engine and one News employee whose stories cover today's
 * morning edition, the day's radar, developments and four earlier days. The control port chooses what the Home says about
 * its runs (every variant of the `status` contract, or none, as an older Home), hides today's edition or the whole day,
 * empties the feed, and publishes a story or a development while the reader is open. No real accounts, Telegram or
 * schedules; every company, product and story is invented. */
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenStrudelRuntime } from "../../src/runtime.js";
import type { CodexEngine, NewsStory } from "../../src/types.js";

const output = resolve(process.argv[2]!);
const homeName = process.argv[3];
const directory = await mkdtemp(join(tmpdir(), "strudel-news-ui-"));
process.chdir(directory);
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.OPENSTRUDEL_SETUP_CODE;

const engine: CodexEngine = {
  async run(input, options) {
    const message = input.split("Current user message:\n").at(-1)!.trim();
    options?.onEvent?.({ type: "thread.started", payload: { threadId: options.threadId ?? "news-thread" } });
    await new Promise(done => setTimeout(done, 400));
    return { threadId: options?.threadId ?? "news-thread", response: input.includes("Quoted News story") ? `Про эту историю: ${message}` : `Принято: ${message}`, events: [] };
  },
  async connections() { return []; },
  async connect() { return { url: "http://127.0.0.1/connect" }; },
};
const runtime = new OpenStrudelRuntime({ rootDirectory: directory, dbPath: ":memory:", engine, startTelegram: false, mobilePort: 0 });
if (homeName !== undefined) runtime.api.home.rename(homeName);
Object.assign((runtime.api.mobile as any).options, { host: "127.0.0.1", hostname: "127.0.0.1" });
runtime.account.read = async () => ({ connected: true, email: "preview@example.com", managed: true, planType: "plus" });

const main = runtime.store.primaryConversation();
runtime.store.addMessage({ conversationId: main.id, channel: "api", direction: "inbound", text: "Что важного сегодня?" });
runtime.store.addMessage({ conversationId: main.id, channel: "api", direction: "outbound", text: "Утренний выпуск News уже вышел: семь историй." });
const news = runtime.store.createProfile({ name: "News", instructions: "Проверяй источники и пиши коротко.", purpose: "Редактор новостей" });
const chat = runtime.store.profileConversation(news.id);

// MARK: Stories

const pad = (n: number) => String(n).padStart(2, "0");
/** A local wall-clock moment `daysAgo` days back, as the Home stores it. */
const at = (daysAgo: number, time: string) => {
  const [h, m] = time.split(":").map(Number), d = new Date();
  d.setDate(d.getDate() - daysAgo); d.setHours(h!, m!, 0, 0);
  return d.toISOString();
};
/** The local date `daysAgo` days back: an edition's name. */
const day = (daysAgo: number) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const source = (title: string, host: string, role = "Первоисточник", publishedAt: string | null = null) => ({ title, url: `https://${host}/`, role, publishedAt });

type Draft = Partial<NewsStory> & Pick<NewsStory, "id" | "section" | "status" | "title" | "summary">;
const drafts = new Map<string, NewsStory>();
let sequence = 0;
/** Publishes a version of a story at a moment in the past. Later versions start from the story as it stood. */
function publish(createdAt: string, draft: Draft, version: Partial<NewsStory> = {}) {
  // Only an edition names its date and place; a report or a development belongs to the radar.
  const story: NewsStory = { body: draft.summary + "\n\nПодробности — в источнике.", view: null, check: null,
    verification: "Страница компании.", eventAt: null, sources: [source("Страница компании", draft.id.split("-")[0] + ".example")],
    ...(drafts.get(draft.id) ?? {}), ...draft, edition: null, rank: null, change: null, ...version };
  drafts.set(story.id, story);
  const message = runtime.store.addMessage({ conversationId: chat.id, channel: "api", direction: "outbound", text: `**${story.title}**\n\n${story.summary}`, externalId: `story:${story.id}:${++sequence}`, story });
  runtime.store.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(createdAt, message.id);
  return message.id;
}
const again = (id: string) => drafts.get(id)!;
/** One morning's selection, published together as the Home's `publish_edition` does. */
const edition = (daysAgo: number, time: string, ids: string[]) => ids.forEach((id, index) => publish(at(daysAgo, time), again(id), { edition: day(daysAgo), rank: index + 1 }));

// Four and three days ago: editions only.
publish(at(4, "07:02"), { id: "veresk-open-weights", section: "Модели", status: "Вышло", title: "«Вереск» выложил веса своей малой модели", summary: "Модель на 4 млрд параметров доступна под свободной лицензией; заявлена работа на ноутбуке без видеокарты." });
publish(at(4, "07:02"), { id: "sova-notes", section: "Продукты", status: "Вышло", title: "Заметки «Сова» собирают конспект встречи без записи звука", summary: "Приложение слушает разговор на устройстве и сохраняет только текст." });
publish(at(4, "07:02"), { id: "rodnik-fund", section: "Деньги", status: "Анонс", title: "Фонд «Родник» выделит гранты на открытые наборы данных", summary: "Заявки принимают до конца месяца; приоритет — языки с малым числом текстов." });
publish(at(4, "07:02"), { id: "granit-roadmap", section: "Железо", status: "Анонс", title: "«Гранит» обещает ускоритель для локальных моделей к зиме", summary: "Компания показала плату на закрытой встрече и назвала срок без цены." });
edition(4, "07:02", ["veresk-open-weights", "sova-notes", "rodnik-fund", "granit-roadmap"]);
publish(at(3, "07:05"), { id: "mayak-eval", section: "Агенты", status: "Вышло", title: "«Маяк» выпустил набор задач для проверки агентов", summary: "В наборе 300 задач с проверяемым результатом; авторы просят не обучать на нём модели." });
publish(at(3, "07:05"), { id: "pero-tables", section: "Продукты", status: "Демо", title: "Редактор «Перо» показал работу с таблицами", summary: "В демо редактор читает таблицу и пишет сводку с пояснением, откуда взята каждая цифра." });
publish(at(3, "07:05"), { id: "iva-translate", section: "Модели", status: "Вышло", title: "Открытая модель «Ива» вышла с поддержкой сорока языков", summary: "Авторы приводят сравнение на собственном наборе; независимых замеров пока нет." });
publish(at(3, "07:05"), { id: "registry-draft", section: "Правила", status: "Анонс", title: "Совет по открытым моделям готовит реестр синтетического текста", summary: "Черновик правил опубликуют для обсуждения; участие добровольное." });
publish(at(3, "07:05"), { id: "soroka-mail", section: "Продукты", status: "Слух", title: "Слух: почтовый клиент «Сорока» получит ответы-черновики", summary: "О функции пишут два участника закрытого теста; компания не комментирует." });
edition(3, "07:05", ["mayak-eval", "pero-tables", "iva-translate", "registry-draft", "soroka-mail"]);

// Two days ago the morning run did not publish: a radar and no edition.
publish(at(2, "10:15"), { id: "skvorets-week", section: "Агенты", status: "Демо", title: "Агент «Скворец» неделю вёл учебный проект без присмотра", summary: "Команда показала журнал работы: 212 шагов, девять остановок на вопросы к человеку." });
publish(at(2, "14:40"), { id: "klen-leak", section: "Модели", status: "Слух", title: "Слух: «Северный мост» готовит модель «Клён 3»", summary: "В репозитории компании появилась и исчезла страница с описанием новой модели." });
publish(at(2, "18:05"), { id: "granit-price-talk", section: "Железо", status: "Слух", title: "Слух: ускоритель «Гранит» будет стоить как игровая видеокарта", summary: "Цену называют два поставщика; официального прайса нет." });

// Yesterday: an edition, a radar, and the story that keeps developing.
publish(at(1, "07:03"), { id: "veresk-phone", section: "Модели", status: "Демо", title: "«Вереск» запустил малую модель на телефоне", summary: "На видео модель отвечает без сети; скорость — около десяти слов в секунду." });
publish(at(1, "07:03"), { id: "rodnik-first", section: "Деньги", status: "Вышло", title: "«Родник» назвал первые шесть проектов с грантами", summary: "Среди получателей — два корпуса устной речи и словарь терминов для врачей." });
edition(1, "07:03", ["skvorets-week", "veresk-phone", "klen-leak", "rodnik-first", "granit-price-talk", "mayak-eval"]);
publish(at(1, "11:30"), { id: "pero-facts", section: "Продукты", status: "Анонс", title: "«Перо» анонсировало режим проверки фактов", summary: "Редактор будет подсвечивать утверждения без источника и предлагать, где их проверить." });
const harbour = "gavan-long-context";
publish(at(1, "16:20"), { id: harbour, section: "Деньги", status: "Анонс", title: "«Тихая гавань» вводит плату за длинный контекст",
  summary: "Облачный сервис будет считать запросы длиннее 200 тысяч токенов по отдельному тарифу. Короткие запросы останутся в прежней цене.",
  body: "«Тихая гавань» сообщила клиентам, что запросы с длинным контекстом перестанут входить в обычный тариф.\n\n- порог — 200 тысяч токенов на запрос;\n- новый тариф действует для всех моделей сервиса;\n- для действующих договоров обещан переходный период.\n\nКомпания объясняет изменение ростом затрат на память ускорителей.",
  view: "Тем, кто держит в контексте целые репозитории, пора считать, что дешевле: длинный запрос или поиск по базе.",
  check: "Распространяется ли новый тариф на закрытые развёртывания: в письме об этом ни слова.",
  verification: "Письмо клиентам и страница тарифов. Счёт за длинный запрос не запрашивал.",
  eventAt: at(1, "15:50"),
  sources: [source("Письмо клиентам", "gavan.example", "Первоисточник", at(1, "15:50")), source("Страница тарифов", "gavan.example/pricing", "Документация", at(1, "16:05")), source("Обсуждение у разработчиков", "forum.example", "Обсуждение", at(1, "17:10"))] });
publish(at(1, "17:45"), { id: "skvorets-waitlist", section: "Агенты", status: "Анонс", title: "«Скворец» открывает закрытый тест для команд", summary: "Заявки принимают от команд до десяти человек; сроки первых приглашений не названы." });
publish(at(1, "19:05"), again(harbour), { status: "Обновление", change: "Компания подтвердила дату: новый тариф действует с 1 декабря." });
publish(at(1, "21:30"), { id: "iva-benchmark", section: "Модели", status: "Вышло", title: "Независимый замер: «Ива» переводит лучше закрытых моделей в шести парах языков", summary: "Замер провела университетская группа на новых текстах; в остальных парах «Ива» уступает." });

// Today: the morning edition at 07:04, then the radar.
publish(at(0, "07:04"), { id: "klen-3", section: "Модели", status: "Вышло", title: "«Северный мост» открыл веса модели «Клён 3»",
  summary: "Модель вышла под свободной лицензией в трёх размерах. Старшая версия на тестах компании обходит прежний «Клён» в коде и переводе, младшая работает на ноутбуке.",
  body: "«Северный мост» опубликовал веса и код запуска «Клён 3».\n\nВ выпуске три размера: 4, 16 и 70 млрд параметров. Компания приводит собственные замеры и предупреждает, что независимых пока нет.\n\nЛицензия разрешает коммерческое использование без отчислений.",
  view: "Младшая версия важнее старшей: она ставит локальную работу с кодом на обычный ноутбук.",
  check: "Замеры компании никто не повторил. Скорость на ноутбуке заявлена для одной конфигурации.",
  verification: "Запись в блоге и карточка модели. Веса не скачивал и не запускал.",
  eventAt: at(0, "06:30"),
  sources: [source("Запись в блоге", "severnymost.example", "Первоисточник", at(0, "06:30")), source("Карточка модели", "hub.example", "Документация", at(0, "06:32")), source("Лицензия", "severnymost.example/license", "Документация"),
    source("Обсуждение у разработчиков", "forum.example", "Обсуждение", at(0, "06:55")), source("Пересказ в рассылке", "listok.example", "Перепечатка", at(0, "07:00"))] });
publish(at(0, "07:04"), { id: "registry-label", section: "Правила", status: "Анонс", title: "Совет по открытым моделям предложил единую метку для синтетического текста", summary: "Метку предлагают ставить в служебные данные файла, а не в сам текст. Обсуждение открыто на месяц." });
publish(at(0, "07:04"), { id: "granit-demo", section: "Железо", status: "Демо", title: "«Гранит» показал ускоритель для локальных моделей", summary: "Плата запускает модель на 16 млрд параметров со скоростью разговора. Цена и дата продаж не названы." });
publish(at(0, "07:04"), { id: "most-phone", section: "Модели", status: "Слух", title: "Слух: «Северный мост» готовит версию «Клёна» для телефонов", summary: "О планах пишет один бывший сотрудник; компания отказалась от комментариев." });
edition(0, "07:04", ["klen-3", "skvorets-week", harbour, "pero-facts", "registry-label", "granit-demo", "most-phone"]);
publish(at(0, "07:48"), { id: "iva-update", section: "Модели", status: "Вышло", title: "«Ива» получила версию с длинным контекстом", summary: "Окно выросло до 128 тысяч токенов; веса лежат рядом с прежними." });
publish(at(0, "08:02"), { id: "soroka-court", section: "Правила", status: "Вышло", title: "Суд отклонил иск к разработчику «Сороки»", summary: "Истцы требовали запретить обучение на переписке без согласия; суд не нашёл доказательств такого обучения.", eventAt: day(1) });
publish(at(0, "08:20"), { id: "mayak-kit", section: "Агенты", status: "Вышло", title: "«Маяк» добавил в набор задачи с долгой памятью", summary: "Новые сорок задач проверяют, помнит ли агент договорённости через сотни шагов." });
publish(at(0, "09:05"), { id: "soroka-drafts", section: "Продукты", status: "Вышло", title: "Почтовый клиент «Сорока» отвечает на письма черновиками", summary: "Черновик появляется под письмом и никуда не уходит без нажатия. Работает для трёх языков.", eventAt: at(0, "08:40") });
publish(at(0, "09:41"), { id: "granit-price", section: "Железо", status: "Вышло", title: "«Гранит» назвал цену ускорителя", summary: "Плата будет стоить как видеокарта среднего класса; продажи начнутся в январе.", eventAt: at(0, "09:30"),
  check: "Будут ли платы в продаже после первой партии.", verification: "Страница предзаказа. Плату в руках не держал." });
publish(at(0, "10:12"), { id: "klen-clouds", section: "Модели", status: "Вышло", title: "«Клён 3» появился у двух облачных провайдеров", summary: "Оба дают модель по цене прежней версии; младший размер — бесплатно в пределах дневного лимита.",
  sources: [source("Каталог первого провайдера", "oblako-odin.example", "Первоисточник"), source("Каталог второго провайдера", "oblako-dva.example", "Первоисточник"), source("Карточка модели", "hub.example", "Документация"), source("Обсуждение у разработчиков", "forum.example", "Обсуждение")] });
publish(at(0, "10:40"), again(harbour), { status: "Обновление", change: "Опубликован прайс: длинный контекст вдвое дороже обычного.", eventAt: at(0, "10:30") });
publish(at(0, "11:05"), { id: "registry-january", section: "Правила", status: "Анонс", title: "Реестр синтетического текста заработает с января", summary: "Совет назвал срок и первых участников; подключение останется добровольным." });
publish(at(0, "11:52"), { id: "pero-summaries", section: "Продукты", status: "Вышло", title: "«Перо» читает таблицы и строит по ним сводки", summary: "Функция из демо вышла для всех; источник каждой цифры виден по наведению." });

/** What can still happen while the reader is open, in order. */
const upcoming: Array<() => void> = [
  () => publish(new Date().toISOString(), { id: "skvorets-invites", section: "Агенты", status: "Вышло", title: "«Скворец» разослал первые приглашения в закрытый тест", summary: "Приглашения получили около ста команд; остальным обещают волны раз в неделю." }),
  () => publish(new Date().toISOString(), { id: "veresk-license", section: "Модели", status: "Обновление", title: "«Вереск» сменил лицензию малой модели на более свободную", summary: "Исчез запрет на использование в платных продуктах; текст лицензии обновлён в репозитории." }),
  () => publish(new Date().toISOString(), again("granit-price"), { status: "Обновление", change: "Открыт предзаказ: первая партия — тысяча плат." }),
  () => publish(new Date().toISOString(), { id: "rodnik-second", section: "Деньги", status: "Анонс", title: "«Родник» объявил вторую волну грантов", summary: "Вторая волна — для инструментов разметки; заявки принимают до конца января." }),
];

// MARK: What the Home says about its runs, and what the reader is shown of the feed

type Variant = "ok" | "running" | "failed" | "paused" | "absent";
let variant: Variant = "ok";
/** Today's edition, or everything published today, can be taken away; the feed can be emptied. */
let showsEdition = true, showsToday = true, empty = false, offline = false;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function status() {
  const next = new Date(Date.now() + 60_000).toISOString();
  switch (variant) {
    case "ok": return { running: false, checkedAt: minutesAgo(14), failedAt: null, failure: null, nextRunAt: next };
    case "running": return { running: true, checkedAt: minutesAgo(15), failedAt: null, failure: null, nextRunAt: next };
    case "failed": return { running: false, checkedAt: at(0, "10:05"), failedAt: at(0, "10:20"), failure: "Закончился лимит модели.", nextRunAt: next };
    case "paused": return { running: false, checkedAt: at(1, "23:40"), failedAt: null, failure: null, nextRunAt: null };
    case "absent": return undefined;
  }
}
/** The app reloads stories when their stamp changes; a thread message moves the stamp without adding a story. */
const bump = () => { runtime.store.addMessage({ conversationId: chat.id, channel: "api", direction: "inbound", text: "fixture", storyId: "klen-3" }); };

const api = runtime.api as unknown as { handle: (...args: any[]) => Promise<void> };
const originalHandle = api.handle.bind(runtime.api);
api.handle = async (req, res, ...rest) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  if (offline) { res.writeHead(503).end('{"error":"Тестовое отключение"}'); return; }
  if (req.method === "GET" && path === `/v1/conversations/${chat.id}/stories`) {
    const end = res.end.bind(res);
    res.end = (body?: unknown) => {
      if (res.statusCode !== 200 || typeof body !== "string") return end(body as any);
      const feed = JSON.parse(body) as { messages: Array<{ createdAt: string; story?: NewsStory }>; stamp: string | null; status?: unknown };
      const today = day(0), midnight = at(0, "00:00");
      feed.messages = empty ? [] : feed.messages.filter(m => (showsToday || m.createdAt < midnight) && (showsEdition || m.story?.edition !== today));
      const report = status();
      if (report) feed.status = report; else delete feed.status;
      return end(JSON.stringify(feed));
    };
  }
  await originalHandle(req, res, ...rest);
};

const control = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const url = new URL(req.url ?? "/", "http://127.0.0.1"), value = url.searchParams.get("value");
  if (url.pathname === "/invite") {
    const invitation = await runtime.api.mobile.invite(true);
    const link = new URL(invitation.url); link.searchParams.set("name", homeName ?? "Тестовый Mac");
    res.end(JSON.stringify({ ...invitation, url: link.toString() })); return;
  }
  if (url.pathname === "/status") { variant = (value as Variant) ?? "ok"; bump(); }
  if (url.pathname === "/edition") { showsEdition = value !== "0"; bump(); }
  if (url.pathname === "/today") { showsToday = value !== "0"; bump(); }
  if (url.pathname === "/empty") { empty = value === "1"; bump(); }
  if (url.pathname === "/offline") offline = value === "1";
  if (url.pathname === "/arrive") upcoming.shift()?.();
  res.end(JSON.stringify({ news: news.id, conversation: chat.id, main: main.id, variant, showsEdition, showsToday, empty, offline, upcoming: upcoming.length,
    stories: drafts.size, lead: again("klen-3").title, developing: harbour }));
});
await new Promise<void>(done => control.listen(0, "127.0.0.1", done));
const controlURL = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
const address = await runtime.api.listen("127.0.0.1", Number(process.env.OPENSTRUDEL_NEWS_FIXTURE_PORT ?? 0));
await writeFile(output, JSON.stringify({ url: controlURL, localURL: `http://127.0.0.1:${address.port}`, token: runtime.api.localCredential(), news: news.id, conversation: chat.id, pid: process.pid }), { mode: 0o600 });
console.log("Isolated News UI fixture ready.");
const stop = async () => { control.close(); await runtime.stop(); await rm(directory, { recursive: true, force: true }); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
