import type { Store } from "./store.js";
import { HomeError } from "./home.js";

type Event = "speech.started" | "speech.completed" | "speech.failed" | "telegram.connected" | "telegram.disconnected" | "service.started" | "restricted.failed";
const reasons = ["provider_auth", "provider_limit", "invalid_audio", "provider_unavailable", "network", "timeout", "cancelled", "local_recognition", "empty_audio", "file_too_large",
  "runtime_version", "model_provider", "account_sign_in", "account_limits", "account_unavailable", "service_http", "service_protocol", "credential_echo", "sandbox", "codex"] as const;
export type DiagnosticReason = typeof reasons[number];
/** Where a restricted turn stopped: before the account, at the service catalogue, starting Codex, or in the model turn. */
export type RestrictedStage = "prepare" | "account" | "discovery" | "runtime" | "turn";
type Details = { provider?: "local" | "elevenlabs" | "server"; bytes?: number; durationMs?: number; status?: number; reason?: DiagnosticReason; stage?: RestrictedStage; errorClass?: string };
export type DiagnosticEvent = Details & { id: number; time: string; event: Event };

export function diagnosticLevel(store: Store): "standard" | "detailed" {
  return store.getSetting("diagnostics.level") === "detailed" ? "detailed" : "standard";
}

export function saveDiagnosticLevel(store: Store, level: unknown) {
  if (level !== "standard" && level !== "detailed") throw new HomeError("Выберите обычный или подробный журнал.");
  store.setSetting("diagnostics.level", level);
}

/** Small, persistent operational history. Never accept free text, URLs, headers or payloads. */
export function recordDiagnostic(store: Store, event: Event, details: Details = {}) {
  if (event === "speech.started" && diagnosticLevel(store) !== "detailed") return;
  const safe: Details = {};
  if (details.provider === "local" || details.provider === "elevenlabs" || details.provider === "server") safe.provider = details.provider;
  for (const key of ["bytes", "durationMs", "status"] as const) {
    if (Number.isFinite(details[key]) && details[key]! >= 0) safe[key] = Math.round(details[key]!);
  }
  if ((reasons as readonly string[]).includes(details.reason ?? "")) safe.reason = details.reason;
  if (["prepare", "account", "discovery", "runtime", "turn"].includes(details.stage ?? "")) safe.stage = details.stage;
  // A class name is code, not data; anything else is dropped.
  if (typeof details.errorClass === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(details.errorClass)) safe.errorClass = details.errorClass;
  // Logging must never interrupt recognition or delivery if storage becomes unavailable.
  try {
    store.db.prepare("INSERT INTO diagnostic_events(time,event,details) VALUES(?,?,?)").run(new Date().toISOString(), event, JSON.stringify(safe));
    store.db.exec("DELETE FROM diagnostic_events WHERE id NOT IN (SELECT id FROM diagnostic_events ORDER BY id DESC LIMIT 200)");
  } catch {}
}

export function diagnosticReport(store: Store): { level: "standard" | "detailed"; events: DiagnosticEvent[] } {
  const events = store.db.prepare("SELECT id,time,event,details FROM diagnostic_events ORDER BY id DESC LIMIT 200").all()
    .map(row => ({ id: Number(row.id), time: String(row.time), event: row.event as Event, ...JSON.parse(String(row.details)) }));
  return { level: diagnosticLevel(store), events };
}
