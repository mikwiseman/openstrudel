import { Resvg } from "@resvg/resvg-js";
import type { Spend, Statistics, StatisticsPeriod } from "./statistics.js";
import type { Store } from "./store.js";
import { xml } from "./daily-metrics-card.js";

/** The owner's morning card: what this Home spent yesterday and on what, and on Sunday the seven days that ended with it.
 * The app's light palette, one large number, every figure named once. The clock draws it from `readStatistics`; no model writes it. */

const canvas = "#f7f3ec", ink = "#1c1b1a", muted = "#615b57", hairline = "#dcd5cb", warning = "#865021";
const width = 1080, left = 72, right = width - 72;
const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const count = (n: number, one: string) => `${number(n)} ${one}${n === 1 ? "" : "s"}`;
const label = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const short = (text: string, max: number) => text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
/** How wide a text draws, erring wide: Arial's and Liberation Sans's letters by class, in ems. */
const em = (c: string) => /[\s.,:;!'·|ijlItfr]/.test(c) ? 0.34 : /[—…WMЖШЩЮЫФ@%]/.test(c) ? 1 : /[A-ZА-ЯЁmwжшщюыфм&]/.test(c) ? 0.76 : 0.58;
const wide = (text: string, size: number, weight = 400) => [...text].reduce((sum, c) => sum + em(c), 0) * size * (weight >= 600 ? 1.06 : 1);
/** The text cut to the room it has on its line. */
const fit = (text: string, size: number, room: number, weight = 400) => {
  if (wide(text, size, weight) <= room) return text;
  const cut = [...text];
  while (cut.length > 1 && wide(cut.join("") + "…", size, weight) > room) cut.pop();
  return cut.join("").trimEnd() + "…";
};

type Amount = Spend & { quiet: number; failed: number };
/** Something that ran, under the name the owner knows it by, counted in its own word: runs, events or messages. */
type Line = Amount & { name: string; one: string };
const nothing = (): Amount => ({ requests: 0, quiet: 0, failed: 0, tokens: 0, costUsd: null });
const add = (sum: Amount, part: Partial<Amount>) => {
  sum.requests += part.requests ?? 0; sum.quiet += part.quiet ?? 0; sum.failed += part.failed ?? 0; sum.tokens += part.tokens ?? 0;
  if (part.costUsd != null) sum.costUsd = (sum.costUsd ?? 0) + part.costUsd;
};

function named(statistics: Statistics, work: StatisticsPeriod["work"][number]): { name: string; one: string } {
  if (work.kind === "schedule") return { name: statistics.schedules[work.id]?.name ?? "Schedule", one: "run" };
  if (work.kind === "events") return { name: capital(work.id.replaceAll("-", " ")), one: "event" };
  const chat = statistics.chats[work.id];
  return { name: chat?.kind === "main" ? "Main chat" : chat?.title ?? "Chat", one: "message" };
}

/** Several days as one: the whole, what ran, how it ended and the models that served it. `own` is the card's schedule:
 * its runs are drawings, not requests, and stay out of what it reports. */
function total(statistics: Statistics, days: StatisticsPeriod[], own?: string) {
  const all = nothing(), lines = new Map<string, Line>(), models = new Map<string, Amount>();
  const ended = { answered: nothing(), quiet: nothing(), failed: nothing() };
  let unpriced = 0;
  for (const day of days) {
    unpriced += day.unpriced;
    for (const outcome of ["answered", "quiet", "failed"] as const) add(ended[outcome], { requests: day.outcomes[outcome], ...day.spent[outcome] });
    for (const work of day.work) {
      if (work.kind === "schedule" && work.id === own) {
        ended.answered.requests -= work.requests - work.quiet - work.failed; ended.quiet.requests -= work.quiet; ended.failed.requests -= work.failed;
        continue;
      }
      const key = work.kind + ":" + work.id, line = lines.get(key) ?? { ...nothing(), ...named(statistics, work) };
      add(line, work); add(all, work); lines.set(key, line);
    }
    for (const model of day.models) if (model.model) { const sum = models.get(model.name) ?? nothing(); add(sum, model); models.set(model.name, sum); }
  }
  return { ...all, unpriced, ended, lines: [...lines.values()], models: [...models].map(([name, sum]) => ({ ...sum, name })) };
}

/** A span is counted in what it has: cost when anything in it had a price, tokens when it was only measured, requests otherwise. */
function measure(span: Spend) {
  if (span.costUsd !== null) return { name: "Spent", where: "Where it went", cost: true, counted: false, less: "less", of: (a: Spend) => a.costUsd, show: usd, phrase: (a: Spend) => "≈ " + usd(a.costUsd ?? 0) };
  if (span.tokens) return { name: "Tokens", where: "Where they went", cost: false, counted: false, less: "fewer", of: (a: Spend) => a.tokens || null, show: compact, phrase: (a: Spend) => compact(a.tokens) + " tokens" };
  return { name: "Requests", where: "What ran", cost: false, counted: true, less: "fewer", of: (a: Spend): number | null => a.requests, show: number, phrase: (a: Spend) => count(a.requests, "request") };
}
type Measure = ReturnType<typeof measure>;
const value = (unit: Measure, a: Spend) => { const n = unit.of(a); return n === null ? "—" : unit.show(n); };
/** A line's figure; where requests are all there is to count, in the line's own word. */
const figure = (unit: Measure, line: Line) => unit.counted ? count(line.requests, line.one) : value(unit, line);
const ranked = <T extends Amount & { name: string }>(unit: Measure, lines: T[]) =>
  [...lines].sort((a, b) => (unit.of(b) ?? 0) - (unit.of(a) ?? 0) || b.tokens - a.tokens || b.requests - a.requests || a.name.localeCompare(b.name));
/** Nothing to compare with when the earlier span was not measured the same way. */
const versus = (unit: Measure, now: Spend, before: Spend, span: string) => {
  const a = unit.of(now), b = unit.of(before);
  if (a === null || b === null) return "";
  const gap = unit.show(Math.abs(a - b));
  return gap === unit.show(0) ? `the same as the ${span} before` : `${gap} ${a > b ? "more" : unit.less} than the ${span} before`;
};

export function homeName(store: Store): string {
  try { return String(JSON.parse(store.getSetting("home.state") ?? "{}").name || "OpenStrudel"); } catch { return "OpenStrudel"; }
}

export function statisticsCard(statistics: Statistics, home: string, own?: string) {
  const days = statistics.days, yesterday = days.at(-2)!, week = days.slice(-8, -1);
  const sunday = new Date(days.at(-1)!.start + "T12:00:00Z").getUTCDay() === 0;
  const sum = (span: StatisticsPeriod[]) => total(statistics, span, own);
  const day = sum([yesterday]), unit = measure(day);

  const parts: string[] = [];
  const text = (x: number, y: number, content: string | number, size: number, fill = ink, weight = 400, extra = "") =>
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${xml(content)}</text>`);
  const rule = (y: number) => parts.push(`<path d="M${left} ${y}H${right}" stroke="${hairline}" stroke-width="2"/>`);
  const meta = (x: number, y: number, content: string, fill = muted) => text(x, y, content.toUpperCase(), 22, fill, 500, 'letter-spacing="3"');
  /** A name with its figure at the right edge; the name gives way. */
  const pair = (y: number, name: string, amount: string) => {
    text(left, y, fit(name, 32, right - left - wide(amount, 32, 600) - 28), 32, ink);
    text(right, y, amount, 32, ink, 600, 'text-anchor="end"');
  };
  /** The one large figure; a cost carries its "about" sign small and quiet, since it is the providers' API price. */
  const hero = (y: number, size: number, of: Measure, amount: Spend) => {
    if (of.cost) text(left, y - size * 0.13, "≈", size * 0.48, muted);
    text(left + (of.cost ? size * 0.37 : 0) - size * 0.04, y, value(of, amount), size, ink, 700, `letter-spacing="${-size * 0.038}"`);
  };

  let y = 104;
  const date = label(yesterday.start, { weekday: "long", month: "long", day: "numeric" });
  text(left, y, fit(home, 46, right - left - wide(date, 30) - 28, 700), 46, ink, 700);
  text(right, y, date, 30, muted, 400, 'text-anchor="end"');
  meta(left, y += 50, `${unit.name} yesterday`);
  hero(y += 186, 190, unit, day);
  /** Spend compares only with a span measured from its first day; requests always compare. */
  const since = statistics.usageSince, comparable = (of: Measure, from: string) => of.counted || (since !== null && from > since);
  const against = comparable(unit, days.at(-3)!.start) ? versus(unit, day, sum([days.at(-3)!]), "day") : "";
  const beside = [against, unit.cost && day.tokens ? compact(day.tokens) + " tokens" : ""].filter(Boolean).join(" · ");
  if (beside) text(left, y += 64, capital(beside), 32, muted);

  // Seven days ending yesterday, one bar each; a day with nothing to show keeps a trace on the baseline.
  const top = y + 44, height = 120, gap = 24, bar = (right - left - gap * 6) / 7;
  const daily = week.map(period => unit.of(sum([period])) ?? 0), most = Math.max(...daily);
  week.forEach((period, i) => {
    const x = left + i * (bar + gap), h = daily[i] ? Math.max(6, Math.round(daily[i]! / most * height)) : 2, latest = i === 6;
    parts.push(`<g data-day="${period.start}" data-value="${Number(daily[i]!.toFixed(2))}"><rect x="${x}" y="${top + height - h}" width="${bar}" height="${h}" rx="${Math.min(10, h / 2)}" fill="${latest ? ink : hairline}"/></g>`);
    text(x + bar / 2, top + height + 40, label(period.start, { weekday: "short" }), 26, latest ? ink : muted, latest ? 700 : 400, 'text-anchor="middle"');
  });
  y = top + height + 40;

  const quietDay = "A quiet day: nothing ran.";
  // What ran, the largest first. A line that cost nothing and did not fail has nothing to say here.
  const worth = (line: Amount) => (unit.of(line) ?? 0) > 0 || line.failed > 0;
  const listed = ranked(unit, day.lines).filter(worth);
  if (!day.requests) text(left, y += 86, quietDay, 38, ink, 700);
  else {
    // How the requests ended, and what each ending spent.
    rule(y += 46);
    (["answered", "quiet", "failed"] as const).forEach((outcome, i) => {
      const end = day.ended[outcome], x = left + i * 330, alarm = outcome === "failed" && end.requests > 0;
      meta(x, y + 58, unit.counted ? outcome : `${number(end.requests)} ${outcome}`, alarm ? warning : muted);
      text(x, y + 120, !end.requests ? "—" : unit.counted ? number(end.requests) : value(unit, end), 54, alarm ? warning : ink, 600);
    });
    rule(y += 166);

    meta(left, y += 58, unit.where);
    const shown = listed.length > 6 ? listed.slice(0, 5) : [...listed], rest = day.lines.filter(line => !shown.includes(line));
    const more: Line = { ...nothing(), name: `${rest.length} more`, one: "request" };
    for (const line of rest) add(more, line);
    if (worth(more)) shown.push(more);
    const all = unit.of(day) ?? 0;
    for (const line of shown) {
      const share = all ? (unit.of(line) ?? 0) / all : 0;
      parts.push(`<g data-line="${xml(line.name)}" data-share="${Math.round(share * 100)}">`);
      pair(y += 58, line.name, figure(unit, line));
      parts.push(`<rect x="${left}" y="${y + 18}" width="${right - left}" height="8" rx="4" fill="${hairline}"/>`);
      if (share > 0) parts.push(`<rect x="${left}" y="${y + 18}" width="${Math.max(8, Math.round(share * (right - left)))}" height="8" rx="4" fill="${ink}"/>`);
      const calm = [unit.counted ? "" : count(line.requests, line.one), line.quiet ? `${number(line.quiet)} quiet` : ""].filter(Boolean).join(" · ");
      const failed = line.failed ? `${number(line.failed)} failed` : "";
      parts.push(`<text x="${left}" y="${y += 58}" font-size="24" fill="${muted}">${xml(calm + (calm && failed ? " · " : ""))}<tspan fill="${warning}">${xml(failed)}</tspan></text></g>`);
    }

    const notes: string[] = [];
    const models = ranked(unit, day.models).slice(0, 3);
    if (models.length) notes.push(models.length > 1 ? models.map(model => `${model.name} ${value(unit, model)}`).join(" · ") : models[0]!.name);
    if (unit.cost && day.unpriced) notes.push(`${count(day.unpriced, "request")} without a published price ${day.unpriced === 1 ? "is" : "are"} not in the cost.`);
    notes.forEach((note, i) => text(left, y += i ? 38 : 70, fit(note, 26, right - left), 26, muted));
  }

  let weekly = "";
  if (sunday) {
    const seven = sum(week), of = measure(seven);
    const first = label(week[0]!.start, { month: "long", day: "numeric" }), last = label(yesterday.start, { month: "long", day: "numeric" });
    const range = first.split(" ")[0] === last.split(" ")[0] ? `${first}–${last.split(" ")[1]}` : `${first} – ${last}`;
    const earlier = comparable(of, days.at(-15)!.start) ? versus(of, seven, sum(days.slice(-15, -8)), "week") : "";
    rule(y += 64);
    meta(left, y += 58, `Week · ${range}`);
    hero(y += 128, 130, of, seven);
    if (earlier) text(left, y += 52, capital(earlier), 32, muted);
    rule(y += 46);
    for (const line of ranked(of, seven.lines).slice(0, 3)) pair(y += 58, line.name, figure(of, line));
    weekly = `\n**Week · ${range}:** ${of.phrase(seven)}${earlier ? ", " + earlier : ""}`;
  }

  // Tokens and cost exist from the first day a turn reported them; bars that began earlier say so.
  if (since && since > week[0]!.start) text(left, y += 70, `Tokens and cost are counted from ${label(since, { month: "long", day: "numeric" })}.`, 26, muted);
  const end = y + 72;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${end}" viewBox="0 0 ${width} ${end}" font-family="Arial, Liberation Sans, sans-serif">`
    + `<rect width="${width}" height="${end}" fill="${canvas}"/>${parts.join("")}</svg>`;
  const png = new Resvg(svg).render().asPng();
  const caption = [`**${home} · ${date}**`, ...day.requests ? [
    `${unit.phrase(day)}${against ? ", " + against : ""}${day.failed ? ` · ${number(day.failed)} failed` : ""}`,
    listed.slice(0, 3).map(line => `${short(line.name, 28)} ${figure(unit, line)}`).join(" · ")] : [quietDay]].filter(Boolean).join("\n") + weekly;
  return { date: yesterday.start, weekly: sunday, svg, png, caption };
}
