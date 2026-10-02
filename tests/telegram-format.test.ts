import { expect,it } from "vitest";
import { telegramText } from "../src/telegram-format.js";
it("formats links and emphasis with UTF-16 offsets after emoji", () => {
  const result=telegramText("🙂 **News** [OpenAI](https://openai.com)")[0]!;
  expect(result.text).toBe("🙂 News OpenAI");
  expect(result.entities).toContainEqual({type:"bold",offset:3,length:4});
  expect(result.entities).toContainEqual({type:"text_link",offset:8,length:6,url:"https://openai.com"});
});
it("splits formatted text without breaking emoji or entity bounds", () => {
  const chunks=telegramText("**"+"🙂".repeat(5000)+"**");
  expect(chunks.map(c=>c.text).join("")).toBe("🙂".repeat(5000));
  for (const c of chunks) { expect(c.text.length).toBeLessThanOrEqual(4096); expect(c.entities[0]?.length).toBe(c.text.length); }
});
it("keeps one blank line between blocks and preserves code whitespace", () => {
  const [result]=telegramText("**Wai News**\n\n## Today\n\nFirst **fact**.\n\n- One\n- Two\n\n```text\na\n\n\nb\n```\n\n[Source](https://openai.com)");
  expect(result?.text).toBe("Wai News\n\nToday\n\nFirst fact.\n\n• One\n• Two\n\na\n\n\nb\n\nSource");
  const source=result?.entities.find(e=>e.type==="text_link");
  expect(result?.text.slice(source!.offset,source!.offset+source!.length)).toBe("Source");
});
it("renders simple quotes without nesting quote entities", () => {
  const [result]=telegramText("> A **thought**\n>\n> > A reply");
  expect(result?.text).toBe("A thought\n\nA reply");
  expect(result?.entities.filter(e=>e.type==="blockquote")).toEqual([{type:"blockquote",offset:0,length:18}]);
  expect(result?.entities).toContainEqual({type:"bold",offset:2,length:7});
});
it("keeps code and links without forbidden entity nesting", () => {
  const [result]=telegramText("**Run `hello` now**\n\n> [Source](https://openai.com)");
  expect(result?.entities).toContainEqual({type:"code",offset:4,length:5});
  expect(result?.entities.some(e=>e.type==="bold" && e.offset<9 && e.offset+e.length>4)).toBe(false);
  expect(result?.entities.some(e=>e.type==="blockquote")).toBe(false);
  expect(result?.entities.some(e=>e.type==="text_link")).toBe(true);
});

it("renders comparisons as labelled rows with working source links", () => {
  const [result]=telegramText("| Модель | Источник |\n| --- | --- |\n| **Astra** | [OpenAI](https://openai.com) |");
  expect(result?.text).toBe("Модель: Astra\nИсточник: OpenAI");
  const link=result?.entities.find(e=>e.type==="text_link");
  expect(result?.text.slice(link!.offset,link!.offset+link!.length)).toBe("OpenAI");
});

it("keeps nested lists on separate indented lines", () => {
  expect(telegramText("1. Исследование\n   - Источники\n   - Стоимость\n2. Разработка")[0]?.text)
    .toBe("1. Исследование\n  • Источники\n  • Стоимость\n2. Разработка");
});
