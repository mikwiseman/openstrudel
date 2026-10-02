import type { CodexEngine, EmployeeProfile } from "./types.js";
import type { Store } from "./store.js";

/** A direct address chooses an employee. Ordinary conversation stays put. */
export class AgentRouter {
  constructor(private readonly store: Store, _engine?: CodexEngine) {}
  async route(text: string): Promise<{ profile: EmployeeProfile | null; reason: "explicit" | "main" }> {
    const normalized = text.trim().toLocaleLowerCase();
    const profile = this.store.listProfiles().sort((a, b) => b.name.length - a.name.length).find(p => {
      const name = p.name.toLocaleLowerCase();
      const prefix = "@" + name;
      return normalized === prefix || (normalized.startsWith(prefix) && /[\s,:]/u.test(normalized.slice(prefix.length, prefix.length + 1))) || normalized.startsWith(name + ":");
    });
    return { profile: profile ?? null, reason: profile ? "explicit" : "main" };
  }
}
