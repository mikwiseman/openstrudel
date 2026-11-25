import type { BuildRequest } from "./aigid-queue.js";
import { telegramText } from "./telegram-format.js";
import type { TelegramLinkButton } from "./types.js";

export interface BuildReply { title: string; body?: string; actions: TelegramLinkButton[]; russian: boolean }

function projectName(repository: string | null) {
  const slug = repository?.split("/")[1] ?? "ai-gid";
  const brands: Record<string,string> = {"ai-gid":"AiGid",openramble:"OpenRamble","openramble-site":"OpenRamble",openstrudel:"OpenStrudel",openaccs:"OpenAccs",waiwai:"WaiWai"};
  return brands[slug.toLowerCase()] ?? slug.replace(/[-_]+/g," ").replace(/^./u,c=>c.toUpperCase());
}

function link(value: string): URL | undefined {
  try {
    const result = new URL(value);
    if (result.protocol === "https:" && !result.username && !result.password && !result.port) return result;
  } catch { /* Plain text from the build log. */ }
}

/** Job details keep the original provider receipt. Only named delivery fields become actions. */
export function buildReply(job: BuildRequest, request: string): BuildReply | null {
  if (!["completed", "failed", "dispatched"].includes(job.state)) return null;
  const russian = /[а-яё]/iu.test(request.replace(/(?:__)?(?:Отправлено AI-помощником\.|Sent by an AI assistant\.)(?:__)?\s*$/u,""));
  const t = (en:string,ru:string)=>russian ? ru : en;
  const name = projectName(job.repository);
  const lines = (job.detail ?? "").split("\n");
  const urls = lines.flatMap(line=>link(line.trim()) ?? []);
  const github = (url:URL) => url.origin === "https://github.com" && url.pathname.startsWith("/"+job.repository+"/");
  const apple = urls.find(url=>url.origin==="https://appstoreconnect.apple.com" && /^\/teams\/[a-f\d-]+\/apps\/\d+\/ci\/builds\/[a-f\d-]+$/i.test(url.pathname));
  const action = (text:string,url?:URL):TelegramLinkButton[]=>url ? [{text,url:url.href}] : [];
  const result = (title:string,actions:TelegramLinkButton[]=[],body?:string):BuildReply=>({title,actions,russian,...(body ? {body} : {})});
  if (job.state === "dispatched") {
    return job.repository
      ? result(t(name+" was submitted for deployment.", name+" передан на развёртывание."))
      : result(t("AiGid was submitted to Xcode Cloud.", "AiGid передан на сборку в Xcode Cloud."));
  }
  if (job.state === "failed") {
    const buildLog = apple ?? urls.find(github) ?? lines[0]?.split(/\s+/u).map(link).find(url=>url && github(url));
    return result(job.repository ? t(name+" couldn’t finish this request.",name+" — не удалось выполнить запрос.")
      : t("AiGid didn’t reach TestFlight.","Сборка AiGid не попала в TestFlight."),
      action(t("View build log","Открыть журнал"),buildLog),
      buildLog ? undefined : t("Ask me what failed for the check results.","Спросите, какая проверка не прошла."));
  }
  if (!job.repository) {
    const install = urls.find(url=>url.origin==="https://testflight.apple.com" && /^\/join\/[A-Za-z0-9]+\/?$/.test(url.pathname));
    return install ? result(t("AiGid build complete.","Сборка AiGid готова."),action(t("Open TestFlight","Открыть TestFlight"),install))
      : result(t("Apple finished the AiGid build.","Apple завершила сборку AiGid."),action(t("View build","Открыть сборку"),apple));
  }
  if (job.package_target) {
    const target=job.package_target;
    const platforms=target==="desktop" ? ["Windows","Linux"] : [target==="macos" ? "macOS" : target==="android" ? "Android" : "web"];
    const actions:TelegramLinkButton[]=[];
    // Each artifact receipt contains name, URL, then verified checksum in that order.
    for (const platform of platforms) {
      const index=lines.findIndex((line,i)=>line.includes(" · ") && (target!=="desktop" || line.toLowerCase().includes("-"+platform.toLowerCase()+"-"))
        && /^SHA-256 [a-f0-9]{64}$/.test(lines[i+2] ?? ""));
      const url=index<0 ? undefined : link(lines[index+1] ?? "");
      const cloud=target==="desktop" || target==="macos";
      if (!url || (cloud && !(github(url) && /\/actions\/runs\/\d+\/artifacts\/\d+$/.test(url.pathname)))) continue;
      const label=platform==="Android" ? t("Download APK","Скачать APK") : platform==="web" ? t("Download ZIP","Скачать ZIP") :
        target==="macos" ? t("Download for Mac","Скачать для Mac") : platform;
      actions.push(...action(label,url));
    }
    if (actions.length!==platforms.length) return result(t("The "+name+" build finished.", "Сборка "+name+" завершена."),actions,
      t("I couldn’t verify every download link.","Не удалось подтвердить все ссылки для скачивания."));
    return result(target==="desktop" ? t(name+" installers are ready.","Установщики "+name+" готовы.") :
      t(name+" "+(target==="web" ? "web package" : platforms[0]+" build")+" is ready.","Сборка "+name+" для "+(target==="web" ? "веба" : platforms[0])+" готова."),actions);
  }
  if (job.release_project===2)
    return result(t(name+" changes are merged.","Изменения в "+name+" объединены."),action(t("View change","Открыть изменение"),urls.find(github)));
  if (job.release_project===1) {
    const site=urls.find(url=>!github(url));
    if (site) return result(t(name+" is live.",name+" опубликован."),action(t("Open website","Открыть сайт"),site));
    return result(t(name+" deployment finished.","Развёртывание "+name+" завершено."),action(t("View deployment","Открыть результат"),urls.find(github)));
  }
  const pr=job.pull ? new URL("https://github.com/"+job.repository+"/pull/"+job.pull) : undefined;
  if (job.changes) return result(t(name+" changes are ready for review.","Изменения в "+name+" готовы к проверке."),
    action(t("Review changes","Посмотреть изменения"),pr),job.notes ?? undefined);
  return result("",[],job.notes || job.detail || t("Finished checking "+name+".","Проверка "+name+" завершена."));
}

function markdown(reply: BuildReply) {
  return [reply.title && "**"+reply.title+"**",reply.body].filter(Boolean).join("\n\n");
}
export function nativeBuildReply(reply: BuildReply) {
  const links=reply.actions.map(a=>"["+a.text+"]("+a.url.replaceAll("(", "%28").replaceAll(")", "%29")+")").join(" · ");
  return [markdown(reply),links].filter(Boolean).join("\n\n");
}
export function telegramBuildReply(reply: BuildReply) {
  return telegramText(markdown(reply));
}
