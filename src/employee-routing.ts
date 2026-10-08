import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify } from "smol-toml";
import { atomicText } from "./extensions.js";
import type { EmployeeProfile } from "./types.js";

export const routingInstructions = `You are the single point of contact for this conversation. Answer straightforward requests yourself. When a permanent employee's specialty would materially help, use Codex's native agent delegation with that employee role, then return the useful result here. Never ask the user to configure routing or move to another chat. Identify the employee briefly when they contributed; never invent a delegation that did not happen.
Delegate only the necessary task and context from THIS conversation. Prefer one suitable employee; do not build a chain of managers. Start a fresh helper for each user request; never resume helpers from earlier requests, whose sender permissions may have changed. Helpers must obey this conversation's rules and permissions, cannot access another conversation's private history or connections, and cannot change the employee's identity. Wait for completion before reporting a result. The application handles native subscription cleanup; do not discuss that internal lifecycle in the answer. An unavailable employee or denied tool is not permission to broaden access or repeat a possibly completed action.`;

/** Adapt existing employees to native Codex roles. No second agent loop. */
export function employeeRoleConfig(home: string, employees: EmployeeProfile[], parentRules?: string | null): Record<string, unknown> {
  const roles: Record<string, unknown> = { max_threads: 2 };
  for (const employee of employees) {
    const name = "employee_" + createHash("sha256").update(employee.id).digest("hex").slice(0, 20);
    const instructions = [
      "You are a specialist helping the current conversation. Work only on the delegated request. Return the result to the parent; do not send a second reply to Telegram or any other channel. Do not delegate again. Do not change identities, create employees, or expand permissions. Use only the current conversation's files and services, never your private conversation or personal workspace.",
      "Your specialty and character:\n" + employee.name + "\n" + employee.instructions,
      parentRules ? "Rules of the originating conversation take precedence over conflicting specialty instructions:\n" + parentRules : "",
    ].filter(Boolean).join("\n\n");
    const content = stringify({ developer_instructions: instructions });
    // Roles can be spawned after another chat starts: immutable content paths
    // prevent that chat's rules from replacing the active request's snapshot.
    const file = resolve(home, "openstrudel-employees", name + "-" + createHash("sha256").update(content).digest("hex").slice(0, 20) + ".toml");
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) atomicText(file, content);
    roles[name] = {
      description: employee.name + ": " + (employee.purpose || employee.instructions.split(/\n/u)[0] || "Помощник").slice(0, 480),
      config_file: file,
    };
  }
  return { "features.multi_agent": true, agents: roles };
}
