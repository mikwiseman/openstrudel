import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

const script = resolve("extensions/legal-library/legal_library.py");
const roots: string[] = [];
function python(code: string, ...args: string[]) {
  return JSON.parse(execFileSync("python3", ["-c", `
import importlib.util,json,pathlib,sys
from unittest.mock import patch
s=importlib.util.spec_from_file_location('library',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
${code}
`, script, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "legal-library-")); roots.push(root);
  const source = join(root, "source"), output = join(root, "library"); mkdirSync(source);
  const config = join(root, "sources.json");
  writeFileSync(config, JSON.stringify({ sources: [{ label: "Contracts", path: source }] }));
  const run = (...args: string[]) => JSON.parse(execFileSync("python3", [script, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
  return { root, source, output, config, run, build: () => run("build", config, output) };
}
describe("legal source library", () => {
  it("keeps source evidence and updates changed and removed documents without presenting stale text as current", () => {
    const f = fixture(), file = join(f.source, "Agreement.md");
    writeFileSync(file, "# Agreement\nAcceptance is due on 2027-01-15. Signed status unknown.");
    expect(f.build().counts.ready).toBe(1);
    const first = f.run("search", f.output, "Acceptance").results[0];
    expect(first.source).toBe("Contracts/Agreement.md");
    const doc = f.run("show", f.output, first.id);
    expect(doc.text).toContain("Signed status unknown");
    const original = readFileSync(join(f.output, doc.original), "utf8");
    expect(original).toContain("2027-01-15");
    writeFileSync(file, "# Agreement\nAcceptance is due on 2027-02-15.");
    f.build();
    expect(f.run("show", f.output, first.id).sha256).not.toBe(doc.sha256);
    expect(f.run("show", f.output, first.id).text).toContain("2027-02-15");
    expect(f.run("show", f.output, first.id).versions.map((v: any) => v.sha256)).toContain(doc.sha256);
    rmSync(file);
    writeFileSync(f.config, JSON.stringify({sources:[{label:"Contracts",path:f.source,allow_empty:true}]}));
    f.build();
    expect(f.run("show", f.output, first.id).status).toBe("missing");
    expect(f.run("show", f.output, first.id).versions).toHaveLength(2);
    expect(f.run("search", f.output, "Acceptance").results).toEqual([]);
    expect(readFileSync(join(f.output, doc.original), "utf8")).toBe(original);
    writeFileSync(file, original); f.build();
    const restored = f.run("show", f.output, first.id);
    expect(restored.sha256).toBe(doc.sha256);
    expect(restored.versions).toHaveLength(2);
    expect(restored.versions.find((v: any) => v.sha256 === doc.sha256).firstObservedAt).toBe(doc.versions[0].firstObservedAt);
    expect(restored.history.map((v: any) => v.status)).toEqual(["ready", "ready", "missing", "ready"]);
    expect(f.run("search", f.output, "Acceptance").results[0].id).toBe(first.id);
  });
  it("reports unreadable sources and excludes credential files, signatures, locks and linked outside files", () => {
    const f = fixture();
    writeFileSync(join(f.source, "Broken.docx"), "not an Office archive");
    writeFileSync(join(f.source, ".env"), "SECRET=private");
    writeFileSync(join(f.source, "auth.json"), '{"token":"private"}');
    writeFileSync(join(f.source, "~$Agreement.docx"), "private");
    writeFileSync(join(f.source, "sign.png"), "private");
    writeFileSync(join(f.source, "Подпись_Алисы_оригинал.pdf"), "private signature asset");
    mkdirSync(join(f.source, "_проверка"));
    writeFileSync(join(f.source, "_проверка", "Скан.pdf"), "private signing input");
    writeFileSync(join(f.source, "Original.md"), "Clause 3: acceptance requires a signed act.");
    execFileSync("ln", ["-s", join(f.source, "Original.md"), join(f.source, "Linked.md")]);
    const report = f.build();
    expect(report.counts.ready).toBe(1);
    expect(report.counts.error).toBe(1);
    const inventory = f.run("status", f.output);
    expect(inventory.issues.map((d: any) => d.source)).toEqual(["Contracts/Broken.docx"]);
    expect(f.run("search", f.output, 'acceptance OR "').results[0].source).toBe("Contracts/Original.md");
  });
  it("refuses a missing source root without replacing the last valid index", () => {
    const f = fixture(); writeFileSync(join(f.source, "Current.md"), "Current agreement evidence");
    f.build(); const before = readFileSync(join(f.output, "library.sqlite"));
    rmSync(f.source, { recursive: true });
    expect(() => f.build()).toThrow();
    expect(readFileSync(join(f.output, "library.sqlite"))).toEqual(before);
  });
  it("preserves the whole snapshot and employee files when one mount is absent or unexpectedly empty", () => {
    const f = fixture(), second = join(f.root, "second"); mkdirSync(second);
    writeFileSync(join(f.source, "Current.md"), "Current agreement evidence");
    writeFileSync(join(second, "Receipt.md"), "Actual delivery receipt evidence");
    writeFileSync(f.config, JSON.stringify({ sources: [{ label: "Contracts", path: f.source }, { label: "Receipts", path: second }] }));
    f.build();
    const employeeFiles = ["START.md", "AiGid.md", "obligations.json", "reminders.json"];
    for (const name of employeeFiles) writeFileSync(join(f.output, name), "Employee-owned state: hold, delivery receipt and correction");
    const preserved = ["library.sqlite", "manifest.json", ...employeeFiles].map(name => [name, readFileSync(join(f.output, name))] as const);
    rmSync(join(second, "Receipt.md"));
    expect(() => f.build()).toThrow(/Previously populated source is empty/);
    rmSync(second, { recursive: true });
    expect(() => f.build()).toThrow(/Source root unavailable/);
    for (const [name, bytes] of preserved) expect(readFileSync(join(f.output, name))).toEqual(bytes);
  });
  it("refuses a partial traversal or unreadable source without marking previous files removed", () => {
    const f = fixture(); writeFileSync(join(f.source, "Current.md"), "Current agreement evidence"); f.build();
    const before = readFileSync(join(f.output, "library.sqlite"));
    expect(() => python(`
def interrupted_walk(*args, **kwargs):
 kwargs['onerror'](PermissionError('unmounted child'))
 return iter([])
with patch.object(m.os,'walk',side_effect=interrupted_walk):
 print(json.dumps(m.build(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))))
`, f.config, f.output)).toThrow(/Source traversal failed/);
    expect(() => python(`
with patch.object(m,'read_source',side_effect=PermissionError('inaccessible source')):
 print(json.dumps(m.build(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))))
`, f.config, f.output)).toThrow(/PermissionError/);
    expect(readFileSync(join(f.output, "library.sqlite"))).toEqual(before);
    expect(f.run("search", f.output, "agreement").results).toHaveLength(1);
  });
  it("aborts on a missing extractor instead of replacing valid extraction with hundreds of errors", () => {
    const f = fixture(); writeFileSync(join(f.source, "Current.md"), "Current agreement evidence"); f.build();
    const before = readFileSync(join(f.output, "library.sqlite"));
    writeFileSync(join(f.source, "New.pdf"), "New file requiring the PDF extractor");
    expect(() => python(`
with patch.dict(sys.modules, {'fitz':None}):
 print(json.dumps(m.build(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))))
`, f.config, f.output)).toThrow(/requires PyMuPDF/);
    expect(readFileSync(join(f.output, "library.sqlite"))).toEqual(before);
  });
  it("refuses a changed source scope and ambiguous labels rather than inferring deletion", () => {
    const f = fixture(); writeFileSync(join(f.source, "Current.md"), "Current agreement evidence"); f.build();
    const before = readFileSync(join(f.output, "library.sqlite"));
    for (const sources of [
      [{label:"Different",path:f.source}],
      [{label:"Contracts",path:f.source,legal_only:true}],
      [{label:"Contracts",path:f.source},{label:"Contracts/Child",path:f.source}],
    ]) {
      writeFileSync(f.config, JSON.stringify({sources}));
      expect(() => f.build()).toThrow();
      expect(readFileSync(join(f.output, "library.sqlite"))).toEqual(before);
    }
  });
  it("maps a source to a new mount without changing document identity or losing its original provenance", () => {
    const f = fixture(); writeFileSync(join(f.source, "Agreement.md"), "Current agreement evidence");
    writeFileSync(f.config, JSON.stringify({sources:[{label:"Contracts",path:f.source,uri:"https://drive.example/authorized-folder"}]}));
    f.build(); const first = f.run("show", f.output, "Contracts/Agreement.md");
    const moved = join(f.root, "mapped"); renameSync(f.source, moved);
    writeFileSync(f.config, JSON.stringify({sources:[{label:"Contracts",path:moved,uri:"https://drive.example/authorized-folder"}]}));
    f.build(); const latest = f.run("show", f.output, first.id);
    expect(latest.sha256).toBe(first.sha256);
    expect(latest.versions).toEqual(first.versions);
    expect(latest.provenance).toMatchObject({root:realpathSync(moved),relativePath:"Agreement.md",sourceUri:"https://drive.example/authorized-folder"});
    expect(latest.history).toHaveLength(2);
    expect(latest.history[0].provenance.root).toBe(first.provenance.root);
  });
  it("detects a corrupted preserved original and leaves the index and evidence history intact", () => {
    const f = fixture(); writeFileSync(join(f.source, "Agreement.md"), "Original agreement evidence"); f.build();
    const doc = f.run("show", f.output, "Contracts/Agreement.md"), before = readFileSync(join(f.output, "library.sqlite"));
    writeFileSync(join(f.output, doc.original), "corrupted original");
    expect(() => f.build()).toThrow(/checksum verification/);
    expect(readFileSync(join(f.output, "library.sqlite"))).toEqual(before);
    expect(readFileSync(join(f.output, doc.original), "utf8")).toBe("corrupted original");
  });
  it("preserves employee state during a successful refresh and serializes competing builds", () => {
    const f = fixture(); writeFileSync(join(f.source, "Agreement.md"), "Original agreement evidence"); f.build();
    const files = ["START.md", "AiGid.md", "obligations.json", "reminders.json"];
    for (const name of files) writeFileSync(join(f.output, name), "Preserve held matters and actual delivery history");
    writeFileSync(join(f.source, "Agreement.md"), "Revised agreement evidence"); f.build();
    for (const name of files) expect(readFileSync(join(f.output, name), "utf8")).toBe("Preserve held matters and actual delivery history");
    const before = readFileSync(join(f.output, "library.sqlite"));
    expect(() => python(`
with (pathlib.Path(sys.argv[3])/'.build.lock').open('a') as lock:
 m.fcntl.flock(lock,m.fcntl.LOCK_EX|m.fcntl.LOCK_NB)
 print(json.dumps(m.build(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))))
`, f.config, f.output)).toThrow(/Another library build is running/);
    expect(readFileSync(join(f.output, "library.sqlite"))).toEqual(before);
  });
  it("extracts ODT mixed text and DOCX redlines without reviving deleted clauses", () => {
    const f = fixture();
    python(`
import zipfile
root=pathlib.Path(sys.argv[2])
with zipfile.ZipFile(root/'Agreement.odt','w') as z:
 z.writestr('content.xml','<root><p>Payment <span>after acceptance</span> only.</p></root>')
with zipfile.ZipFile(root/'Redlines.docx','w') as z:
 z.writestr('word/document.xml','<document><p><r><t>Current: </t></r><ins><r><t>signed act</t></r></ins><del><r><delText>automatic acceptance</delText></r></del><moveFrom><r><t>old obligation</t></r></moveFrom><r><tab/><t>required.</t></r></p></document>')
print('{}')
`, f.source);
    f.build();
    expect(f.run("show", f.output, "Contracts/Agreement.odt").text).toContain("Payment after acceptance only.");
    const text = f.run("show", f.output, "Contracts/Redlines.docx").text;
    expect(text).toContain("Current: signed act\trequired.");
    expect(text).not.toMatch(/automatic acceptance|old obligation/);
    python(`
import sqlite3
with sqlite3.connect(pathlib.Path(sys.argv[2])/'library.sqlite') as db:
 db.execute("DELETE FROM metadata WHERE key='extractionRevisions'")
 db.execute("UPDATE documents SET text='Legacy extractor lost mixed paragraph text' WHERE source LIKE '%.odt'")
print('{}')
`, f.output);
    f.build();
    expect(f.run("show", f.output, "Contracts/Agreement.odt").text).toContain("Payment after acceptance only.");
  });
  it("keeps legacy Unicode identities when the same source is scanned on another filesystem", () => {
    const f = fixture(); writeFileSync(join(f.source, "Résumé.md"), "Original agreement evidence"); f.build();
    const legacy = python(`
import sqlite3,unicodedata,hashlib
source=unicodedata.normalize('NFD','Contracts/Résumé.md');identity=hashlib.sha256(source.encode()).hexdigest()[:20]
with sqlite3.connect(pathlib.Path(sys.argv[2])/'library.sqlite') as db:
 db.execute('UPDATE documents SET id=?,source=?',(identity,source))
 db.execute('UPDATE versions SET source=?',(source,))
 db.execute('UPDATE history SET source=?',(source,))
 db.execute('UPDATE search SET id=?,source=?',(identity,source))
print(json.dumps({'id':identity,'source':source}))
`, f.output);
    f.build();
    const doc = f.run("show", f.output, "Contracts/Résumé.md");
    expect(doc.id).toBe(legacy.id);
    expect(doc.source).toBe(legacy.source);
    expect(doc.versions).toHaveLength(1);
    expect(f.run("status", f.output).counts).toEqual({ready:1});
  });
  it("upgrades an existing library without discarding historical hashes or rewriting source evidence", () => {
    const f = fixture(); writeFileSync(join(f.source, "Agreement.md"), "Original agreement evidence"); f.build();
    const first = f.run("show", f.output, "Contracts/Agreement.md");
    python(`
import sqlite3
with sqlite3.connect(pathlib.Path(sys.argv[2])/'library.sqlite') as db:
 db.execute('DROP TABLE history')
 db.execute('ALTER TABLE documents DROP COLUMN provenance')
 db.execute('ALTER TABLE versions DROP COLUMN provenance')
 db.execute("DELETE FROM metadata WHERE key='sources'")
print('{}')
`, f.output);
    writeFileSync(join(f.source, "Agreement.md"), "Revised agreement evidence"); f.build();
    const upgraded = f.run("show", f.output, first.id);
    expect(upgraded.versions).toHaveLength(2);
    expect(upgraded.versions.find((v:any) => v.sha256 === first.sha256).firstObservedAt).toBe(first.versions[0].firstObservedAt);
    expect(readFileSync(join(f.output, first.original), "utf8")).toBe("Original agreement evidence");
  });
  it("retains an unchanged extraction warning without repeatedly OCRing the same source", () => {
    const f = fixture(); writeFileSync(join(f.source, "Blank.md"), "");
    expect(f.build().counts.needs_review).toBe(1);
    const result = JSON.parse(execFileSync("python3", ["-c", `
import importlib.util,json,pathlib,sys
from unittest.mock import patch
s=importlib.util.spec_from_file_location('library',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with patch.object(m,'extract',side_effect=AssertionError('unchanged file must reuse extraction')):
 print(json.dumps(m.build(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]))))
`, script, f.config, f.output], {encoding:"utf8"}));
    expect(result.counts).toEqual({needs_review:1});
  });
  it("keeps unresolved and held obligations out of calculated deadline alerts", () => {
    const f = fixture(); mkdirSync(f.output);
    writeFileSync(join(f.output, "obligations.json"), JSON.stringify([
      { id: "fixed", title: "File act", state: "open", dueOn: "2026-11-09", evidence: "Contract clause 3", source: "original.pdf" },
      { id: "relative", title: "Payment after acceptance", state: "awaiting_trigger", dueOn: null, evidence: "Clause 4", source: "original.pdf" },
      { id: "held", title: "Held payment", state: "on_hold", dueOn: "2026-11-01", evidence: "Owner hold", source: "chat" },
      { id: "done", title: "Completed", state: "completed", dueOn: "2026-11-01", evidence: "Receipt", source: "receipt.pdf" },
    ]));
    const report = f.run("due", f.output, "--on", "2026-11-02");
    expect(report.due.map((d: any) => d.id)).toEqual(["fixed"]);
    expect(report.due[0].daysRemaining).toBe(7);
    expect(report.unresolved.map((d: any) => d.id)).toEqual(["relative"]);
    expect(report.held.map((d: any) => d.id)).toEqual(["held"]);
    writeFileSync(join(f.output, "obligations.json"), JSON.stringify([{id:"bad", title:"No source", state:"open", dueOn:"2026-11-03"}]));
    expect(() => f.run("due", f.output, "--on", "2026-11-02")).toThrow();
  });
});
