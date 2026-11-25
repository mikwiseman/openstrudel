import { describe, expect, it } from "vitest";
import { buildReply, nativeBuildReply, telegramBuildReply } from "../src/project-build-reply.js";
import type { BuildRequest } from "../src/aigid-queue.js";

const testflight = "https://testflight.apple.com/join/tCeZp4pP";
const log = "https://appstoreconnect.apple.com/teams/db1b8a2b-2870-44dc-baf5-bbc2a17db1a3/apps/6791188813/ci/builds/65d8a70b-8ae9-44f8-8143-d076c55a74c8";
const app = "https://testflight.apple.com/v1/app/6791188813";
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
    expect(part!.text).toContain("Xcode Cloud");
    expect(part!.text).toContain("tap Update when it appears");
    expect(reply.actions).toEqual([{text:"Open TestFlight",url:app},{text:"Build details",url:log}]);
    expect(nativeBuildReply(reply)).toContain("[Open TestFlight]("+app+")");
    expect(nativeBuildReply(reply)).not.toContain(testflight);
    const legacy=buildReply(job({detail:"Apple completed the AiGid TestFlight workflow.\n"+testflight}),"Build it")!;
    expect(legacy.actions).toEqual([{text:"Join public beta",url:testflight}]);
  });
  it("displays only a positive recorded Apple build number in success and failure replies", () => {
    const success=job({detail:"Apple completed the AiGid TestFlight workflow.\n"+log});
    const failure=job({state:"failed",detail:"Apple reported a TestFlight workflow failure.\n"+log});
    const success185={...success,apple_build_number:185}, failed182={...failure,apple_build_number:182};
    expect(buildReply(success185,"Build AiGid")!.title).toContain("AiGid build 185");
    expect(buildReply(failed182,"Собери AiGid")!.title).toContain("AiGid №182");
    for (const number of [undefined,null,0,-1,1.5]) {
      const legacy={...success,apple_build_number:number};
      expect(buildReply(legacy,"Build AiGid")!.title).toBe(buildReply(success,"Build AiGid")!.title);
    }
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
    expect(reply.title).toContain("Xcode Cloud");
    expect(reply.body).toMatch(/этап|шаг/);
    expect(reply.body).not.toMatch(/не попала|не загруз|не дошла/);
    expect(reply.actions).toEqual([{text:"Открыть журнал",url:log}]);
    expect(telegramBuildReply(reply)[0]!.text.includes("AI-помощником")).toBe(false);
  });
  it.each([
    ["Project worker: Wolf project runner: The configured ChatGPT subscription is unavailable.", /ChatGPT/, /reconnect/i],
    ["Project worker: Wolf project runner: refresh_token_expired", /ChatGPT/, /sign in again/i],
    ["Project worker: Wolf project runner: The worker did not confirm Standard speed.", /settings/i, /retry/i],
    ["Project worker: Wolf project runner: Command: python3 -m py_compile private-contact.py\nExit code: 1\nDiagnostic: [Errno 2] No such file or directory: 'private-contact.py'", /Python/, /file/i],
    ["Project worker: Wolf project runner: Command: secret-tool --password=private-contact\nExit code: 2", /check/i, /code 2/],
    ["The source change did not complete. There is no changed revision to package.", /source change/i, /package/i],
    ["GitHub Pages reported a deployment failure.", /GitHub Pages/, /deploy/i],
    ["private-contact: unknown provider error", /failed step/i, /run history/i],
  ])("explains a failed project run without copying private log text", (detail, what, next) => {
    const reply=buildReply(job({state:"failed",repository,detail}),"Build the project")!;
    const text=nativeBuildReply(reply);
    expect(text).toMatch(what);
    expect(text).toMatch(next);
    expect(text).not.toMatch(/private-contact|secret-tool|Ask me what failed/i);
  });
  it("never advertises installation from an unconfirmed or spoofed link", () => {
    for (const impostor of ["https://testflight.apple.com.evil.example/join/xxx","https://name@testflight.apple.com/join/foo","https://appstoreconnect.apple.com/teams/fake/apps/123/ci/builds/fake",log+"?token=private"]) {
      const reply=buildReply(job({detail:"Apple completed the AiGid TestFlight workflow.\n"+impostor}),"Ship it")!;
      expect(reply.actions).toEqual([]);
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
