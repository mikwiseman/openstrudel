import { Resvg } from "@resvg/resvg-js";
import type { RequestSource, Statistics, StatisticsPeriod } from "./statistics.js";
import type { Store } from "./store.js";
import { xml } from "./daily-metrics-card.js";

/** The owner's morning card: yesterday on this Home and, on Sunday, the seven days that ended with it. The app's light
 * palette, one large number, words beside every figure. The clock draws it from `readStatistics`; no model writes it. */

const canvas = "#f7f3ec", ink = "#1c1b1a", muted = "#615b57", hairline = "#dcd5cb", warning = "#865021";
const width = 1080, left = 72, right = width - 72;
const number = (n: number) => new Intl.NumberFormat("ru").format(n);
const compact = (n: number) => new Intl.NumberFormat("ru", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const money = (usd: number) => "≈ " + new Intl.NumberFormat("ru", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usd);
const plural = (n: number, one: string, few: string, many: string) => {
  const tens = n % 100, units = n % 10;
  return tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
};
const requestsWord = (n: number) => plural(n, "запрос", "запроса", "запросов");
const label = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("ru", { ...options, timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
const short = (text: string, max: number) => text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
/** Words broken into lines that fit the card: about half an em a letter, a little more in bold (Liberation Sans on the Homes). */
const wrap = (value: string, size: number, weight = 400) => {
  const fit = Math.floor((right - left) / (size * (weight >= 600 ? 0.6 : 0.52))), lines: string[] = [];
  let line = "";
  for (const word of value.split(" ")) {
    if (line && (line + " " + word).length > fit) { lines.push(line); line = word; } else line = line ? line + " " + word : word;
  }
  return line ? [...lines, line] : lines;
};
const versus = (now: number, before: number, unit: string) => now === before ? `столько же, сколько ${unit} раньше`
  : `на ${number(Math.abs(now - before))} ${now > before ? "больше" : "меньше"}, чем ${unit} раньше`;

/** Several days as one: requests, outcomes, spend, and what ran where, without the card's own runs. */
function total(days: StatisticsPeriod[], own?: { id: string; chat?: string }) {
  const sum = { requests: 0, answered: 0, quiet: 0, failed: 0, measured: 0, tokens: 0, cost: 0, priced: false,
    sources: { app: 0, telegram: 0, schedule: 0, events: 0 } as Record<RequestSource, number>,
    chats: new Map<string, { requests: number; failed: number }>(), models: new Map<string, number>(), schedules: new Map<string, number>() };
  for (const day of days) {
    const self = own ? day.schedules.find(schedule => schedule.id === own.id) : undefined;
    const runs = self?.runs ?? 0, quiet = self?.quiet ?? 0, failed = self?.failed ?? 0;
    sum.requests += day.requests - runs; sum.measured += day.measured;
    sum.answered += day.outcomes.answered - (runs - quiet - failed); sum.quiet += day.outcomes.quiet - quiet; sum.failed += day.outcomes.failed - failed;
    sum.sources.schedule -= runs;
    sum.tokens += day.tokens.input + day.tokens.output;
    if (day.costUsd !== null) { sum.cost += day.costUsd; sum.priced = true; }
    for (const source of Object.keys(sum.sources) as RequestSource[]) sum.sources[source] += day.sources[source];
    for (const chat of day.chats) {
      const seen = sum.chats.get(chat.id) ?? { requests: 0, failed: 0 }, mine = chat.id === own?.chat;
      sum.chats.set(chat.id, { requests: seen.requests + chat.requests - (mine ? runs : 0), failed: seen.failed + chat.failed - (mine ? failed : 0) });
    }
    for (const model of day.models) if (model.model) sum.models.set(model.name, (sum.models.get(model.name) ?? 0) + model.requests);
    for (const schedule of day.schedules) if (schedule.costUsd) sum.schedules.set(schedule.id, (sum.schedules.get(schedule.id) ?? 0) + schedule.costUsd);
  }
  const top = <T>(map: Map<string, T>, value: (v: T) => number) => [...map].filter(([, v]) => value(v) > 0).sort((a, b) => value(b[1]) - value(a[1]));
  return { ...sum, costUsd: sum.priced ? sum.cost : null, topChats: top(sum.chats, v => v.requests), failedChats: top(sum.chats, v => v.failed),
    topModel: top(sum.models, v => v)[0]?.[0] ?? null, costliest: top(sum.schedules, v => v)[0] ?? null };
}

/** One honest line with a little character, from the numbers alone. */
function remark(day: ReturnType<typeof total>, week: number[], title: (id: string) => string): string {
  if (!day.requests) return "Тихий день: ни одного запроса.";
  const unique = (value: number) => week.filter(count => count === value).length === 1;
  if (day.requests === Math.max(...week) && unique(day.requests)) return "Самый занятой день недели.";
  if (day.requests === Math.min(...week) && unique(day.requests)) return "Самый спокойный день недели.";
  const [top] = day.topChats;
  if (top && day.topChats.length > 1 && top[1].requests * 4 >= day.requests * 3) return `Почти весь день ушёл на «${short(title(top[0]), 26)}».`;
  if (top && day.topChats.length > 1 && top[1].requests * 2 >= day.requests) return `Половина дня ушла на «${short(title(top[0]), 28)}».`;
  if (!day.failed) return "Ни одного сбоя.";
  if (day.quiet > day.answered) return `Больше слушал, чем говорил: ${number(day.quiet)} ${plural(day.quiet, "тихая проверка", "тихие проверки", "тихих проверок")}.`;
  return `Ответил ${number(day.answered)} ${plural(day.answered, "раз", "раза", "раз")}.`;
}

export function homeName(store: Store): string {
  try { return String(JSON.parse(store.getSetting("home.state") ?? "{}").name || "OpenStrudel"); } catch { return "OpenStrudel"; }
}

/** `own` is the card's schedule: its runs are drawings, not requests, and stay out of what it reports. */
export function statisticsCard(statistics: Statistics, home: string, own?: string) {
  const days = statistics.days, today = days.at(-1)!, yesterday = days.at(-2)!;
  const week = days.slice(-8, -1), previousWeek = days.slice(-15, -8);
  const sunday = new Date(today.start + "T12:00:00Z").getUTCDay() === 0;
  const title = (id: string) => statistics.chats[id]?.title ?? "Чат";
  const self = own ? { id: own, chat: statistics.schedules[own]?.chatId } : undefined;
  const day = total([yesterday], self), before = total([days.at(-3)!], self), seven = total(week, self), earlier = total(previousWeek, self);
  const requests = (period: StatisticsPeriod) => period.requests - (period.schedules.find(schedule => schedule.id === own)?.runs ?? 0);

  const parts: string[] = [];
  const text = (x: number, y: number, value: string | number, size: number, fill = ink, weight = 400, extra = "") =>
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${xml(value)}</text>`);
  const rule = (y: number) => parts.push(`<path d="M${left} ${y}H${right}" stroke="${hairline}" stroke-width="2"/>`);
  const meta = (y: number, value: string) => text(left, y, value.toUpperCase(), 22, muted, 500, 'letter-spacing="3"');
  /** Tokens, cost and failures side by side; a figure without data says so with a dash. */
  const figures = (y: number, sum: ReturnType<typeof total>) => {
    const cells: Array<[string, string, string]> = [
      ["Токены", sum.measured ? compact(sum.tokens) : "—", ink],
      ["Стоимость", sum.costUsd === null ? "—" : money(sum.costUsd), ink],
      ["Сбои", number(sum.failed), sum.failed ? warning : ink]];
    cells.forEach(([name, value, fill], i) => { text(left + i * 330, y, name.toUpperCase(), 22, muted, 500, 'letter-spacing="3"'); text(left + i * 330, y + 62, value, 54, fill, 600); });
  };

  let y = 104;
  text(left, y, short(home, 26), 46, ink, 700);
  text(right, y, label(yesterday.start, { weekday: "long", day: "numeric", month: "long" }), 30, muted, 400, 'text-anchor="end"');
  meta(y += 50, "Вчера");
  text(left - 8, y += 196, number(day.requests), 210, ink, 700, 'letter-spacing="-8"');
  text(left, y += 58, `${requestsWord(day.requests)} · ${versus(day.requests, before.requests, "днём")}`, 32, muted);

  // Seven days ending yesterday, one bar each; only yesterday carries its number.
  const top = y + 50, height = 180, gap = 24, bar = (right - left - gap * 6) / 7, most = Math.max(1, ...week.map(requests));
  week.forEach((period, i) => {
    const x = left + i * (bar + gap), h = Math.max(6, Math.round(requests(period) / most * height)), latest = i === 6;
    parts.push(`<g data-day="${period.start}" data-requests="${requests(period)}"><rect x="${x}" y="${top + height - h}" width="${bar}" height="${h}" rx="10" fill="${latest ? ink : hairline}"/></g>`);
    text(x + bar / 2, top + height + 42, label(period.start, { weekday: "short" }), 26, latest ? ink : muted, latest ? 700 : 400, 'text-anchor="middle"');
  });
  y = top + height + 88;
  rule(y);
  figures(y += 58, day);
  rule(y += 108);

  const sources = ([["Telegram", day.sources.telegram], ["расписания", day.sources.schedule], ["приложение", day.sources.app], ["события", day.sources.events]] as const)
    .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${number(n)}`);
  const lines = day.requests ? [`Ответил ${number(day.answered)} · промолчал ${number(day.quiet)}`] : [];
  if (sources.length) { const joined = sources.join(" · "); lines.push(joined.charAt(0).toUpperCase() + joined.slice(1)); }
  if (day.topChats[0]) lines.push(`Больше всего — «${short(title(day.topChats[0][0]), 30)}»: ${number(day.topChats[0][1].requests)}`);
  if (day.failedChats[0]) lines.push(`Сбои чаще всего — «${short(title(day.failedChats[0][0]), 26)}»: ${number(day.failedChats[0][1].failed)}`);
  if (day.topModel) lines.push(`Модель — ${day.topModel}`);
  for (const line of lines) wrap(line, 32).forEach((part, i) => text(left, y += i ? 42 : 58, part, 32, ink));
  const said = remark(day, week.map(requests), title);
  wrap(said, 38, 700).forEach((part, i) => text(left, y += i ? 50 : 82, part, 38, ink, 700));

  let weekly = "";
  if (sunday) {
    const first = label(week[0]!.start, { day: "numeric", month: "long" }), last = label(yesterday.start, { day: "numeric", month: "long" });
    const range = first.split(" ")[1] === last.split(" ")[1] ? `${first.split(" ")[0]}–${last}` : `${first} – ${last}`;
    rule(y += 64);
    meta(y += 58, `Неделя · ${range}`);
    text(left - 4, y += 128, number(seven.requests), 130, ink, 700, 'letter-spacing="-5"');
    text(left, y += 52, `${requestsWord(seven.requests)} · ${versus(seven.requests, earlier.requests, "неделей")}`, 32, muted);
    rule(y += 46);
    figures(y += 58, seven);
    rule(y += 108);
    for (const [id, value] of seven.topChats.slice(0, 3)) {
      text(left, y += 58, short(title(id), 40), 32, ink);
      text(right, y, number(value.requests), 32, ink, 600, 'text-anchor="end"');
    }
    if (seven.costliest) wrap(`Дороже всего — «${short(statistics.schedules[seven.costliest[0]]?.name ?? "расписание", 30)}»: ${money(seven.costliest[1])}`, 30)
      .forEach((part, i) => text(left, y += i ? 40 : 70, part, 30, muted));
    weekly = `\n**Неделя · ${range}:** ${number(seven.requests)} ${requestsWord(seven.requests)}, ${versus(seven.requests, earlier.requests, "неделей")}`
      + (seven.costUsd === null ? "" : ` · ${money(seven.costUsd)}`);
  }

  // Tokens and cost exist from the first day a turn reported them; a span that began earlier says so.
  const since = statistics.usageSince, shown = sunday ? week[0]!.start : yesterday.start;
  if (since && since >= shown) wrap(`Токены и стоимость — с ${label(since, { day: "numeric", month: "long" })}.`, 26).forEach((part, i) => text(left, y += i ? 34 : 76, part, 26, muted));
  const end = y + 72;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${end}" viewBox="0 0 ${width} ${end}" font-family="Arial, Liberation Sans, sans-serif">`
    + `<rect width="${width}" height="${end}" fill="${canvas}"/>${parts.join("")}</svg>`;
  const png = new Resvg(svg).render().asPng();
  const spend = [day.measured ? `${compact(day.tokens)} токенов` : "", day.costUsd === null ? "" : money(day.costUsd), day.failed ? `сбои: ${number(day.failed)}` : ""].filter(Boolean);
  const caption = `**${home} · вчера, ${label(yesterday.start, { day: "numeric", month: "long" })}**\n`
    + `${number(day.requests)} ${requestsWord(day.requests)}, ${versus(day.requests, before.requests, "днём")}${spend.length ? " · " + spend.join(" · ") : ""}\n${said}${weekly}`;
  return { date: yesterday.start, weekly: sunday, svg, png, caption };
}
