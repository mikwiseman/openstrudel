import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { defaultAppearance, parseAppearance } from "../src/agent-appearance.js";
import { Store } from "../src/store.js";

describe("portable agent characters", () => {
  it("keeps existing identities stable across clients and renames", () => {
    const store = new Store(":memory:");
    try {
      const agent = store.createProfile({ name: "Редактор" });
      store.db.prepare("UPDATE employee_profiles SET appearance_json=NULL WHERE id=?").run(agent.id);
      const before = store.getProfile(agent.id)!.appearance;
      const renamed = store.updateProfile(agent.id, { name: "Редактор книги", instructions: "Пиши просто." });
      expect(renamed.appearance).toEqual(before);
      const code = readFileSync("public/agent-characters.js", "utf8");
      for (const id of [agent.id, "main", "Редактор", "é", "🍊"]) {
        const browser = runInNewContext(code + ";agentAppearance({id})", { TextEncoder, id });
        expect(browser).toEqual(defaultAppearance(id));
      }
    } finally { store.close(); }
  });
  it("saves a chosen appearance without changing instructions and validates before any mutation", () => {
    const store = new Store(":memory:");
    try {
      const agent = store.createProfile({ name: "Учитель", instructions: "Объясняй на примерах." });
      const appearance = { version: 1 as const, kind: "pillow" as const, tone: 7 };
      store.updateProfile(agent.id, { ...agent, appearance });
      expect(store.getProfile(agent.id)).toMatchObject({ appearance, instructions: agent.instructions });
      for (const invalid of [null, [], {}, { ...appearance, tone: -1 }, { ...appearance, tone: 8 }, { ...appearance, tone: 0.5 }, { ...appearance, kind: "../../secret" }, { ...appearance, version: 2 }]) {
        expect(() => store.updateProfile(agent.id, { name: "Не сохранять", instructions: "", appearance: invalid as any })).toThrow();
        expect(store.getProfile(agent.id)).toMatchObject({ name: "Учитель", appearance, instructions: agent.instructions });
      }
      expect(parseAppearance({ ...appearance, url: "https://untrusted.test" })).toEqual(appearance);
    } finally { store.close(); }
  });
});
