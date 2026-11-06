import { Resvg } from "@resvg/resvg-js";
import { METRICS, type DailyMetrics, type Metric } from "./daily-metrics.js";

const names: Record<Metric, string> = { calm: "Спокойствие", focus: "Фокус", energy: "Энергия", mood: "Настроение" };
const colors = ["#357261", "#5669b0", "#a86d23", "#b15d72"];
const xml = (text: string | number) => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const shift = (date: string, days: number) => new Date(Date.parse(date + "T12:00:00Z") - days * 86400000).toISOString().slice(0, 10);
const dateLabel = (date: string, long = false) => new Intl.DateTimeFormat("ru", { day: "numeric", month: long ? "long" : "numeric", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
const daysWord = (n: number) => n % 100 >= 11 && n % 100 <= 14 ? "дней" : n % 10 === 1 ? "день" : n % 10 >= 2 && n % 10 <= 4 ? "дня" : "дней";
const decimal = (n: number) => n.toFixed(1).replace(".", ",");

/** One deterministic picture of the journal. No thresholds, interpolated gaps or combined score. */
export function dailyMetricsCard(data: DailyMetrics) {
  const date = shift(data.today, 1), yesterday = data.days.find(d => d.date === date);
  const past = data.days.filter(d => d.date < data.today), recent = past.slice(-7);
  const width = 1080, height = 218 + data.participants.length * 390 + 65;
  const text = (x: number, y: number, value: string | number, size = 24, fill = "#263a33", weight = 400, extra = "") =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" ${extra}>${xml(value)}</text>`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, Liberation Sans, sans-serif">`,
    `<rect width="${width}" height="${height}" fill="#f5f3ec"/>`, text(64, 106, "Выдох", 84, "#263a33", 700),
    text(66, 151, "ЧЕТЫРЕ ОЦЕНКИ. ОДИН ВЫДОХ.", 18, "#68776e", 600, 'letter-spacing="2"'),
    text(1016, 88, dateLabel(date, true), 30, "#263a33", 500, 'text-anchor="end"'),
    text(1016, 126, "WAI HQ", 19, "#68776e", 400, 'text-anchor="end" letter-spacing="3"'),
    `<path d="M397 78v28m17-44v52m17-30v20" stroke="#357261" stroke-width="7" stroke-linecap="round" opacity=".7"/>`];
  const captions = [`**Выдох · ${dateLabel(date, true)}**`];
  for (const [i, person] of data.participants.entries()) {
    const y = 218 + i * 390, scores = yesterday?.values[person.id] ?? {};
    let streak = 0;
    while (past.find(d => d.date === shift(date, streak))?.values[person.id]?.calm !== undefined) streak++;
    parts.push(`<path d="M64 ${y - 26}H1016" stroke="#d8ddd4"/>`, text(64, y + 24, person.name, 38, "#263a33", 700),
      text(1016, y + 23, streak ? `${streak}${streak === 29 ? "+" : ""} ${daysWord(streak)} отметок подряд` : "Новая отметка — новое начало", 20, "#68776e", 400, 'text-anchor="end"'));
    for (const [j, metric] of METRICS.entries()) {
      const x = 64 + j * 248, value = scores[metric], color = colors[j]!;
      parts.push(text(x, y + 72, names[metric], 23, color, 500), text(x, y + 143, value ?? "—", 68, value === undefined ? "#9ba49b" : "#263a33", 600),
        value === undefined ? `<g data-missing="true"/>` : text(x + (value === 10 ? 82 : 44), y + 140, "/ 10", 25, "#7a857d"));
      for (let tick = 0; tick < 10; tick++) parts.push(`<rect x="${x + tick * 20}" y="${y + 162}" width="15" height="9" rx="4.5" fill="${value !== undefined && tick < value ? color : "#e1e4dc"}"/>`);
    }
    parts.push(text(64, y + 219, "Спокойствие · 7 дней", 19, "#68776e"));
    const chartTop = y + 246, chartBottom = y + 322, left = 110, right = 984;
    parts.push(text(64, chartTop + 6, "10", 15, "#89938a"), text(73, chartBottom + 5, "0", 15, "#89938a"),
      `<path d="M${left} ${chartTop}H${right}M${left} ${chartBottom}H${right}" stroke="#dce1d7" stroke-dasharray="3 7"/>`);
    let previous: { x: number; y: number; date: string } | undefined;
    recent.forEach((day, j) => {
      const x = left + j * (right - left) / Math.max(1, recent.length - 1), value = day.values[person.id]?.calm;
      parts.push(text(x, y + 358, dateLabel(day.date), 17, "#7a857d", 400, 'text-anchor="middle"'));
      if (value === undefined) { previous = undefined; parts.push(text(x, chartBottom - 4, "—", 18, "#b0b8ad", 400, 'text-anchor="middle" data-missing="true"')); return; }
      const py = chartBottom - value / 10 * (chartBottom - chartTop);
      if (previous && previous.date === shift(day.date, 1)) parts.push(`<path data-trend-segment="true" d="M${previous.x} ${previous.y}L${x} ${py}" stroke="#357261" stroke-width="3" fill="none"/>`);
      parts.push(`<circle data-score="${value}" cx="${x}" cy="${py}" r="5" fill="#357261" stroke="#f5f3ec" stroke-width="2"/>`, text(x, py - 13, value, 19, "#357261", 600, 'text-anchor="middle"'));
      previous = { x, y: py, date: day.date };
    });
    captions.push(`${person.name}: ${METRICS.map(metric => `${names[metric]} ${scores[metric] === undefined ? "—" : scores[metric] + "/10"}`).join(" · ")}`);
    if (new Date(data.today + "T12:00:00Z").getUTCDay() === 1) {
      const average = (days: typeof past, metric: Metric) => {
        const values = days.map(d => d.values[person.id]?.[metric]).filter((v): v is number => v !== undefined);
        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
      };
      captions.push(`Неделя · ${person.name}: ` + METRICS.map(metric => {
        const current = average(recent, metric), before = average(past.slice(-14, -7), metric);
        const delta = current !== undefined && before !== undefined ? Math.round((current - before) * 10) / 10 : undefined;
        return `${names[metric]} ${current === undefined ? "—" : decimal(current)}${delta === undefined ? "" : ` (${delta > 0 ? "+" : ""}${decimal(delta)} п.)`}`;
      }).join(" · "));
      const best = recent.filter(d => d.values[person.id]?.calm !== undefined).sort((a, b) => b.values[person.id]!.calm! - a.values[person.id]!.calm!)[0];
      if (best) captions.push(`Самый спокойный день: ${dateLabel(best.date)} · ${best.values[person.id]!.calm}/10.`);
    }
  }
  parts.push(text(64, height - 30, "Выше — лучше.  — нет ответа", 19, "#7a857d"), text(1016, height - 30, "В своём ритме.", 19, "#357261", 500, 'text-anchor="end"'), "</svg>");
  const svg = parts.join(""), png = new Resvg(svg).render().asPng();
  return { date, svg, png, caption: captions.join("\n\n") + "\n\n_Отправлено AI-помощником._" };
}
