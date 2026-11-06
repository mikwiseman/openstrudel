import { Resvg } from "@resvg/resvg-js";
import { METRICS, type DailyMetrics, type Metric } from "./daily-metrics.js";

const names: Record<Metric, string> = { calm: "Спокойствие", focus: "Фокус", energy: "Энергия", mood: "Настроение" };
const colors = ["#9cddbe", "#b9bcff", "#f1c17d", "#efa7bd"];
const xml = (text: string | number) => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const shift = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00Z") - days * 86400000).toISOString().slice(0, 10);
const dateLabel = (date: string, long = false) => new Intl.DateTimeFormat("ru", { day: "numeric", month: long ? "long" : "numeric", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
const daysWord = (n: number) => n % 100 >= 11 && n % 100 <= 14 ? "дней" : n % 10 === 1 ? "день" : n % 10 >= 2 && n % 10 <= 4 ? "дня" : "дней";
const decimal = (n: number) => n.toFixed(1).replace(".", ",");

/** Seven calendar days, four independent scales. Empty cells are never treated as zero. */
export function dailyMetricsCard(data: DailyMetrics) {
  const date = shift(data.today, 1), dates = Array.from({ length: 7 }, (_, i) => shift(date, 6 - i));
  const byDate = new Map(data.days.filter(day => day.date < data.today).map(day => [day.date, day]));
  const weekly = new Date(data.today + "T12:00:00Z").getUTCDay() === 1;
  const width = 1080, block = weekly ? 610 : 526, height = 194 + data.participants.length * block + 74;
  const ink = "#f4f3eb", muted = "#9ba7b0", background = "#151f27";
  const text = (x: number, y: number, value: string | number, size = 28, fill = ink, weight = 400, extra = "") =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${xml(value)}</text>`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Liberation Sans, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="${background}"/>`,
    text(64, 104, "Выдох", 70, ink, 700, 'letter-spacing="-3"'),
    text(1016, 96, dateLabel(date, true), 38, ink, 500, 'text-anchor="end"'),
    text(66, 153, "ЧЕТЫРЕ СТОРОНЫ ДНЯ", 23, muted, 500, 'letter-spacing="2"'),
    text(1016, 153, "WAI HQ", 23, muted, 500, 'text-anchor="end" letter-spacing="2"')];
  // The four marks carry the same metric colors used throughout the report.
  colors.forEach((color, i) => parts.push(`<rect x="${329 + i * 14}" y="${78 - (i % 2) * 10}" width="6" height="${23 + (i % 2) * 20}" rx="3" fill="${color}"/>`));
  for (const [i, person] of data.participants.entries()) {
    const top = 194 + i * block;
    let streak = 0;
    while (METRICS.some(metric => byDate.get(shift(date, streak))?.values[person.id]?.[metric] !== undefined)) streak++;
    parts.push(`<path d="M64 ${top}H1016" stroke="#34404a"/>`,
      text(64, top + 63, person.name, 46, ink, 700, 'letter-spacing="-1"'),
      text(1016, top + 60, `${streak} ${daysWord(streak)} подряд`, 27, muted, 400, 'text-anchor="end"'),
      text(64, top + 120, "ИЗ 10", 22, muted, 500, 'letter-spacing="2"'),
      `<rect x="927" y="${top + 87}" width="89" height="${weekly ? 438 : 386}" rx="22" fill="#2d3a43"/>`);
    dates.forEach((day, j) => parts.push(text(398 + j * 95, top + 120, dateLabel(day), 25, j === 6 ? ink : muted, j === 6 ? 700 : 400, 'text-anchor="middle"')));
    for (const [j, metric] of METRICS.entries()) {
      const color = colors[j]!, center = top + 181 + j * (weekly ? 100 : 86);
      parts.push(`<circle cx="73" cy="${center - 3}" r="7" fill="${color}"/>`,
        text(94, center + 7, names[metric], 33, color, 500));
      if (weekly) {
        const average = (end: string) => {
          const values = Array.from({ length: 7 }, (_, k) => byDate.get(shift(end, k))?.values[person.id]?.[metric]).filter((v): v is number => v !== undefined);
          return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
        };
        const current = average(date), before = average(shift(date, 7));
        const delta = current !== undefined && before !== undefined ? Math.round((current - before) * 10) / 10 : undefined;
        parts.push(text(94, center + 37, `Неделя: ${current === undefined ? "—" : decimal(current)}${delta === undefined ? "" : ` · ${delta < 0 ? "−" : delta > 0 ? "+" : ""}${decimal(Math.abs(delta))}`}`, 22, muted));
      }
      dates.forEach((day, k) => {
        const x = 398 + k * 95, value = byDate.get(day)?.values[person.id]?.[metric], latest = k === 6;
        parts.push(`<g data-person="${xml(person.id)}" data-metric="${metric}" data-date="${day}" ${value === undefined ? 'data-missing="true"' : `data-score="${value}"`}>`);
        if (value === undefined) {
          parts.push(`<path d="M${x - 8} ${center}h16" stroke="#6d7a84" stroke-width="3" stroke-linecap="round"/>`);
        } else if (latest) {
          const circumference = 2 * Math.PI * 34;
          parts.push(`<circle cx="${x}" cy="${center}" r="34" fill="none" stroke="#46545e" stroke-width="7"/>`,
            value ? `<circle cx="${x}" cy="${center}" r="34" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${value / 10 * circumference} ${circumference}" transform="rotate(-90 ${x} ${center})"/>` : "",
            text(x, center + 15, value, 44, ink, 700, 'text-anchor="middle"'));
        } else {
          parts.push(`<rect x="${x - 32}" y="${center - 31}" width="64" height="62" rx="16" fill="${color}" fill-opacity="${0.1 + value / 10 * 0.55}"/>`,
            text(x, center + 12, value, 34, ink, 500, 'text-anchor="middle"'));
        }
        parts.push("</g>");
      });
    }
    if (weekly) {
      const best = dates.map(day => byDate.get(day)).filter(day => day?.values[person.id]?.calm !== undefined)
        .sort((a, b) => b!.values[person.id]!.calm! - a!.values[person.id]!.calm!)[0];
      if (best) parts.push(text(64, top + 570, `Спокойнее всего: ${dateLabel(best.date)} · ${best.values[person.id]!.calm}/10`, 25, muted));
    }
  }
  parts.push(`<path d="M64 ${height - 84}H1016" stroke="#34404a"/>`,
    text(64, height - 34, "Больше — лучше", 25, muted),
    text(1016, height - 34, "— нет ответа", 25, muted, 400, 'text-anchor="end"'), "</svg>");
  const svg = parts.join(""), png = new Resvg(svg).render().asPng();
  return { date, svg, png, caption: `**Выдох · ${dateLabel(date, true)}**\n\n_Отправлено AI-помощником._` };
}
