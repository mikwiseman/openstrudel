import { Resvg } from "@resvg/resvg-js";
import { METRICS, metricLabels as names, metricsDisplayName, isMetricsDay, type DailyMetrics } from "./daily-metrics.js";

const colors = ["#9cddbe", "#b9bcff", "#f1c17d", "#efa7bd"];
export const xml = (text: string | number) => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const shift = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00Z") - days * 86400000).toISOString().slice(0, 10);
const dateLabel = (date: string, long = false) => new Intl.DateTimeFormat("en-GB", { day: long ? "numeric" : "2-digit", month: long ? "long" : "2-digit", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
const weekday = (date: string, long = false) => new Intl.DateTimeFormat("en-GB", { weekday: long ? "long" : "short", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
const shortDate = (date: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
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
  const width = 1080, block = 766, height = 194 + data.participants.length * block + 104;
  const columnX = (index: number) => 340 + index * 110;
  const earlierDays = [...byDate.keys()].filter(day => day < date).sort().reverse();
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
      text(1016, top + 60, `Calm streak · ${streak} check-in day${streak === 1 ? "" : "s"}`, 24, muted, 400, 'text-anchor="end"'),
      text(64, top + 108, "SCORE CHANGE", 20, muted, 500, 'letter-spacing="1.5"'),
      text(64, top + 139, "vs previous rating", 21, muted),
      `<rect x="964" y="${top + 78}" width="72" height="652" rx="20" fill="#2d3a43"/>`);
    dates.forEach((day, j) => parts.push(
      `<g data-header-person="${xml(person.id)}" data-header-date="${day}">`,
      text(columnX(j), top + 109, weekday(day), 22, j === 6 ? ink : muted, 500, 'text-anchor="middle"'),
      text(columnX(j), top + 143, dateLabel(day), 25, j === 6 ? ink : muted, j === 6 ? 700 : 400, 'text-anchor="middle"'), "</g>"));
    for (const [j, metric] of METRICS.entries()) {
      const color = colors[j]!, row = top + 170 + j * 143;
      // Each metric uses the same 0–10 scale; zero is retained for legacy calm ratings.
      const scoreY = (value: number) => row + 93 - value * 7.3;
      const latestValue = byDate.get(date)?.values[person.id]?.[metric];
      const previous = earlierDays.find(day => byDate.get(day)?.values[person.id]?.[metric] !== undefined);
      parts.push(`<circle cx="73" cy="${row + 28}" r="7" fill="${color}"/>`,
        text(94, row + 38, names[metric], 33, color, 500));
      if (latestValue !== undefined && previous) {
        const delta = latestValue - byDate.get(previous)!.values[person.id]![metric]!;
        const label = `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta)} ${Math.abs(delta) === 1 ? "point" : "points"}`;
        parts.push(`<g data-change-person="${xml(person.id)}" data-change-metric="${metric}" data-from="${previous}" data-to="${date}" data-delta="${delta}">`,
          text(64, row + 76, label, 28, ink, 600),
          text(64, row + 105, `vs ${weekday(previous)} ${shortDate(previous)}${previous.slice(0, 4) !== date.slice(0, 4) ? ` ${previous.slice(0, 4)}` : ""}`, 20, muted), "</g>");
      } else {
        parts.push(text(64, row + 76, latestValue === undefined ? "No rating" : "First rating", 24, muted));
      }
      for (const tick of [0, 5, 10]) {
        parts.push(`<path d="M340 ${scoreY(tick)}H1000" stroke="#48545e" stroke-opacity="${tick === 5 ? 0.3 : 0.55}" stroke-dasharray="3 7"/>`);
        if (tick !== 5) parts.push(text(309, scoreY(tick) + 5, tick, 16, muted, 400, 'text-anchor="end"'));
      }
      // A missing reporting day breaks the line. Saturday is not a reporting day.
      let path = "", connected = false;
      dates.forEach((day, k) => {
        const value = byDate.get(day)?.values[person.id]?.[metric];
        if (value === undefined) { connected = false; return; }
        path += `${connected ? " L" : " M"}${columnX(k)} ${scoreY(value)}`;
        connected = true;
      });
      if (path) parts.push(`<path data-trend-person="${xml(person.id)}" data-trend-metric="${metric}" d="${path.trim()}" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`);
      dates.forEach((day, k) => {
        const x = columnX(k), value = byDate.get(day)?.values[person.id]?.[metric], latest = k === 6;
        parts.push(`<g data-person="${xml(person.id)}" data-metric="${metric}" data-date="${day}" ${value === undefined ? 'data-missing="true"' : `data-score="${value}"`}>`);
        if (value === undefined) {
          parts.push(text(x, scoreY(5) + 7, "—", 24, muted, 400, 'text-anchor="middle"'));
        } else {
          const y = scoreY(value);
          parts.push(`<circle cx="${x}" cy="${y}" r="${latest ? 8 : 6}" fill="${color}" stroke="${latest ? "#2d3a43" : background}" stroke-width="3"/>`,
            text(x, y - 15, value, latest ? 32 : 27, ink, latest ? 700 : 500, `text-anchor="middle" stroke="${latest ? "#2d3a43" : background}" stroke-width="5" paint-order="stroke"`));
        }
        parts.push("</g>");
      });
    }
  }
  parts.push(`<path d="M64 ${height - 104}H1016" stroke="#34404a"/>`,
    text(64, height - 61, "7 check-in days · Saturdays off", 23, muted),
    text(1016, height - 61, "Higher is better", 23, muted, 400, 'text-anchor="end"'),
    text(64, height - 26, "All scores out of 10 · Gaps mean no rating", 22, muted), "</svg>");
  const svg = parts.join(""), png = new Resvg(svg).render().asPng();
  return { date, svg, png, caption: `**Exhale · ${weekday(date, true)}, ${dateLabel(date, true)}**` };
}
