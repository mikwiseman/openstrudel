import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// Run the actual app functions without starting Telegram or making requests.
const app = readFileSync(new URL("../public/check-in/app.js", import.meta.url), "utf8");
const definitions = app.slice(0, app.indexOf('$("check-in-form").addEventListener'));

function fixture() {
  const nodes = new Map<string, any>();
  const node = () => ({ children: [] as any[], attributes: {} as Record<string, string>, textContent: "", style: { setProperty() {} },
    append(...items: any[]) { this.children.push(...items); }, replaceChildren(...items: any[]) { this.children = items; },
    setAttribute(key: string, value: string) { this.attributes[key] = value; } });
  const document = { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, createElementNS: node };
  const api = runInNewContext(definitions + ";({ state, datesForPeriod, calendarStreak, personName, renderChart, METRICS })", { window: {}, document, Intl });
  api.state.person = "42";
  api.state.data = { today: "2026-11-09", viewerId: "42", days: [
    { date: "2026-11-06", values: { "42": { calm: 4 }, "77": { calm: 3 } } },
    { date: "2026-11-07", values: { "42": { calm: 10 }, "77": { calm: 10 } } },
    { date: "2026-11-08", values: { "42": { calm: 0 }, "77": { focus: 7 } } },
  ] };
  return { api, nodes };
}

it("renders English weekdays above chart dates for either participant, excluding Saturday ratings", () => {
  const { api, nodes } = fixture();
  const dates = api.datesForPeriod();
  expect(dates).not.toContain("2026-11-07");
  expect(api.calendarStreak()).toBe(2);
  expect(api.personName({ name: "Мик" })).toBe("Mik");
  expect(api.personName({ name: "Гриша" })).toBe("Grisha");
  for (const person of ["42", "77"]) {
    api.state.person = person;
    api.renderChart(dates, api.METRICS[0]);
    const labels = nodes.get("chart").children.filter((n: any) => n.attributes["text-anchor"] === "middle");
    const sunday = labels.findIndex((n: any) => n.textContent === "Sun");
    expect(labels[sunday + 1].textContent).toBe("08/11");
    expect(+labels[sunday].attributes.y).toBeLessThan(+labels[sunday + 1].attributes.y);
    expect(labels.some((n: any) => n.textContent === "Sat")).toBe(false);
    expect(nodes.get("average").textContent).toBe(person === "42" ? "2" : "3");
  }
  expect(api.calendarStreak()).toBe(0); // A focus-only reply is not a calm mark.
});

it("serves an English shell and useful English access/error messages", () => {
  const html = readFileSync(new URL("../public/check-in/index.html", import.meta.url), "utf8");
  expect(html).toContain('<html lang="en">');
  expect(html).toContain("Exhale · WAI HQ");
  expect(html).not.toMatch(/[А-Яа-яЁё]/);
  expect(app).toContain("Your session expired.");
  expect(app).toContain("Not saved. Your choices are still here; try again.");
});
