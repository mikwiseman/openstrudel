import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { diagnosticReport, recordDiagnostic, saveDiagnosticLevel } from "../src/diagnostics.js";

const stores: Store[] = [];
const roots: string[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function store(file = ":memory:") { const s = new Store(file); stores.push(s); return s; }

it("keeps useful outcomes by default and enables attempt details explicitly", () => {
  const s = store();
  recordDiagnostic(s, "speech.started", { provider: "elevenlabs", bytes: 123 });
  recordDiagnostic(s, "speech.completed", { provider: "elevenlabs", durationMs: 24 });
  expect(diagnosticReport(s)).toMatchObject({ level: "standard", events: [{ event: "speech.completed", provider: "elevenlabs", durationMs: 24 }] });
  saveDiagnosticLevel(s, "detailed");
  recordDiagnostic(s, "speech.started", { provider: "local", bytes: 321 });
  expect(diagnosticReport(s).events[0]).toMatchObject({ event: "speech.started", bytes: 321 });
  expect(() => saveDiagnosticLevel(s, "everything")).toThrow();
  expect(diagnosticReport(s).level).toBe("detailed");
});

it("bounds persistent history and projects metadata so secrets and transcript text cannot enter it", () => {
  const root = mkdtempSync(join(tmpdir(), "diagnostics-")); roots.push(root);
  const file = join(root, "home.sqlite"), s = store(file);
  for (let i = 0; i < 305; i++) recordDiagnostic(s, "speech.failed", { provider: "elevenlabs", status: 429, durationMs: i, reason: "provider_limit", key: "secret", text: "private transcript", url: "https://secret" } as any);
  const reopened = store(file), report = diagnosticReport(reopened);
  expect(report.events).toHaveLength(200);
  expect(report.events[0]).toMatchObject({ event: "speech.failed", durationMs: 304, status: 429, reason: "provider_limit" });
  expect(JSON.stringify(report)).not.toMatch(/secret|private transcript/);
  expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM diagnostic_events").get()?.n).toBe(200);
});

it("keeps a restricted turn's stage, error class and fixed reason, never free text", () => {
  const s = store();
  recordDiagnostic(s, "restricted.failed", { stage: "runtime", errorClass: "Error", reason: "sandbox", durationMs: 12.4 });
  recordDiagnostic(s, "restricted.failed", { stage: "everywhere", errorClass: "Error: bwrap failed for /data/secret", reason: "fs sandbox helper failed", status: 502 } as any);
  const [latest, first] = diagnosticReport(s).events;
  expect(first).toEqual({ id: expect.any(Number), time: expect.any(String), event: "restricted.failed", stage: "runtime", errorClass: "Error", reason: "sandbox", durationMs: 12 });
  expect(latest).toEqual({ id: expect.any(Number), time: expect.any(String), event: "restricted.failed", status: 502 });
});
