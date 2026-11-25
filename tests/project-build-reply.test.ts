import { describe, expect, it } from "vitest";
import { buildReply, nativeBuildReply, telegramBuildReply } from "../src/project-build-reply.js";
import type { BuildRequest } from "../src/aigid-queue.js";

const testflight = "https://testflight.apple.com/join/tCeZp4pP";
const log = "https://appstoreconnect.apple.com/teams/db1b8a2b-2870-44dc-baf5-bbc2a17db1a3/apps/6791188813/ci/builds/65d8a70b-8ae9-44f8-8143-d076c55a74c8";
const repository = "mikwiseman/openramble";
const revision = "a".repeat(40);
const run = "https://github.com/" + repository + "/actions/runs/314";
const job = (values: Partial<BuildRequest> = {}): BuildRequest => ({
  id:"job", created:"", conversation:"chat", channel:"telegram", actor:"mik", goal:"Make a build",
  changes:0, state:"completed", commit_sha:revision, package_dispatched:0, source_message:null,
  package_target:null, parent_request:null, repository:null, release_project:0, pull:null, notes:null, detail:null,
  ...values,
});

describe("the result people receive in the project chat", () => {
  it("reports the cloud handoff once the release source is published", () => {
    const reply=buildReply(job({state:"dispatched",detail:"Published wolf-testflight/GUID at deadbeef."}),"Собери AiGid")!;
    expect(reply.title).toContain("Xcode Cloud");
    expect(reply.actions).toEqual([]);
    expect(telegramBuildReply(reply)[0]!.text).not.toMatch(/deadbeef|GUID|готова/);
    expect(buildReply(job({state:"preparing"}),"Ship it")).toBeNull();
  });
  it("opens TestFlight in one tap, with a labeled native link", () => {
    const reply=buildReply(job({detail:"Apple completed the AiGid TestFlight workflow.\n"+testflight+"\n"+log}),"Keep the «Слушать» label and build the current branch.\n\n__Отправлено AI-помощником.__")!;
    const [part]=telegramBuildReply(reply);
    expect(part!.text).toBe("AiGid build complete.");
    expect(part!.entities.map(e=>[e.type,part!.text.slice(e.offset,e.offset+e.length)])).toEqual([["bold","AiGid build complete."]]);
    expect(reply.actions).toEqual([{text:"Open TestFlight",url:testflight}]);
    expect(nativeBuildReply(reply)).toContain("[Open TestFlight]("+testflight+")");
    expect(nativeBuildReply(reply)).not.toContain("appstoreconnect");
  });
  it("gives each desktop installer the right button even when the runner returns Linux first", () => {
    const block=(platform:string,id:number)=>"openramble-"+platform+"-"+revision+" · 95.1 MiB\n"+run+"/artifacts/"+id+"\nSHA-256 "+"5".repeat(64);
    const reply=buildReply(job({repository,package_target:"desktop",detail:block("linux",2)+"\n\n"+block("windows",1)+"\nRevision "+revision}),"Build both")!;
    expect(reply.actions).toEqual([{text:"Windows",url:run+"/artifacts/1"},{text:"Linux",url:run+"/artifacts/2"}]);
    expect(telegramBuildReply(reply)[0]!.text).toBe("OpenRamble installers are ready.");
  });
  it.each([
    ["Build the website ZIP.", "Mikwiseman web is ready to download.", "Download ZIP"],
    ["Собери сайт через GitHub Pages.", "Сайт Mikwiseman web готов к скачиванию.", "Скачать ZIP"],
  ])("names the downloadable website once for %s", (request, title, button) => {
    const url="https://example.org/artifacts/site.zip";
    const detail="site.zip · 1 MiB\n"+url+"\nSHA-256 "+"5".repeat(64);
    const reply=buildReply(job({repository:"mikwiseman/mikwiseman-web",package_target:"web",detail}),request)!;
    expect(reply.title).toBe(title);
    expect(reply.actions).toEqual([{text:button,url}]);
  });
  it("keeps an actual project answer and preserves its substantive Markdown", () => {
    const notes="Use **Export** in Settings.\n\nChoose a folder and save.";
    const reply=buildReply(job({repository,notes,detail:notes+"\nCodex … Standard speed\nChecked revision "+revision}),"Where is export?")!;
    expect(nativeBuildReply(reply)).toContain(notes);
    expect(nativeBuildReply(reply)).not.toContain(revision);
    expect(telegramBuildReply(reply)[0]!.entities.some(e=>e.type==="bold")).toBe(true);
  });
  it("keeps a signed failure truthful and opens diagnostics in the language of the request", () => {
    const reply=buildReply(job({state:"failed",detail:"Apple reported a TestFlight workflow failure.\n"+log}),"Собери для нас")!;
    expect(reply.title).toContain("AiGid");
    expect(reply.actions).toEqual([{text:"Открыть журнал",url:log}]);
    expect(telegramBuildReply(reply)[0]!.text.includes("AI-помощником")).toBe(false);
  });
  it("never advertises installation from an unconfirmed or spoofed link", () => {
    for (const impostor of ["https://testflight.apple.com.evil.example/join/xxx","https://name@testflight.apple.com/join/foo",log]) {
      const reply=buildReply(job({detail:"Apple completed the AiGid TestFlight workflow.\n"+impostor}),"Ship it")!;
      expect(reply.actions.every(a=>a.text!=="Open TestFlight")).toBe(true);
      expect(reply.title).not.toMatch(/ready in TestFlight/i);
    }
  });
  it("presents a deployed site with its public link and a source-only merge with its commit", () => {
    const site="https://mikwiseman.github.io/openramble-site/";
    const live=buildReply(job({repository:repository+"-site",release_project:1,detail:"GitHub Pages published the website.\n"+site+"\nRevision "+revision}),"Publish it")!;
    expect(live.title).toBe("OpenRamble is live.");
    expect(live.actions).toEqual([{text:"Open website",url:site}]);
    const commit="https://github.com/"+repository+"/commit/"+revision;
    const source=buildReply(job({repository,release_project:2,detail:"Published the checked change to the default branch.\n"+commit}),"Merge it")!;
    expect(source.actions).toEqual([{text:"View change",url:commit}]);
    expect(source.title).toContain("merged");
  });
});
