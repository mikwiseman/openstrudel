export const characterKinds = ["coil", "fold", "knot", "curl", "wave", "pillow"] as const;
export interface AgentAppearance {
  version: 1;
  kind: typeof characterKinds[number];
  tone: number;
}

/** Stable across clients and renames. Keep this order and the UTF-8 hash portable. */
export function defaultAppearance(id: string): AgentAppearance {
  let hash = 2166136261;
  for (const byte of Buffer.from(id, "utf8")) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return { version: 1, kind: characterKinds[hash % characterKinds.length]!, tone: Math.floor(hash / characterKinds.length) % 8 };
}

export function parseAppearance(value: unknown): AgentAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Выберите образ сотрудника ещё раз.");
  const appearance = value as Record<string, unknown>;
  if (appearance.version !== 1 || !characterKinds.includes(appearance.kind as AgentAppearance["kind"]) || !Number.isInteger(appearance.tone) || Number(appearance.tone) < 0 || Number(appearance.tone) > 7) {
    throw new Error("Этот образ пока не поддерживается. Обновите OpenStrudel или выберите другой.");
  }
  return { version: 1, kind: appearance.kind as AgentAppearance["kind"], tone: Number(appearance.tone) };
}
