import { Resvg } from "@resvg/resvg-js";
import { METRICS, metricLabels as names, metricsDisplayName, isMetricsDay, type DailyMetrics } from "./daily-metrics.js";

const colors = ["#9cddbe", "#b9bcff", "#f1c17d", "#efa7bd"];
export const xml = (text: string | number) => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const shift = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00Z") - days * 86400000).toISOString().slice(0, 10);
const dateLabel = (date: string, long = false) => new Intl.DateTimeFormat("en-GB", { day: long ? "numeric" : "2-digit", month: long ? "long" : "2-digit", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
const weekday = (date: string, long = false) => new Intl.DateTimeFormat("en-GB", { weekday: long ? "long" : "short", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
const previousDay = (date: string) => {
  let previous = shift(date, 1);
  while (!isMetricsDay(previous)) previous = shift(previous, 1);
  return previous;
};

/** Seven reporting days (Sunday–Friday), four independent scales. Missing is never zero. */
export function dailyMetricsCard(data: DailyMetrics) {
  const date = previousDay(data.today), dates = [date];
  while (dates.length < 7) dates.unshift(previousDay(dates[0]!));
  const byDate = new Map(data.days.filter(day => day.date < data.today && isMetricsDay(day.date)).map(day => [day.date, day]));
  const width = 1080, block = 554, height = 194 + data.participants.length * block + 74;
  const ink = "#f4f3eb", muted = "#9ba7b0", background = "#151f27";
  const text = (x: number, y: number, value: string | number, size = 28, fill = ink, weight = 400, extra = "") =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${xml(value)}</text>`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Liberation Sans, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="${background}"/>`,
    text(64, 104, "Exhale", 70, ink, 700, 'letter-spacing="-3"'),
    text(1016, 52, weekday(date, true), 26, muted, 500, 'text-anchor="end"'),
    text(1016, 102, dateLabel(date, true), 38, ink, 500, 'text-anchor="end"'),
    text(66, 153, "FOUR SIDES OF YOUR DAY", 23, muted, 500, 'letter-spacing="2"'),
    text(1016, 153, "WAI HQ", 23, muted, 500, 'text-anchor="end" letter-spacing="2"')];
  // The four marks carry the same metric colors used throughout the report.
  colors.forEach((color, i) => parts.push(`<rect x="${329 + i * 14}" y="${78 - (i % 2) * 10}" width="6" height="${23 + (i % 2) * 20}" rx="3" fill="${color}"/>`));
  for (const [i, person] of data.participants.entries()) {
    const top = 194 + i * block;
    let streak = 0;
    let streakDate = date;
    while (byDate.get(streakDate)?.values[person.id]?.calm !== undefined) {
      streak++;
      streakDate = previousDay(streakDate);
    }
    parts.push(`<path d="M64 ${top}H1016" stroke="#34404a"/>`,
      text(64, top + 63, metricsDisplayName(person.name), 46, ink, 700, 'letter-spacing="-1"'),
      text(1016, top + 60, `${streak} workday${streak === 1 ? "" : "s"} of calm`, 27, muted, 400, 'text-anchor="end"'),
      text(64, top + 143, "OUT OF 10", 22, muted, 500, 'letter-spacing="2"'),
      `<rect x="927" y="${top + 87}" width="89" height="414" rx="22" fill="#2d3a43"/>`);
    dates.forEach((day, j) => parts.push(
      `<g data-header-person="${xml(person.id)}" data-header-date="${day}">`,
      text(398 + j * 95, top + 109, weekday(day), 22, j === 6 ? ink : muted, 500, 'text-anchor="middle"'),
      text(398 + j * 95, top + 143, dateLabel(day), 25, j === 6 ? ink : muted, j === 6 ? 700 : 400, 'text-anchor="middle"'), "</g>"));
    for (const [j, metric] of METRICS.entries()) {
      const color = colors[j]!, center = top + 209 + j * 86;
      parts.push(`<circle cx="73" cy="${center - 3}" r="7" fill="${color}"/>`,
        text(94, center + 7, names[metric], 33, color, 500));
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
  }
  parts.push(`<path d="M64 ${height - 84}H1016" stroke="#34404a"/>`,
    text(64, height - 34, "Higher is better", 25, muted),
    text(1016, height - 34, "— no rating", 25, muted, 400, 'text-anchor="end"'), "</svg>");
  const svg = parts.join(""), png = new Resvg(svg).render().asPng();
  return { date, svg, png, caption: `**Exhale · ${weekday(date, true)}, ${dateLabel(date, true)}**` };
}
